import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sentry-fixer-bot/ui/components/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { AddChannelDialog } from "@/components/triggers/add-channel-dialog";
import { ChannelCard } from "@/components/triggers/channel-card";
import { ManualUrlTrigger } from "@/components/triggers/manual-url-trigger";
import type { PresetValue } from "@/components/triggers/preset-selector";
import { TriggerForm } from "@/components/triggers/trigger-form";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/triggers/$id")({
  component: EditTriggerPage,
});

function EditTriggerPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const q = useQuery(trpc.triggers.byId.queryOptions({ id }));

  if (q.isLoading) return <div className="p-6">Loading…</div>;
  if (q.error) return <div className="p-6 text-red-300">{q.error.message}</div>;
  if (!q.data?.trigger) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-500">Trigger not found.</p>
        <Link to="/triggers">
          <Button variant="outline" className="mt-4">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            Back to triggers
          </Button>
        </Link>
      </div>
    );
  }

  const { trigger, repo, channels } = q.data;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link to="/triggers">
            <Button variant="ghost" size="icon" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="font-semibold text-2xl">{trigger.name}</h1>
            <p className="text-sm text-zinc-500">
              <span className="font-mono text-xs uppercase">{trigger.sourceType}</span> ·{" "}
              <span className="font-mono">{trigger.sourceProject}</span> ·{" "}
              <span className="font-mono">{repo?.github ?? "—"}</span>
            </p>
          </div>
        </div>
        <span className="text-[11px] text-zinc-500">
          {trigger.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      <Tabs defaultValue="pipeline">
        <TabsList>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="channels">
            Channels{channels.length > 0 ? ` (${channels.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="budget">Budget</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="mt-4 space-y-6">
          <TriggerForm
            mode="edit"
            initial={{
              id: trigger.id,
              repoId: trigger.repoId,
              sourceType: trigger.sourceType,
              sourceProject: trigger.sourceProject,
              name: trigger.name,
              preset: trigger.preset as PresetValue,
              config: (trigger.config as Record<string, unknown>) ?? {},
            }}
            onCancel={() => navigate({ to: "/triggers" })}
            onSuccess={() => undefined}
          />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Trigger fix from URL</CardTitle>
              <CardDescription>
                Same flow as the /triggers index, scoped to verify this trigger picks up an alert
                end-to-end. Future PR will pin the URL detect to this trigger's sourceType.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ManualUrlTrigger compact />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="channels" className="mt-4">
          <ChannelsTab
            triggerId={trigger.id}
            channels={channels.map((c) => ({
              id: c.id,
              channelType: c.channelType,
              enabled: c.enabled,
              notifyOn: c.notifyOn,
              config: (c.config ?? {}) as Record<string, unknown>,
              lastSendAt: c.lastSendAt,
              lastSendOk: c.lastSendOk,
              lastSendErr: c.lastSendErr,
            }))}
          />
        </TabsContent>

        <TabsContent value="budget" className="mt-4">
          <BudgetTab repoGithub={repo?.github ?? ""} triggerId={trigger.id} />
        </TabsContent>

        <TabsContent value="audit" className="mt-4">
          <AuditTab triggerId={trigger.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ChannelsTab({
  triggerId,
  channels,
}: {
  triggerId: string;
  channels: Array<{
    id: string;
    channelType: string;
    enabled: boolean;
    notifyOn: string[];
    config: Record<string, unknown>;
    lastSendAt: string | Date | null;
    lastSendOk: boolean | null;
    lastSendErr: string | null;
  }>;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; type: string } | null>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: trpc.triggers.byId.queryKey({ id: triggerId }) });

  const update = useMutation(trpc.channels.update.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(trpc.channels.delete.mutationOptions({ onSuccess: invalidate }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Channels</h2>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add channel
        </Button>
      </div>
      {channels.length === 0 ? (
        <p className="rounded-md border border-zinc-800 border-dashed p-8 text-center text-sm text-zinc-500">
          No channels configured. Add one to get notified when this trigger fires.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {channels.map((c) => (
            <ChannelCard
              key={c.id}
              row={c}
              onToggleEnabled={(id, next) => update.mutate({ id, enabled: next })}
              onDelete={(id, type) => setDeleteTarget({ id, type })}
            />
          ))}
        </div>
      )}

      <AddChannelDialog triggerId={triggerId} open={open} onOpenChange={setOpen} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Remove ${deleteTarget?.type ?? ""} channel?`}
        description="This stops future notifications for this trigger from going to that channel."
        confirmLabel="Remove"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await del.mutateAsync({ id: deleteTarget.id });
          toast.success("Channel removed");
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function BudgetTab({ triggerId, repoGithub }: { triggerId: string; repoGithub: string }) {
  // V1: surface a read-only summary of today's spend pulled from the
  // by-trigger rollup. The day-level cap lives on the trigger config
  // (edited via the Pipeline tab) — that's the intentional separation
  // so editing budget doesn't risk corrupting model picks.
  const q = useQuery(trpc.runs.usageByTrigger.queryOptions({ window: "24h" }));
  const row = (q.data ?? []).find((r) => r.triggerId === triggerId);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today's spend</CardTitle>
          <CardDescription>
            Rolling 24h window for runs attributed to this trigger. Edit the cap in the Pipeline
            tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {q.isLoading ? (
            <p className="text-zinc-500">Loading…</p>
          ) : !row ? (
            <p className="text-zinc-500">No runs in the last 24 hours.</p>
          ) : (
            <dl className="grid grid-cols-2 gap-3">
              <Kv k="Runs" v={String(row.runCount)} />
              <Kv k="PRs opened" v={String(row.prCount)} />
              <Kv k="Tokens in" v={row.totalTokensInput.toLocaleString()} />
              <Kv k="Tokens out" v={row.totalTokensOutput.toLocaleString()} />
              <Kv k="Spend (24h)" v={`$${(row.totalCostCents / 100).toFixed(2)}`} />
              <Kv
                k="Daily cap (repo)"
                v={`$${(row.dailyCostCapCents / 100).toFixed(2)}`}
                hint={`set per repo — ${repoGithub || "—"}`}
              />
            </dl>
          )}
        </CardContent>
      </Card>
      <p className="text-[11px] text-zinc-500">
        Per-trigger caps land in P8 — until then the repo-level cap on <code>repos_config</code> is
        the hard ceiling.
      </p>
    </div>
  );
}

function Kv({ k, v, hint }: { k: string; v: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-zinc-500">{k}</dt>
      <dd className="font-mono text-sm">{v}</dd>
      {hint ? <p className="text-[10px] text-zinc-500">{hint}</p> : null}
    </div>
  );
}

function AuditTab({ triggerId }: { triggerId: string }) {
  // Today's `runs.list` returns the most recent N runs across all
  // triggers. P6 doesn't add a triggerId filter to keep scope tight;
  // instead we filter client-side and link out to /runs for the full
  // history. Once P8 lands the filter, swap this to a scoped query.
  const list = useQuery(trpc.runs.list.queryOptions({ limit: 50 }));
  const rows = (list.data ?? []).filter((r) => {
    // Older runs (pre-P4) don't carry a triggerId, so they're hidden
    // here by design — the trigger audit is only meaningful for runs
    // attributed to this trigger.
    type RunWithTrigger = { triggerId?: string | null };
    const runT = r.run as unknown as RunWithTrigger;
    return runT.triggerId === triggerId;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Recent runs</h2>
        <Link to="/runs">
          <Button variant="outline" size="sm">
            All runs
          </Button>
        </Link>
      </div>
      {list.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-zinc-800 border-dashed p-8 text-center text-sm text-zinc-500">
          No runs attributed to this trigger yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-zinc-500">
              <th className="py-2">Started</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Alert</th>
              <th>PR</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ run, alert, pr }) => (
              <tr key={run.id} className="border-zinc-800 border-t">
                <td className="py-2">
                  <Link to="/runs/$id" params={{ id: run.id }}>
                    {new Date(run.startedAt).toLocaleString()}
                  </Link>
                </td>
                <td className="font-mono">{run.status}</td>
                <td>{run.severity ?? "—"}</td>
                <td className="max-w-md truncate">{alert.title}</td>
                <td>
                  {pr ? (
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-400 underline"
                    >
                      #{pr.number}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
