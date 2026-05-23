import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { BarChart3 } from "lucide-react";

import { trpc } from "@/utils/trpc";

/**
 * Live preview of the next daily digest for a trigger.
 *
 * Hits `triggers.previewDigest` which reuses the same `buildDigest`
 * step package the cron does. What the operator sees here mirrors what
 * the next 06:00 UTC tick would post — minus the channel transport
 * (no Slack/email sent).
 */
type Props = {
  triggerId: string;
};

export function DigestPreview({ triggerId }: Props) {
  const q = useQuery(trpc.triggers.previewDigest.queryOptions({ triggerId }));

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" /> Digest preview
          </CardTitle>
          <CardDescription>Loading the next 7-day roll-up…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (q.error || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-4 w-4" /> Digest preview
          </CardTitle>
          <CardDescription className="text-amber-300">
            {q.error?.message ?? "Could not load digest preview"}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const d = q.data;
  const merged = d.mergedClean + d.mergedWithEdits;
  const mergeRate = d.fixesAttempted > 0 ? Math.round((merged / d.fixesAttempted) * 100) : 0;
  const cleanRate = d.fixesAttempted > 0 ? Math.round((d.mergedClean / d.fixesAttempted) * 100) : 0;
  const capPct = d.capCents > 0 ? Math.round((d.costCents / d.capCents) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="h-4 w-4" /> Digest preview
        </CardTitle>
        <CardDescription>
          What the next daily digest would say, computed live from the last 7 days of runs + PRs.
          Sent at 06:00 UTC daily to any channel with <code>digest</code> in its notify list.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kv k="Alerts" v={String(d.alertCount)} />
          <Kv k="PRs opened" v={String(d.fixesAttempted)} />
          <Kv k="Merge rate" v={`${mergeRate}%`} hint={`${cleanRate}% clean`} />
          <Kv
            k="Cost vs cap"
            v={`$${(d.costCents / 100).toFixed(2)} / $${(d.capCents / 100).toFixed(2)}`}
            hint={`${capPct}%`}
          />
          <Kv k="Merged clean" v={String(d.mergedClean)} />
          <Kv k="Merged w/ edits" v={String(d.mergedWithEdits)} />
          <Kv k="Closed unmerged" v={String(d.closedUnmerged)} />
          <Kv k="Still open" v={String(d.open)} />
        </dl>

        {d.topFingerprints.length > 0 ? (
          <div>
            <h3 className="text-[11px] text-zinc-500 uppercase">Top recurring fingerprints</h3>
            <ol className="mt-1 space-y-1 text-sm">
              {d.topFingerprints.map((fp, i) => (
                <li key={fp.fingerprint} className="text-zinc-300">
                  <span className="font-mono text-zinc-500">{i + 1}.</span>{" "}
                  <span className="text-zinc-100">{fp.title}</span>{" "}
                  <span className="text-[11px] text-zinc-500">
                    ×{fp.count} ({fp.closed} closed)
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {d.suggestedAction ? (
          <div className="rounded-md border border-amber-700 bg-amber-950/40 p-3 text-amber-100 text-sm">
            <p className="font-medium text-[11px] text-amber-300 uppercase">Suggested action</p>
            <p className="mt-1">{d.suggestedAction}</p>
          </div>
        ) : null}

        <p className="text-[11px] text-zinc-500">
          Window: {d.windowStart.slice(0, 10)} → {d.windowEnd.slice(0, 10)}
        </p>
      </CardContent>
    </Card>
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
