import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sentry-fixer-bot/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sentry-fixer-bot/ui/components/tabs";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { useState } from "react";

import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/usage")({
  component: UsagePage,
});

type WindowChoice = "24h" | "7d";

function UsagePage() {
  const qc = useQueryClient();
  const cli = useQuery({
    ...trpc.system.claudeUsage.queryOptions(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const [tab, setTab] = useState<"cli" | "by-trigger" | "by-step">("by-trigger");
  const [window, setWindow] = useState<WindowChoice>("24h");

  const byTrigger = useQuery(trpc.runs.usageByTrigger.queryOptions({ window }));
  const byStep = useQuery(trpc.runs.usageByStep.queryOptions({ window }));

  const refresh = () => {
    qc.invalidateQueries({ queryKey: trpc.system.claudeUsage.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.runs.usageByTrigger.queryKey() });
    qc.invalidateQueries({ queryKey: trpc.runs.usageByStep.queryKey() });
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-semibold text-2xl">
            <Activity className="h-5 w-5" /> Usage
          </h1>
          <p className="text-sm text-zinc-500">
            Per-trigger and per-step cost breakdowns plus the live claude CLI account state.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <WindowToggle value={window} onChange={setWindow} />
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="mr-1.5 h-3 w-3" />
            Refresh
          </Button>
        </div>
      </header>

      <CostGuardBanner rows={byTrigger.data ?? []} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="by-trigger">By trigger</TabsTrigger>
          <TabsTrigger value="by-step">By step</TabsTrigger>
          <TabsTrigger value="cli">CLI snapshot</TabsTrigger>
        </TabsList>

        <TabsContent value="by-trigger" className="mt-4">
          {byTrigger.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : byTrigger.error ? (
            <p className="text-red-300 text-sm">{byTrigger.error.message}</p>
          ) : (byTrigger.data ?? []).length === 0 ? (
            <p className="rounded-md border border-zinc-800 border-dashed p-8 text-center text-sm text-zinc-500">
              No triggers configured. Configure one on{" "}
              <Link to="/triggers" className="underline">
                /triggers
              </Link>{" "}
              to see the rollup.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Preset</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">PRs</TableHead>
                  <TableHead className="text-right">Tokens (in/out)</TableHead>
                  <TableHead className="text-right">Cost ({window})</TableHead>
                  <TableHead className="text-right">Cap (daily)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(byTrigger.data ?? []).map((r) => {
                  const overCap = r.totalCostCents > r.dailyCostCapCents;
                  return (
                    <TableRow key={r.triggerId}>
                      <TableCell>
                        <Link to="/triggers/$id" params={{ id: r.triggerId }} className="underline">
                          {r.triggerName}
                        </Link>
                        <div className="text-[10px] text-zinc-500">{r.repoGithub}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.preset}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.sourceType}/{r.sourceProject}
                      </TableCell>
                      <TableCell className="text-right">{r.runCount}</TableCell>
                      <TableCell className="text-right">{r.prCount}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {r.totalTokensInput.toLocaleString()} /{" "}
                        {r.totalTokensOutput.toLocaleString()}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono ${overCap ? "text-red-300" : ""}`}
                      >
                        ${(r.totalCostCents / 100).toFixed(2)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        ${(r.dailyCostCapCents / 100).toFixed(2)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="by-step" className="mt-4">
          {byStep.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : byStep.error ? (
            <p className="text-red-300 text-sm">{byStep.error.message}</p>
          ) : (byStep.data ?? []).length === 0 ? (
            <p className="rounded-md border border-zinc-800 border-dashed p-8 text-center text-sm text-zinc-500">
              No step-level cost data yet. Step rollups populate from <code>steps_completed</code>{" "}
              on the runs table; older runs don't carry that array.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Step</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  <TableHead className="text-right">Tokens (in/out)</TableHead>
                  <TableHead className="text-right">Cost ({window})</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(byStep.data ?? []).map((r) => (
                  <TableRow key={r.step_name}>
                    <TableCell className="font-mono text-xs">{r.step_name}</TableCell>
                    <TableCell className="text-right">{r.run_count}</TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {r.total_tokens_input.toLocaleString()} /{" "}
                      {r.total_tokens_output.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      ${(r.total_cost_cents / 100).toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">
            Cost is apportioned evenly across the steps each run completed — accurate accounting
            lands in P8.
          </p>
        </TabsContent>

        <TabsContent value="cli" className="mt-4 space-y-4">
          {cli.data?.checkedAt ? (
            <p className="text-[11px] text-zinc-500">
              Last checked: {new Date(cli.data.checkedAt).toLocaleString()}
            </p>
          ) : null}
          {cli.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : cli.error ? (
            <p className="text-red-300 text-sm">{cli.error.message}</p>
          ) : !cli.data ? (
            <p className="text-sm text-zinc-500">No data.</p>
          ) : (
            <>
              <UsageCard
                title="/usage"
                description="Subscription / account state. Empty / one-line responses are normal — claude only prints a single status string in --print mode."
                body={cli.data.usage}
              />
              <UsageCard
                title="/extra-usage"
                description="Whether the org has extra usage credits beyond the base quota."
                body={cli.data.extraUsage}
              />
              <UsageCard
                title="/context"
                description="Per-session token budget for the most recent invocation."
                body={cli.data.context}
              />
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WindowToggle({
  value,
  onChange,
}: {
  value: WindowChoice;
  onChange: (next: WindowChoice) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-zinc-800">
      {(["24h", "7d"] as const).map((w) => (
        <button
          key={w}
          type="button"
          className={`px-2 py-1 text-xs ${
            value === w ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
          onClick={() => onChange(w)}
        >
          {w}
        </button>
      ))}
    </div>
  );
}

type TriggerCostRow = {
  triggerId: string;
  triggerName: string;
  preset: string;
  totalCostCents: number;
  dailyCostCapCents: number;
};

function CostGuardBanner({ rows }: { rows: TriggerCostRow[] }) {
  // Banner fires when an `auto_fix_review` trigger has already burned
  // through >70% of its repo cap in the current window — projection
  // shows it will exceed the cap before the day ends. We surface a
  // one-click downgrade link to the trigger edit page.
  const offenders = rows.filter((r) => {
    if (r.preset !== "auto_fix_review") return false;
    if (r.dailyCostCapCents <= 0) return false;
    const projected = r.totalCostCents * 1.5;
    return projected > r.dailyCostCapCents && r.totalCostCents > r.dailyCostCapCents * 0.7;
  });

  if (offenders.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
      <div className="flex-1 text-sm">
        <p className="font-medium text-amber-200">Cost guard: projected over cap</p>
        <p className="mt-0.5 text-amber-100/80 text-xs">
          {offenders.length} trigger
          {offenders.length === 1 ? "" : "s"} on <code>auto_fix_review</code> already burned{" "}
          {">70%"} of the daily cap. Downgrade to <code>auto_fix</code> to cut review-pass cost.
        </p>
        <ul className="mt-2 space-y-1 text-xs">
          {offenders.map((r) => (
            <li key={r.triggerId}>
              <Link
                to="/triggers/$id"
                params={{ id: r.triggerId }}
                className="text-amber-100 underline"
              >
                {r.triggerName}
              </Link>{" "}
              · ${(r.totalCostCents / 100).toFixed(2)} of ${(r.dailyCostCapCents / 100).toFixed(2)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function UsageCard({
  title,
  description,
  body,
}: {
  title: string;
  description: string;
  body: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-200">
          {body || "(no output)"}
        </pre>
      </CardContent>
    </Card>
  );
}
