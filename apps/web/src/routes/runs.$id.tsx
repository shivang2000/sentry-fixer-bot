import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/runs/$id")({
  component: RunDetail,
});

type LogRow = {
  id: string;
  seq: number;
  level: string;
  source: string;
  message: string;
  createdAt: string;
};

const levelColor: Record<string, string> = {
  info: "text-zinc-200",
  warn: "text-amber-300",
  error: "text-red-300",
  debug: "text-zinc-500",
};

function RunDetail() {
  const { id } = Route.useParams();
  const run = useQuery(trpc.runs.get.queryOptions({ id }));
  const isTerminal = run.data?.run ? !["running", "pending"].includes(run.data.run.status) : false;

  // Live tail: keep accumulating rows; poll every 2s while the run is
  // active, then once after it terminates to flush the trailing chunk.
  const [logs, setLogs] = useState<LogRow[]>([]);
  const lastSeqRef = useRef(0);
  const tail = useQuery({
    ...trpc.runs.logs.queryOptions({ runId: id, afterSeq: 0 }),
    refetchInterval: isTerminal ? false : 2_000,
  });

  useEffect(() => {
    if (!tail.data) return;
    const fresh = tail.data.filter((r: LogRow) => r.seq > lastSeqRef.current);
    if (fresh.length === 0) return;
    lastSeqRef.current = fresh[fresh.length - 1]!.seq;
    setLogs((prev) => [...prev, ...fresh]);
  }, [tail.data]);

  const r = run.data?.run;
  const alert = run.data?.alert;
  const pr = run.data?.pr;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <Link
          to="/runs"
          className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
        >
          <ArrowLeft className="h-4 w-4" /> Back to runs
        </Link>
        {pr ? (
          <a
            className="text-blue-400 text-sm underline"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
          >
            PR #{pr.number} {pr.isDraft ? "(draft)" : ""}
          </a>
        ) : null}
      </header>

      {!r ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{alert?.title ?? "(no title)"}</CardTitle>
            <CardDescription>
              {alert?.sentryProject} • {r.severity ?? "—"} • status:{" "}
              <span className="font-mono">{r.status}</span>
              {r.repo ? (
                <>
                  {" "}
                  • repo: <code>{r.repo}</code>
                </>
              ) : null}
            </CardDescription>
          </CardHeader>
          {r.triageSummary ? (
            <CardContent className="space-y-2 text-sm">
              <div className="text-xs text-zinc-400 uppercase">Triage summary</div>
              <div>{r.triageSummary}</div>
              {r.agentSummary ? (
                <>
                  <div className="text-xs text-zinc-400 uppercase">Agent summary</div>
                  <pre className="whitespace-pre-wrap text-zinc-200">{r.agentSummary}</pre>
                </>
              ) : null}
            </CardContent>
          ) : null}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live log</CardTitle>
          <CardDescription>
            Streamed from triage + agent workers.{" "}
            {isTerminal ? "Run finished." : "Polling every 2s…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-3 font-mono text-xs">
            {logs.length === 0 ? (
              <span className="text-zinc-500">no log lines yet…</span>
            ) : (
              logs.map((l) => (
                <div key={l.id} className={levelColor[l.level] ?? "text-zinc-300"}>
                  <span className="text-zinc-500">
                    [{new Date(l.createdAt).toLocaleTimeString()}]
                  </span>{" "}
                  <span className="text-zinc-400">[{l.source}]</span> {l.message}
                </div>
              ))
            )}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
