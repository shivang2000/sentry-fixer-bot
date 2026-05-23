import { TrendingUp } from "lucide-react";

/**
 * 30-day merge-rate trendline placeholder. Wires up to real outcome
 * data (prs.outcome + prs.mergedAt) when P8's outcome rollup ships.
 *
 * Rendered as a sparkline SVG; deterministic mock data keyed by the
 * trigger id so refreshes show the same line until real data lands.
 */
type Props = {
  triggerId: string;
  className?: string;
};

export function OutcomeChart({ triggerId, className }: Props) {
  const points = generateMockSeries(triggerId, 30);
  const max = Math.max(...points, 1);
  const w = 240;
  const h = 60;
  const dx = w / Math.max(points.length - 1, 1);
  const path = points
    .map((p, i) => {
      const x = i * dx;
      const y = h - (p / max) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const avg = Math.round((points.reduce((a, b) => a + b, 0) / points.length) * 100);

  return (
    <div className={className}>
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <span className="flex items-center gap-1">
          <TrendingUp className="h-3 w-3" /> 30-day merge rate (preview)
        </span>
        <span className="font-mono">{avg}%</span>
      </div>
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label="30-day merge rate trendline (placeholder data)"
      >
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-indigo-400"
        />
      </svg>
    </div>
  );
}

// Deterministic pseudo-random based on the triggerId string so the
// chart is stable across renders without real data.
function generateMockSeries(seed: string, n: number): number[] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const out: number[] = [];
  let cur = ((Math.abs(hash) % 50) + 30) / 100; // 0.30–0.80 starting point
  for (let i = 0; i < n; i++) {
    hash = (hash * 1103515245 + 12345) & 0x7fffffff;
    const noise = ((hash % 200) - 100) / 1000;
    cur = Math.max(0, Math.min(1, cur + noise));
    out.push(cur);
  }
  return out;
}
