import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { Check, X } from "lucide-react";

import { CronCard } from "@/components/cron-card";
import { authClient } from "@/lib/auth-client";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (!session.data) {
      redirect({ to: "/login", throw: true });
    }
    return { session };
  },
});

type SetupStatusPayload = {
  steps: Array<{ id: string; label: string; done: boolean; detail: string }>;
  checkedAt: string;
  ready: boolean;
};

function relTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function DashboardPage() {
  const snapshot = useQuery(trpc.setup.snapshot.queryOptions());
  const repos = useQuery(trpc.repos.list.queryOptions());

  const payload = (snapshot.data?.payload ?? null) as SetupStatusPayload | null;
  const ready = snapshot.data?.ready ?? false;
  const steps = payload?.steps ?? [];
  const checkedAt = snapshot.data?.checkedAt ?? null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="font-semibold text-xl">Dashboard</h1>
        <p className="text-sm text-zinc-500">
          Latest health snapshot — refreshed by the health-check cron.
        </p>
      </header>

      {snapshot.isLoading ? (
        <p className="text-sm text-zinc-500">Loading snapshot…</p>
      ) : !snapshot.data ? (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader>
            <CardTitle className="text-amber-200 text-base">No snapshot yet</CardTitle>
            <CardDescription className="text-amber-200/70">
              The health-check cron hasn't run yet. It fires every 5 minutes by default. Open{" "}
              <Link to="/doctor" className="underline">
                Doctor
              </Link>{" "}
              to force a probe.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card
          className={
            ready ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"
          }
        >
          <CardHeader>
            <CardTitle
              className={
                ready
                  ? "flex items-center gap-2 text-base text-emerald-200"
                  : "flex items-center gap-2 text-amber-200 text-base"
              }
            >
              {ready ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
              {ready ? "All systems go" : "Setup incomplete"}
            </CardTitle>
            <CardDescription className={ready ? "text-emerald-200/70" : "text-amber-200/70"}>
              Last check {relTime(checkedAt)} •{" "}
              {ready
                ? `${steps.length}/${steps.length} steps green`
                : `${steps.filter((s) => !s.done).length} step(s) need attention`}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {steps.map((s) => (
              <Link
                to="/doctor"
                key={s.id}
                className={
                  s.done
                    ? "rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 hover:bg-emerald-500/10"
                    : "rounded-md border border-red-500/30 bg-red-500/5 p-2 hover:bg-red-500/10"
                }
              >
                <div className="flex items-center gap-1.5 text-xs">
                  {s.done ? (
                    <Check className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <X className="h-3.5 w-3.5 text-red-400" />
                  )}
                  <span className="font-medium">{s.label}</span>
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Repos enabled"
          value={(repos.data ?? []).filter((r) => r.enabled).length}
        />
        <StatCard label="Repos total" value={(repos.data ?? []).length} />
        <StatCard
          label="Steps green"
          value={steps.filter((s) => s.done).length}
          suffix={`/${steps.length || 4}`}
        />
        <StatCard label="Last check" value={relTime(checkedAt)} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <CronCard name="sentry-poll" compact />
        <CronCard name="health-check" compact />
      </div>

      <Card>
        <CardContent className="pt-6 text-sm text-zinc-500">
          Need to change a schedule or re-probe immediately?{" "}
          <Link to="/doctor" className="underline">
            Open Doctor →
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string | number;
  suffix?: string;
}) {
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <div className="text-xs text-zinc-500">{label}</div>
        <div className="font-semibold text-2xl">
          {value}
          {suffix ? <span className="text-sm text-zinc-500">{suffix}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
