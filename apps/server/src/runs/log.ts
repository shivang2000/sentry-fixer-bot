import { createDb } from "@sentry-fixer-bot/db";
import { runLogs } from "@sentry-fixer-bot/db/schema/domain";

// Per-process sequence counter keyed by run id. pg-boss reschedules can
// produce two concurrent processors for the same run, but seq is
// scoped per-process — the unique (run_id, seq) constraint will reject
// the dup and the writer swallows the error. Good enough for a live
// tail; cron'd retention can purge later.
const seqByRun = new Map<string, number>();

function nextSeq(runId: string): number {
  const n = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, n);
  return n;
}

export type RunLogLevel = "info" | "warn" | "error" | "debug";

export async function appendRunLog(input: {
  runId: string;
  level: RunLogLevel;
  source: string;
  message: string;
}): Promise<void> {
  const db = createDb();
  try {
    await db.insert(runLogs).values({
      runId: input.runId,
      seq: nextSeq(input.runId),
      level: input.level,
      source: input.source,
      message: input.message.slice(0, 8_000),
    });
  } catch {
    // duplicate seq from a retried job — ignore
  }
}
