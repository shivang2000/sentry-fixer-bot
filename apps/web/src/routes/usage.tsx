import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Activity, RefreshCw } from "lucide-react";

import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/usage")({
  component: UsagePage,
});

function UsagePage() {
  const qc = useQueryClient();
  // Poll every 60s. claude's `/usage` doesn't update faster than that
  // anyway (rate-limit windows are minute-granular), and the three
  // sub-commands cost ~1-3s combined per refresh — cheap but not free.
  const q = useQuery({
    ...trpc.system.claudeUsage.queryOptions(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: trpc.system.claudeUsage.queryKey() });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 font-semibold text-2xl">
            <Activity className="h-5 w-5" /> Usage
          </h1>
          <p className="text-sm text-zinc-500">
            Live snapshot of <code className="rounded bg-zinc-800 px-1">/usage</code>,{" "}
            <code className="rounded bg-zinc-800 px-1">/extra-usage</code>, and{" "}
            <code className="rounded bg-zinc-800 px-1">/context</code> from the claude CLI.
            Refreshes every 60s.
          </p>
          {q.data?.checkedAt ? (
            <p className="mt-1 text-[11px] text-zinc-500">
              Last checked: {new Date(q.data.checkedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={q.isFetching}>
          <RefreshCw className={`mr-1.5 h-3 w-3 ${q.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </header>

      {q.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : q.error ? (
        <p className="text-red-300 text-sm">{q.error.message}</p>
      ) : !q.data ? (
        <p className="text-sm text-zinc-500">No data.</p>
      ) : (
        <>
          <UsageCard
            title="/usage"
            description="Subscription / account state. Empty / one-line responses are normal — claude only prints a single status string in --print mode."
            body={q.data.usage}
          />
          <UsageCard
            title="/extra-usage"
            description="Whether the org has extra usage credits beyond the base quota."
            body={q.data.extraUsage}
          />
          <UsageCard
            title="/context"
            description="Per-session token budget for the most recent invocation. Useful to confirm the prompt isn't blowing the context window."
            body={q.data.context}
          />
        </>
      )}
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
