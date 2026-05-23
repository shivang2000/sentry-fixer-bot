import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import { Input } from "@alertforge/ui/components/input";
import { Label } from "@alertforge/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, KeyRound, LogIn, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { InlineLoginSession } from "@/components/inline-login-session";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

type SettingsKey =
  | "ANTHROPIC_API_KEY"
  | "GITHUB_APP_ID"
  | "GITHUB_APP_INSTALLATION_ID"
  | "GITHUB_APP_PRIVATE_KEY_PATH"
  | "SENTRY_WEBHOOK_SECRET"
  | "SENTRY_API_TOKEN"
  | "SENTRY_ORG_SLUG";

const GROUPS: Array<{
  title: string;
  description: string;
  fields: Array<{
    key: SettingsKey;
    label: string;
    placeholder?: string;
    type?: "text" | "password";
  }>;
}> = [
  {
    title: "Anthropic",
    description:
      "API key the bot uses to call Claude. Required unless you log in to Claude via OAuth below.",
    fields: [
      {
        key: "ANTHROPIC_API_KEY",
        label: "ANTHROPIC_API_KEY",
        type: "password",
        placeholder: "sk-ant-…",
      },
    ],
  },
  {
    title: "GitHub App",
    description:
      "Used to open PRs. Skip and click 'Log in to GitHub' below for personal-repo OAuth instead.",
    fields: [
      { key: "GITHUB_APP_ID", label: "App ID" },
      { key: "GITHUB_APP_INSTALLATION_ID", label: "Installation ID" },
      {
        key: "GITHUB_APP_PRIVATE_KEY_PATH",
        label: "Private key path",
        placeholder: "/etc/alertforge/gh-app.pem",
      },
    ],
  },
  {
    title: "Sentry",
    description: "Required to verify webhooks + post triage comments.",
    fields: [
      { key: "SENTRY_WEBHOOK_SECRET", label: "Webhook secret", type: "password" },
      { key: "SENTRY_API_TOKEN", label: "API token", type: "password" },
      { key: "SENTRY_ORG_SLUG", label: "Org slug", placeholder: "acme-corp" },
    ],
  },
];

function SettingsPage() {
  const qc = useQueryClient();
  const status = useQuery(trpc.settings.status.queryOptions());
  const setSecret = useMutation(
    trpc.settings.setSecret.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.settings.status.queryKey() });
        toast.success("Saved");
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header>
        <h1 className="font-semibold text-xl">Settings</h1>
        <p className="text-sm text-zinc-500">
          Pasted values are written to /etc/alertforge/env, or apps/server/.env.local in dev, and
          picked up by the next subprocess spawn.
        </p>
      </header>

      <CloudLogins />

      <InvitesCard />

      {GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle className="text-base">{group.title}</CardTitle>
            <CardDescription>{group.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {group.fields.map((f) => (
              <SecretField
                key={f.key}
                fieldKey={f.key}
                label={f.label}
                placeholder={f.placeholder}
                type={f.type}
                configured={status.data?.[f.key] ?? false}
                onSave={(v) => setSecret.mutate({ key: f.key, value: v })}
                pending={setSecret.isPending && setSecret.variables?.key === f.key}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SecretField({
  fieldKey,
  label,
  placeholder,
  type,
  configured,
  onSave,
  pending,
}: {
  fieldKey: string;
  label: string;
  placeholder?: string;
  type?: "text" | "password";
  configured: boolean;
  onSave: (value: string) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor={fieldKey} className="flex items-center gap-2">
          <span className="font-mono text-xs">{label}</span>
          {configured ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">
              <Check className="h-3 w-3" /> configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-md bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-zinc-400">
              <X className="h-3 w-3" /> unset
            </span>
          )}
        </Label>
        <Input
          id={fieldKey}
          type={type ?? "text"}
          placeholder={placeholder ?? (configured ? "•••••• (paste to replace)" : "")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
      </div>
      <Button
        disabled={!value || pending}
        onClick={() => {
          onSave(value);
          setValue("");
        }}
      >
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// ---- Cloud logins (OAuth via PTY) ------------------------------------------

function CloudLogins() {
  const [active, setActive] = useState<"claude" | "github" | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" /> Cloud logins
        </CardTitle>
        <CardDescription>
          Sign in to Claude or GitHub through the bot. Credentials persist in the container under
          /home/alertforge-runner so subsequent runs reuse them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => setActive(active === "claude" ? null : "claude")}
          >
            <LogIn className="mr-1.5 h-4 w-4" />
            {active === "claude" ? "Cancel Claude login" : "Log in to Claude"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setActive(active === "github" ? null : "github")}
          >
            <LogIn className="mr-1.5 h-4 w-4" />
            {active === "github" ? "Cancel GitHub login" : "Log in to GitHub"}
          </Button>
        </div>
        {active ? (
          <InlineLoginSession key={active} provider={active} onCancel={() => setActive(null)} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Admin-only invites surface. Replaces the "ssh in and run psql" path.
 *
 * The signup gate in packages/auth/src/index.ts allows the first real
 * user (excluding the synthetic `local-board` bootstrap account) to
 * sign up unconditionally and become `instance_admin`. After that,
 * every additional account requires a row in `invites` with a matching
 * email. This panel is how the admin creates those rows.
 */
function InvitesCard() {
  const qc = useQueryClient();
  const list = useQuery(trpc.invites.list.queryOptions());
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "instance_admin">("member");

  const create = useMutation(
    trpc.invites.create.mutationOptions({
      onSuccess: () => {
        toast.success(`Invite sent for ${email}`);
        setEmail("");
        setRole("member");
        qc.invalidateQueries({ queryKey: trpc.invites.list.queryKey() });
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const revoke = useMutation(
    trpc.invites.revoke.mutationOptions({
      onSuccess: () => {
        toast.success("Invite revoked");
        qc.invalidateQueries({ queryKey: trpc.invites.list.queryKey() });
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const rows = list.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="h-4 w-4" /> Invites
        </CardTitle>
        <CardDescription>
          Sign-up is open for the first real user (who auto-becomes admin). After that, every new
          account needs a matching invite row. Add invites here instead of running <code>psql</code>
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Label htmlFor="invite-email" className="text-xs">
              Email
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="teammate@your-company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="invite-role" className="text-xs">
              Role
            </Label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as "member" | "instance_admin")}
              className="mt-1 h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm"
            >
              <option value="member">member</option>
              <option value="instance_admin">instance_admin</option>
            </select>
          </div>
          <Button
            disabled={!email.trim() || create.isPending}
            onClick={() => create.mutate({ email: email.trim().toLowerCase(), role })}
          >
            {create.isPending ? "Adding…" : "Add invite"}
          </Button>
        </div>

        {list.isLoading ? (
          <p className="text-sm text-zinc-500">Loading invites…</p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-xs text-zinc-500">
            No invites yet. Add one above to onboard a teammate.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-500">
                <th className="py-1.5">Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-zinc-800 border-t">
                  <td className="py-1.5 font-mono">{r.email}</td>
                  <td>{r.role}</td>
                  <td>
                    {r.consumedAt ? (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
                        accepted
                      </span>
                    ) : (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                        pending
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-zinc-500">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="text-right">
                    {r.consumedAt ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={revoke.isPending && revoke.variables?.id === r.id}
                        onClick={() => revoke.mutate({ id: r.id })}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
