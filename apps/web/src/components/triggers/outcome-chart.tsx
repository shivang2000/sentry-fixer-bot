import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";

import { trpc } from "@/utils/trpc";

/**
 * 30-day outcome breakdown for a trigger. Renders a stacked-column SVG
 * sparkline — one column per day, segments coloured by outcome
 * (merged-clean, merged-with-edits, closed-unmerged, stale-open).
 *
 * Empty state: when the trigger has no recorded outcomes yet, we
 * render a placeholder rather than an empty chart. This is expected
 * for the first 14 days of a fresh install (outcome poll hasn't had
 * time to populate the column).
 *
 * P6 shipped a placeholder with deterministic mock data; P8 wires this
 * to the `runs.outcomeChart` tRPC procedure backed by `prs.outcome`.
 */
type Props = {
  triggerId: string;
  className?: string;
  days?: number;
};

type DayBucket = {
  bucket: string;
  merged_clean: number;
  merged_with_edits: number;
  closed_unmerged: number;
  stale_open: number;
};

const COLORS = {
  mergedClean: "#10b981", // emerald
  mergedWithEdits: "#6366f1", // indigo
  closedUnmerged: "#ef4444", // red
  staleOpen: "#a3a3a3", // zinc
} as const;

export function OutcomeChart({ triggerId, className, days = 30 }: Props) {
  const q = useQuery(trpc.runs.outcomeChart.queryOptions({ triggerId, days }));

  const buckets: DayBucket[] = (q.data ?? []) as DayBucket[];
  const hasAny = buckets.some(
    (b) => b.merged_clean + b.merged_with_edits + b.closed_unmerged + b.stale_open > 0,
  );

  if (q.isLoading) {
    return (
      <div className={className}>
        <p className="text-[11px] text-zinc-500">Loading outcomes…</p>
      </div>
    );
  }

  if (!hasAny) {
    return (
      <div className={className}>
        <div className="flex items-center justify-between text-[11px] text-zinc-500">
          <span className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3" /> {days}-day outcomes
          </span>
        </div>
        <p className="mt-1 rounded-md border border-zinc-800 border-dashed p-3 text-center text-[11px] text-zinc-500">
          No outcome data yet — the daily outcome-poll cron has not recorded a result for this
          trigger in the last {days} days.
        </p>
      </div>
    );
  }

  const w = 240;
  const h = 60;
  const padY = 4;
  const colW = w / Math.max(buckets.length, 1);
  const maxStack = Math.max(
    1,
    ...buckets.map((b) => b.merged_clean + b.merged_with_edits + b.closed_unmerged + b.stale_open),
  );
  const totalClean = buckets.reduce((s, b) => s + b.merged_clean, 0);
  const totalMerged = buckets.reduce((s, b) => s + b.merged_clean + b.merged_with_edits, 0);
  const totalAttempted = buckets.reduce(
    (s, b) => s + b.merged_clean + b.merged_with_edits + b.closed_unmerged + b.stale_open,
    0,
  );
  const mergeRatePct = totalAttempted > 0 ? Math.round((totalMerged / totalAttempted) * 100) : 0;

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <TrendingUp className="h-3 w-3" /> {days}-day merge rate
        </span>
        <span className="font-mono">
          {mergeRatePct}% ({totalClean}/{totalAttempted})
        </span>
      </div>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`${days}-day stacked outcome bars; ${mergeRatePct}% merge rate`}
      >
        {buckets.map((b, i) => {
          const x = i * colW;
          const total = b.merged_clean + b.merged_with_edits + b.closed_unmerged + b.stale_open;
          if (total === 0) {
            return (
              <rect
                key={b.bucket}
                x={x + colW * 0.1}
                y={h - 1}
                width={colW * 0.8}
                height={1}
                fill="#27272a"
              />
            );
          }
          const scale = (h - padY * 2) / maxStack;
          let cur = h - padY;
          const segments: Array<{ name: string; value: number; fill: string }> = [
            { name: "clean", value: b.merged_clean, fill: COLORS.mergedClean },
            {
              name: "with-edits",
              value: b.merged_with_edits,
              fill: COLORS.mergedWithEdits,
            },
            { name: "closed", value: b.closed_unmerged, fill: COLORS.closedUnmerged },
            { name: "stale", value: b.stale_open, fill: COLORS.staleOpen },
          ];
          return (
            <g key={b.bucket}>
              <title>
                {`${b.bucket}: clean=${b.merged_clean} edits=${b.merged_with_edits} closed=${b.closed_unmerged} stale=${b.stale_open}`}
              </title>
              {segments.map((s) => {
                if (s.value <= 0) return null;
                const segH = s.value * scale;
                const y = cur - segH;
                cur = y;
                return (
                  <rect
                    key={`${b.bucket}-${s.name}`}
                    x={x + colW * 0.1}
                    y={y}
                    width={colW * 0.8}
                    height={Math.max(segH, 0.5)}
                    fill={s.fill}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
      <Swatch color={COLORS.mergedClean} label="clean" />
      <Swatch color={COLORS.mergedWithEdits} label="w/ edits" />
      <Swatch color={COLORS.closedUnmerged} label="closed" />
      <Swatch color={COLORS.staleOpen} label="stale" />
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
