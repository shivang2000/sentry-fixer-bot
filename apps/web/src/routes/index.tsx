import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Terminal,
  Webhook,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { InlineLoginSession, type LoginProvider } from "@/components/inline-login-session";
import { Stepper } from "@/components/stepper";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/")({
  component: HomeWizard,
});

function actionLabelFor(_stepId: string): string {
  return "Paste keys";
}

function shellLabelFor(stepId: string): string {
  if (stepId === "sentry") return "Run sentry login";
  return "Open shell";
}

// Every step gets an inline-shell path:
//   claude  → `claude auth login` (OAuth URL + paste-back code)
//   github  → `gh auth login --web` (device code + browser flow)
//   sentry  → `sentry auth login` via cli.sentry.dev (device code)
const SHELL_PROVIDERS: Record<string, LoginProvider> = {
  claude: "claude",
  github: "github",
  sentry: "sentry",
};

function HomeWizard() {
  const qc = useQueryClient();
  const [expandedShellId, setExpandedShellId] = useState<string | null>(null);
  // Poll setup.status every 3 seconds while a shell is open. WS exit
  // messages are the primary signal but a CLI that writes its creds
  // and then sits in a final "press any key" prompt won't emit exit
  // until the operator dismisses it — polling catches the underlying
  // file write so the step pill flips immediately.
  const status = useQuery({
    ...trpc.setup.status.queryOptions(),
    refetchInterval: expandedShellId ? 3_000 : false,
    refetchOnWindowFocus: true,
  });

  const steps = status.data?.steps ?? [];
  const current = steps.find((s) => !s.done);

  // No auto-redirect. The wizard is the explicit Home — clicking it
  // from the sidebar should always show the steps + status, even when
  // everything is green. Operators wanted a place to see "all set"
  // and re-check pills; auto-jumping to /chat hid that.

  // When a step the operator is currently shelling for flips done
  // (via polling OR via the WS exit handler), auto-collapse the shell
  // and surface a success toast. Without this the operator stares at a
  // dead terminal and isn't sure the login took.
  useEffect(() => {
    if (!expandedShellId) return;
    const step = steps.find((s) => s.id === expandedShellId);
    if (step?.done) {
      toast.success(`${step.label} — done`);
      setExpandedShellId(null);
    }
  }, [steps, expandedShellId]);

  // Force a fresh probe whenever a shell collapses. The 3s polling
  // catches the file write, but pulling immediately on completion
  // closes the visible "didn't update" gap.
  useEffect(() => {
    if (expandedShellId === null) {
      qc.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
    }
  }, [expandedShellId, qc]);

  const refetchStatus = () => qc.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="font-semibold text-xl">Welcome to sentry-fixer-bot</h1>
        <p className="text-sm text-zinc-500">
          Four-step setup. Each step persists on the state volume so a container restart won't lose
          anything.
        </p>
      </header>

      {status.isLoading ? (
        <p className="text-sm text-zinc-500">Checking setup…</p>
      ) : steps.length === 0 ? (
        <p className="text-red-300 text-sm">Couldn't run setup probes. Check server logs.</p>
      ) : (
        <>
          <Card>
            <CardContent className="pt-6">
              <Stepper
                steps={steps.map((s) => ({ id: s.id, label: s.label, done: s.done }))}
                currentId={current?.id}
              />
            </CardContent>
          </Card>

          {!current ? (
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-emerald-200">
                  <Check className="h-4 w-4" /> Setup complete
                </CardTitle>
                <CardDescription className="text-emerald-200/70">
                  All four checks are green. Redirecting to /chat…
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Link to="/chat">
                  <Button>
                    Open chat
                    <ArrowRight className="ml-1.5 h-4 w-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">All steps</CardTitle>
              <CardDescription>
                Two paths per step: paste keys via Settings, or run the login command inline.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {steps.map((s) => (
                <StepRow
                  key={s.id}
                  step={s}
                  number={steps.findIndex((x) => x.id === s.id) + 1}
                  expanded={expandedShellId === s.id}
                  onToggleShell={() => setExpandedShellId(expandedShellId === s.id ? null : s.id)}
                  onComplete={() => {
                    setExpandedShellId(null);
                    refetchStatus();
                  }}
                  isCurrent={current?.id === s.id}
                />
              ))}
            </CardContent>
          </Card>

          <GithubWebhookCard />
          <SentryWebhookCard />
        </>
      )}
    </div>
  );
}

type WebhookCardProps = {
  title: string;
  description: React.ReactNode;
  url: string;
  configured: boolean;
  secretKey: "GITHUB_WEBHOOK_SECRET" | "SENTRY_WEBHOOK_SECRET";
  invalidateKey: readonly unknown[];
  help: React.ReactNode;
};

/**
 * Shared shell for webhook setup cards. Renders the URL field, the
 * secret paste+generate flow, and a per-provider instructions block.
 * Both the GitHub and Sentry cards are thin wrappers around this — keeps
 * the security-sensitive bits (clipboard, crypto.getRandomValues, write-
 * only secret API) in exactly one place.
 */
function WebhookCard({
  title,
  description,
  url,
  configured,
  secretKey,
  invalidateKey,
  help,
}: WebhookCardProps) {
  const qc = useQueryClient();
  const [secret, setSecret] = useState("");
  const save = useMutation(
    trpc.settings.setSecret.mutationOptions({
      onSuccess: () => {
        toast.success(`${title} secret saved`);
        setSecret("");
        qc.invalidateQueries({ queryKey: invalidateKey });
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  // 256-bit hex (64 chars) — big enough that HMAC collision probability
  // is irrelevant, short enough to fit on one line of the provider's UI
  // without wrapping. Generated in the browser so the value never has to
  // round-trip back from the server for display.
  const generate = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    setSecret(hex);
  };

  const copy = (s: string, label: string) => {
    navigator.clipboard.writeText(s).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Clipboard blocked — copy manually"),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="h-4 w-4" /> {title}
          <span
            className={
              configured
                ? "ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300"
                : "ml-2 rounded-full bg-zinc-700/40 px-2 py-0.5 text-[10px] text-zinc-400"
            }
          >
            {configured ? "configured" : "optional"}
          </span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs">Webhook URL</Label>
          <div className="mt-1 flex gap-2">
            <Input value={url} readOnly className="font-mono text-xs" />
            <Button variant="outline" size="sm" onClick={() => copy(url, "URL")} disabled={!url}>
              <Copy className="mr-1 h-3 w-3" />
              Copy
            </Button>
          </div>
        </div>

        <div>
          <Label className="text-xs">Webhook secret</Label>
          <div className="mt-1 flex gap-2">
            <Input
              type="text"
              placeholder={
                configured
                  ? "Already saved — paste a new one to rotate"
                  : "Paste or generate a secret"
              }
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={generate}>
              <KeyRound className="mr-1 h-3 w-3" />
              Generate
            </Button>
            <Button
              size="sm"
              disabled={!secret.trim() || save.isPending}
              onClick={() => save.mutate({ key: secretKey, value: secret.trim() })}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          {secret ? (
            <p className="mt-1 text-[11px] text-amber-400">
              Copy this secret now — after Save it will never be shown again. Paste the same value
              into the provider's webhook config.
            </p>
          ) : null}
        </div>

        <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-3 text-[11px] text-zinc-400">
          {help}
        </div>
      </CardContent>
    </Card>
  );
}

function GithubWebhookCard() {
  const info = useQuery(trpc.setup.githubWebhookInfo.queryOptions());
  return (
    <WebhookCard
      title="GitHub PR webhook"
      description={
        <>
          Optional. Lets reviewers say <code className="rounded bg-zinc-800 px-1">/sfb apply</code>{" "}
          on a PR comment and have the bot apply changes within seconds. Without it, a 15-minute
          cron polls comments as a fallback.
        </>
      }
      url={info.data?.url ?? ""}
      configured={info.data?.configured ?? false}
      secretKey="GITHUB_WEBHOOK_SECRET"
      invalidateKey={trpc.setup.githubWebhookInfo.queryKey()}
      help={
        <>
          <div className="mb-1 font-medium text-zinc-300">Configure on GitHub</div>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              GitHub →{" "}
              <span className="text-zinc-300">Settings → Developer settings → GitHub Apps</span> →
              your app.
            </li>
            <li>
              Set <span className="text-zinc-300">Webhook URL</span> to the URL above.
            </li>
            <li>
              Set <span className="text-zinc-300">Webhook secret</span> to the secret above.
            </li>
            <li>
              Set <span className="text-zinc-300">Content type</span> to{" "}
              <code className="rounded bg-zinc-800 px-1">application/json</code>.
            </li>
            <li>
              Under <span className="text-zinc-300">Permissions & events</span> → Subscribe to{" "}
              <code className="rounded bg-zinc-800 px-1">Issue comment</code>.
            </li>
            <li>Save. GitHub will fire a ping; check server logs for "x-github-event: ping".</li>
          </ol>
        </>
      }
    />
  );
}

function SentryWebhookCard() {
  const info = useQuery(trpc.setup.sentryWebhookInfo.queryOptions());
  return (
    <WebhookCard
      title="Sentry alert webhook"
      description={
        <>
          Optional. Lets new Sentry issues trigger the agent in real time instead of waiting for the
          15-minute Sentry poll. Recommended for production so first-occurrence alerts get a draft
          PR within ~3 minutes.
        </>
      }
      url={info.data?.url ?? ""}
      configured={info.data?.configured ?? false}
      secretKey="SENTRY_WEBHOOK_SECRET"
      invalidateKey={trpc.setup.sentryWebhookInfo.queryKey()}
      help={
        <>
          <div className="mb-1 font-medium text-zinc-300">Configure on Sentry</div>
          <ol className="ml-4 list-decimal space-y-1">
            <li>
              Sentry →{" "}
              <span className="text-zinc-300">
                Settings → Developer Settings → Internal Integrations
              </span>{" "}
              → New Integration.
            </li>
            <li>
              Set <span className="text-zinc-300">Webhook URL</span> to the URL above.
            </li>
            <li>
              Set <span className="text-zinc-300">Verify SSL</span> on for production. Leave a
              friendly Name + Author.
            </li>
            <li>
              Under <span className="text-zinc-300">Permissions</span> grant{" "}
              <code className="rounded bg-zinc-800 px-1">Issue & Event: Read</code>.
            </li>
            <li>
              Under <span className="text-zinc-300">Webhooks</span> subscribe to{" "}
              <code className="rounded bg-zinc-800 px-1">issue</code>.
            </li>
            <li>
              Save the integration. Sentry generates a <em>Client Secret</em> — paste it into the
              secret field above (replace anything Generate created) and Save.
            </li>
          </ol>
        </>
      }
    />
  );
}

type StepRowProps = {
  step: { id: string; label: string; done: boolean; detail: string; actionHref?: string };
  number: number;
  expanded: boolean;
  onToggleShell: () => void;
  onComplete: () => void;
  isCurrent: boolean;
};

function StepRow({ step, number, expanded, onToggleShell, onComplete, isCurrent }: StepRowProps) {
  const provider = SHELL_PROVIDERS[step.id];
  return (
    <div
      className={
        isCurrent
          ? "rounded-md border border-indigo-500/40 bg-indigo-500/5 p-3"
          : "rounded-md border border-zinc-800 p-3"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {step.done ? (
            <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
              <Check className="h-3 w-3" />
            </span>
          ) : (
            <span className="mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-500">
              {number}
            </span>
          )}
          <div>
            <div className="font-medium text-sm">{step.label}</div>
            <div className="text-xs text-zinc-500">{step.detail}</div>
            {step.id === "sentry" && !step.done ? (
              <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 text-[11px] text-zinc-400">
                Sentry has no CLI OAuth — paste an API token from{" "}
                <a
                  className="text-indigo-400 hover:underline"
                  href="https://sentry.io/settings/account/api/auth-tokens/"
                  target="_blank"
                  rel="noreferrer"
                >
                  sentry.io → API tokens
                </a>{" "}
                via Settings. Verify with{" "}
                <code className="rounded bg-zinc-800 px-1 py-0.5">
                  curl -H "Authorization: Bearer $SENTRY_API_TOKEN"
                  https://sentry.io/api/0/organizations/$SENTRY_ORG_SLUG/
                </code>{" "}
                in a chat session.
              </div>
            ) : null}
          </div>
        </div>
        {step.done ? (
          step.actionHref ? (
            <Link to={step.actionHref}>
              <Button variant="ghost" size="sm">
                Manage
              </Button>
            </Link>
          ) : null
        ) : (
          <div className="flex flex-shrink-0 gap-1.5">
            {step.actionHref ? (
              <Link to={step.actionHref}>
                <Button variant="outline" size="sm">
                  {actionLabelFor(step.id)}
                  <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </Link>
            ) : null}
            {provider ? (
              <Button variant="secondary" size="sm" onClick={onToggleShell}>
                <Terminal className="mr-1 h-3.5 w-3.5" />
                {shellLabelFor(step.id)}
                {expanded ? (
                  <ChevronDown className="ml-1 h-3 w-3" />
                ) : (
                  <ChevronRight className="ml-1 h-3 w-3" />
                )}
              </Button>
            ) : null}
          </div>
        )}
      </div>
      {expanded && provider ? (
        <div className="mt-3">
          <InlineLoginSession
            provider={provider}
            onComplete={onComplete}
            onCancel={onToggleShell}
            rows={12}
          />
        </div>
      ) : null}
    </div>
  );
}
