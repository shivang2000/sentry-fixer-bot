import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Play, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

type Props = {
  /** Initial URL value (e.g. preserved via query param on /triggers/$id). */
  initialUrl?: string;
  compact?: boolean;
};

/**
 * Single URL input → detect-on-blur → run pipeline. Replaces the Sentry-
 * only trigger box at the top of /runs. Source-agnostic: walks the
 * registry via triggers.detectUrl, then fires triggers.runFromUrl.
 *
 * Error UI per spec:
 *   - URL unrecognized → muted "configure a source" hint
 *   - No matching trigger → inline link to /triggers/new?source=<type>
 *   - adapter fetch failure → toast.error + the link to /runs for debug
 */
export function ManualUrlTrigger({ initialUrl = "", compact }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [url, setUrl] = useState(initialUrl);
  // Debounced echo so a query only fires once the user pauses typing.
  // Server is the authority — we don't run the regex client-side.
  const [debouncedUrl, setDebouncedUrl] = useState(initialUrl);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(url), 400);
    return () => clearTimeout(t);
  }, [url]);

  const detect = useQuery({
    ...trpc.triggers.detectUrl.queryOptions({ url: debouncedUrl }),
    enabled: debouncedUrl.trim().length > 0,
    staleTime: 5000,
  });

  const run = useMutation(
    trpc.triggers.runFromUrl.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Queued ${r.triggerName ?? r.sourceProject}: ${r.title.slice(0, 60)}`);
        setUrl("");
        qc.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
        // Drop into the runs index — /runs/$id requires a runId we don't
        // have here (boss returns a jobId, not the runs.id row). The
        // run is enqueued; the worker writes the runs row when it picks
        // up the triage job, which the runs index will then surface.
        navigate({ to: "/runs" });
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const matching = detect.data?.matchingTrigger ?? null;

  return (
    <Card>
      <CardHeader className={compact ? "pb-2" : undefined}>
        <CardTitle className="flex items-center gap-2 text-base">
          <Zap className="h-4 w-4" /> Trigger fix from URL
        </CardTitle>
        <CardDescription>
          Paste a Sentry / PostHog / PagerDuty issue URL. We detect the source from the URL pattern,
          look up the matching trigger, and enqueue the pipeline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="manual-url">Issue URL</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="manual-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-org.sentry.io/issues/12345/"
              aria-describedby="manual-url-detect"
            />
            <Button
              type="button"
              disabled={!matching || run.isPending}
              onClick={() => run.mutate({ url })}
            >
              <Play className="mr-1.5 h-4 w-4" />
              {run.isPending ? "Queuing…" : "Run pipeline now"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!matching || run.isPending}
              onClick={() => run.mutate({ url, mode: "triage_only" })}
            >
              Triage-only
            </Button>
          </div>
        </div>

        <div id="manual-url-detect" className="min-h-[36px] text-xs">
          {detect.isLoading && debouncedUrl.length > 0 ? (
            <span className="text-zinc-500">Detecting source…</span>
          ) : detect.error ? (
            <span className="text-red-300">{detect.error.message}</span>
          ) : debouncedUrl.length === 0 ? (
            <span className="text-zinc-500">Paste a URL to detect the source.</span>
          ) : !detect.data ? (
            <span className="text-amber-300">
              Source not recognized. Configure a source adapter first.
            </span>
          ) : matching ? (
            <div className="space-y-0.5">
              <p>
                Detected source:{" "}
                <span className="font-medium text-emerald-300">
                  {detect.data.adapterDisplayName}
                </span>
                {detect.data.sourceProject !== "*" ? (
                  <>
                    {" "}
                    · project <span className="font-mono">{detect.data.sourceProject}</span>
                  </>
                ) : null}
              </p>
              <p>
                Matching trigger:{" "}
                <Link
                  to="/triggers/$id"
                  params={{ id: matching.id }}
                  className="font-medium text-indigo-300 underline"
                >
                  {matching.name}
                </Link>{" "}
                → <span className="font-mono">{matching.repoGithub}</span> · preset{" "}
                <span className="font-mono">{matching.preset}</span>
              </p>
            </div>
          ) : (
            <div className="space-y-0.5">
              <p>
                Detected source:{" "}
                <span className="font-medium">{detect.data.adapterDisplayName}</span>
                {detect.data.sourceProject !== "*" ? (
                  <>
                    {" · project "}
                    <span className="font-mono">{detect.data.sourceProject}</span>
                  </>
                ) : null}
              </p>
              <p className="text-amber-300">
                No trigger configured.{" "}
                <Link
                  to="/triggers/new"
                  search={{ source: detect.data.adapterType }}
                  className="underline"
                >
                  Create one
                </Link>
              </p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
