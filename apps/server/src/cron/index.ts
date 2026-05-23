/**
 * Cron-registration entry point.
 *
 * Two new daily jobs land here in P8:
 *   - outcome-poll  → 02:00 UTC daily — walks open bot PRs, records prs.outcome.
 *   - daily-digest  → 06:00 UTC daily — fans out per-trigger 7d digests.
 *
 * Other cron jobs (sentry-poll, health-check, pr-comment-poll) stay
 * registered in `apps/server/src/worker/index.ts` since they were
 * introduced before this module existed. Future migrations can move
 * them under this directory in a separate refactor pass.
 */

import { getBoss, getScheduleStatus, scheduleRecurring } from "../queue/boss";
import { DAILY_DIGEST_CRON, JOB_DAILY_DIGEST, processDailyDigestJob } from "./daily-digest";
import { JOB_OUTCOME_POLL, OUTCOME_POLL_CRON, processOutcomePollJob } from "./outcome-poll";

export { JOB_DAILY_DIGEST, JOB_OUTCOME_POLL, processDailyDigestJob, processOutcomePollJob };

/**
 * pg-boss worker registration + first-run schedule install. Operator
 * can later disable either schedule via the cron UI (P8 doesn't add
 * UI controls — operators edit the schedule row via `boss.schedule`
 * directly or via the `cron` tRPC router if it gets extended).
 */
export async function registerSelfImprovementCrons(): Promise<void> {
  const boss = await getBoss();
  // pg-boss v12: every cron queue must exist before work() / send().
  for (const name of [JOB_OUTCOME_POLL, JOB_DAILY_DIGEST]) {
    try {
      await boss.createQueue(name);
    } catch {
      // queue already exists
    }
  }

  // expireInSeconds: outcome poll talks to GitHub up to N PRs × 3
  // requests each. 14 days × N triggers can be a few hundred PRs at
  // worst; budget 30 minutes per tick. daily-digest is much faster but
  // also network-bound (channel sends) — same 30-minute lock to avoid
  // mid-sweep eviction.
  await (
    boss as unknown as {
      work<T>(
        name: string,
        options: object,
        handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>,
      ): Promise<string>;
    }
  ).work(JOB_OUTCOME_POLL, { expireInSeconds: 30 * 60 }, async (jobs) => {
    for (const _ of jobs) {
      await processOutcomePollJob();
    }
  });
  await (
    boss as unknown as {
      work<T>(
        name: string,
        options: object,
        handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>,
      ): Promise<string>;
    }
  ).work(JOB_DAILY_DIGEST, { expireInSeconds: 30 * 60 }, async (jobs) => {
    for (const _ of jobs) {
      await processDailyDigestJob();
    }
  });

  // First-run schedule install. Idempotent — only seeds when no row
  // exists, so operators can unschedule via cron UI and the choice
  // persists across reboots. Matches the pattern in worker/index.ts.
  await ensureDefaultSchedule(JOB_OUTCOME_POLL, OUTCOME_POLL_CRON);
  await ensureDefaultSchedule(JOB_DAILY_DIGEST, DAILY_DIGEST_CRON);
}

async function ensureDefaultSchedule(name: string, cron: string): Promise<void> {
  const cur = await getScheduleStatus(name);
  if (cur.cron) return;
  await scheduleRecurring(name, cron, {});
}
