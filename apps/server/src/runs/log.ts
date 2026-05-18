import { createDb } from "@sentry-fixer-bot/db";
import { runLogs } from "@sentry-fixer-bot/db/schema/domain";
import { eq, sql } from "drizzle-orm";

// Per-process sequence counter keyed by run id. On first use for a
// given run we seed it from MAX(seq) in the DB so a server restart
// (or a follow-up worker writing to a run id from a prior boot) keeps
// extending the timeline instead of colliding with the existing rows.
//
// The unique (run_id, seq) constraint plus the increment+insert
// pattern below is racy under concurrent writers — pg-boss only runs
// one processor per job at a time, so the only collision risk is two
// jobs targeting the same run id from different processes. In that
// case the loser hits the unique constraint, the catch swallows it,
// and we log a warning rather than silently dropping the line.
const seqByRun = new Map<string, number>();

async function seedSeq(runId: string): Promise<number> {
  const db = createDb();
  const rows = await db
    .select({ max: sql<number | null>`MAX(${runLogs.seq})` })
    .from(runLogs)
    .where(eq(runLogs.runId, runId));
  return rows[0]?.max ?? 0;
}

async function nextSeq(runId: string): Promise<number> {
  let cur = seqByRun.get(runId);
  if (cur === undefined) {
    cur = await seedSeq(runId);
  }
  const n = cur + 1;
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
      seq: await nextSeq(input.runId),
      level: input.level,
      source: input.source,
      message: input.message.slice(0, 8_000),
    });
  } catch (err) {
    // Unique constraint collision (rare — two processes targeting the
    // same run). Reset the cached counter so the next call re-seeds
    // from DB.
    seqByRun.delete(input.runId);
    console.warn("[runs/log] insert failed", err);
  }
}
