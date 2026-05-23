import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, RefreshCw, Stethoscope, X } from "lucide-react";

import { CronCard } from "@/components/cron-card";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/doctor")({
  component: DoctorPage,
});

function DoctorPage() {
  const qc = useQueryClient();
  const status = useQuery(trpc.setup.status.queryOptions());
  const raw = useQuery(trpc.setup.claudeMcpListRaw.queryOptions());

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-semibold text-xl">
            <Stethoscope className="h-5 w-5" /> Doctor
          </h1>
          <p className="text-sm text-zinc-500">
            Live probes of every external dependency. Use this when something on the dashboard goes
            red.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            qc.invalidateQueries({ queryKey: trpc.setup.status.queryKey() });
            qc.invalidateQueries({ queryKey: trpc.setup.claudeMcpListRaw.queryKey() });
          }}
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Re-run probes
        </Button>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Status</CardTitle>
          <CardDescription>
            Checked at{" "}
            {status.data?.checkedAt ? new Date(status.data.checkedAt).toLocaleTimeString() : "—"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {(status.data?.steps ?? []).map((s) => (
            <div
              key={s.id}
              className={
                s.done
                  ? "rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3"
                  : "rounded-md border border-red-500/30 bg-red-500/5 p-3"
              }
            >
              <div className="mb-1 flex items-center gap-1.5 text-sm">
                {s.done ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <X className="h-4 w-4 text-red-400" />
                )}
                <span className="font-medium">{s.label}</span>
              </div>
              <div className="text-xs text-zinc-400">{s.detail}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CronCard name="sentry-poll" />
        <CronCard name="health-check" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">claude mcp list</CardTitle>
          <CardDescription>
            Raw output. If an MCP is missing here but listed under <code>/mcps</code>, run{" "}
            <code>claude mcp list</code> in a chat session for a fuller error.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-72 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-3 font-mono text-xs text-zinc-200">
            {raw.data?.raw?.trim() || "(empty)"}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
