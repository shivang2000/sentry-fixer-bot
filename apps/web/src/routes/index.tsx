import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { InlineLoginSession, type LoginProvider } from "@/components/inline-login-session";
import { Stepper } from "@/components/stepper";
import { trpc } from "@/utils/trpc";

const searchSchema = z.object({
  force: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export const Route = createFileRoute("/")({
  validateSearch: searchSchema,
  component: HomeWizard,
});

function actionLabelFor(stepId: string): string {
  if (stepId === "mcp") return "Open Doctor";
  return "Paste keys";
}

function shellLabelFor(stepId: string): string {
  if (stepId === "sentry") return "Paste in shell";
  if (stepId === "mcp") return "Probe MCPs";
  return "Open shell";
}

// Every step gets an inline-shell path:
//   claude  → `claude setup-token` (OAuth URL + paste-back code)
//   github  → `gh auth login --web` (device code + browser flow)
//   sentry  → interactive bun script (token + slug paste + Sentry API
//             validation + env-file write)
//   mcp     → `claude mcp list` (read-only probe so operator sees the
//             same line the wizard parsed)
const SHELL_PROVIDERS: Record<string, LoginProvider> = {
  claude: "claude",
  github: "github",
  sentry: "sentry",
  mcp: "mcp",
};

function HomeWizard() {
  const qc = useQueryClient();
  const { force } = useSearch({ from: "/" });
  const forced = force !== undefined && force !== false && force !== "" && force !== "0";
  const navigate = useNavigate();
  const status = useQuery(trpc.setup.status.queryOptions());
  const [expandedShellId, setExpandedShellId] = useState<string | null>(null);

  const steps = status.data?.steps ?? [];
  const ready = status.data?.ready ?? false;
  const current = steps.find((s) => !s.done);

  useEffect(() => {
    if (ready && !forced) navigate({ to: "/chat" });
  }, [ready, forced, navigate]);

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
        </>
      )}
    </div>
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
