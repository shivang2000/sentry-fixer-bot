import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@alertforge/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Play } from "lucide-react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

type Preset = "never" | "15m" | "30m" | "1h" | "4h" | "1d";
type CronName = "sentry-poll" | "health-check";

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: "never", label: "Never (disabled)" },
  { value: "15m", label: "Every 15 minutes" },
  { value: "30m", label: "Every 30 minutes" },
  { value: "1h", label: "Every hour" },
  { value: "4h", label: "Every 4 hours" },
  { value: "1d", label: "Every day" },
];

const LOOKBACKS: Array<{ value: number; label: string }> = [
  { value: 15, label: "Last 15 minutes" },
  { value: 30, label: "Last 30 minutes" },
  { value: 60, label: "Last hour" },
  { value: 240, label: "Last 4 hours" },
  { value: 1440, label: "Last day" },
];

type Props = {
  name: CronName;
  compact?: boolean;
};

export function CronCard({ name, compact }: Props) {
  const qc = useQueryClient();
  const list = useQuery(trpc.cron.list.queryOptions());
  const setSchedule = useMutation(
    trpc.cron.setSchedule.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.cron.list.queryKey() });
        toast.success("Schedule updated");
      },
      onError: (err) => toast.error(err.message),
    }),
  );
  const runNow = useMutation(
    trpc.cron.runNow.mutationOptions({
      onSuccess: () => toast.success("Queued one immediate run"),
      onError: (err) => toast.error(err.message),
    }),
  );

  const row = (list.data ?? []).find((r) => r.name === name);
  const preset: Preset = row?.preset ?? "never";
  const lookback = row?.lookbackMinutes ?? 15;
  const isSentryPoll = name === "sentry-poll";

  const title = isSentryPoll ? "Sentry poll cron" : "Health-check cron";
  const description = isSentryPoll
    ? "Periodically pulls Sentry issues from the last <window> and enqueues triage. Use this when you can't or don't want to wire a webhook."
    : "Periodically re-probes claude / gh / sentry / MCP status into the dashboard snapshot. Catches expired tokens + evicted MCP servers.";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" /> {title}
        </CardTitle>
        {!compact ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={isSentryPoll && !compact ? "grid grid-cols-2 gap-3" : "space-y-3"}>
          <div className="space-y-1.5">
            <span className="text-xs text-zinc-500">Interval</span>
            <Select
              value={preset}
              onValueChange={(v) => {
                if (!v) return;
                setSchedule.mutate({
                  name,
                  preset: v as Preset,
                  lookbackMinutes: isSentryPoll ? lookback : undefined,
                });
              }}
              disabled={compact}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {isSentryPoll && !compact ? (
            <div className="space-y-1.5">
              <span className="text-xs text-zinc-500">Lookback window</span>
              <Select
                value={String(lookback)}
                onValueChange={(v) => {
                  if (!v) return;
                  setSchedule.mutate({
                    name,
                    preset,
                    lookbackMinutes: Number(v),
                  });
                }}
                disabled={preset === "never"}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOKBACKS.map((l) => (
                    <SelectItem key={l.value} value={String(l.value)}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        {!compact ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-zinc-500">
              {preset === "never"
                ? "Cron is OFF"
                : `Cron: ${row?.cron ?? "—"}${isSentryPoll ? ` • lookback ${lookback}m` : ""}`}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={runNow.isPending}
              onClick={() => runNow.mutate({ name })}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Run now
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
