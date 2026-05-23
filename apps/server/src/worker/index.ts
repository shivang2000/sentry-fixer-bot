/**
 * Worker entry: registers pg-boss handlers for triage + agent jobs +
 * Sentry poll + health-check probes. Run via
 *   `bun apps/server/src/worker/index.ts`
 * standalone, or via the in-band import from the HTTP server in
 * container mode.
 */
import { registerSelfImprovementCrons } from "../cron";
import { log } from "../log";
import { getBoss, getScheduleStatus, scheduleRecurring } from "../queue/boss";
import {
  type AgentJob,
  type HealthCheckJob,
  JOB_AGENT,
  JOB_HEALTH_CHECK,
  JOB_PR_COMMENT_POLL,
  JOB_PR_FOLLOWUP,
  JOB_SENTRY_POLL,
  JOB_TRIAGE,
  type PrCommentPollJob,
  type PrFollowupJob,
  type SentryPollJob,
  type TriageJob,
} from "../queue/jobs";
import { processAgentJob } from "./agent-job";
import { processHealthCheckJob } from "./health-check-job";
import { processPrCommentPollJob } from "./pr-comment-poll-job";
import { processPrFollowupJob } from "./pr-followup-job";
import { processSentryPollJob } from "./sentry-poll-job";
import { processTriageJob } from "./triage-job";

async function ensureDefaultSchedule(name: string, cron: string, data: object = {}): Promise<void> {
  // Operator-controlled choice wins: only seed when no row exists, so
  // "set preset = never" via the UI persists across reboots.
  const cur = await getScheduleStatus(name);
  if (cur.cron) return;
  await scheduleRecurring(name, cron, data);
}

async function main(): Promise<void> {
  const boss = await getBoss();

  // expireInSeconds: long-lived handlers. claude triage takes 20-60s,
  // agent runs take 5-15 min. Default 30s lock expires mid-execution
  // and pg-boss reschedules — operator sees "triage picked up" twice.
  // pg-boss v12's types don't cleanly expose the options overload, so
  // cast where needed.
  await (
    boss as unknown as {
      work<T>(
        name: string,
        options: object,
        handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>,
      ): Promise<string>;
    }
  ).work<TriageJob>(JOB_TRIAGE, { expireInSeconds: 5 * 60 }, async (jobs) => {
    for (const job of jobs) {
      log.info({ id: job.id, payload: job.data }, "triage job picked up");
      await processTriageJob(job.data);
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
  )
    // retryLimit:0 — agent jobs are long, externally observable, and
    // expensive (claude tokens + dep install + tests). If the worker
    // throws (e.g. transient pg drop), surfacing the failure as
    // agent_error is preferable to silently redoing the whole 10-min
    // run. Operator can manually retrigger via /runs after diagnosing.
    .work<AgentJob>(JOB_AGENT, { expireInSeconds: 30 * 60, retryLimit: 0 }, async (jobs) => {
      for (const job of jobs) {
        log.info({ id: job.id, payload: job.data }, "agent job picked up");
        await processAgentJob(job.data);
      }
    });

  await boss.work<SentryPollJob>(JOB_SENTRY_POLL, async (jobs) => {
    for (const job of jobs) {
      await processSentryPollJob(job.data ?? {});
    }
  });

  await boss.work<HealthCheckJob>(JOB_HEALTH_CHECK, async (jobs) => {
    for (const _ of jobs) {
      await processHealthCheckJob();
    }
  });

  // Follow-up worker: re-attaches a worktree on the PR's branch, runs
  // claude with the reviewer's instruction, commits + pushes. Same
  // 30-minute lock as the agent job — apply-fix runs can be long.
  await (
    boss as unknown as {
      work<T>(
        name: string,
        options: object,
        handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>,
      ): Promise<string>;
    }
  )
    // Same rationale as JOB_AGENT — surfacing as waiting_human via the
    // catch handler is more useful than blind redelivery.
    .work<PrFollowupJob>(
      JOB_PR_FOLLOWUP,
      { expireInSeconds: 30 * 60, retryLimit: 0 },
      async (jobs) => {
        for (const job of jobs) {
          log.info({ id: job.id, payload: job.data }, "pr-followup job picked up");
          await processPrFollowupJob(job.data);
        }
      },
    );

  await boss.work<PrCommentPollJob>(JOB_PR_COMMENT_POLL, async (jobs) => {
    for (const _ of jobs) {
      await processPrCommentPollJob();
    }
  });

  // First-run defaults. Idempotent: subsequent boots respect whatever
  // the operator set in the UI (including "never"). Defaults match the
  // 15m / 30m / 1h / 4h / 1d presets the UI offers — keep them in that
  // set so the dropdowns reflect actual values.
  await ensureDefaultSchedule(JOB_SENTRY_POLL, "*/15 * * * *", { lookbackMinutes: 15 });
  await ensureDefaultSchedule(JOB_HEALTH_CHECK, "*/15 * * * *");
  // PR comment poll runs every 5m as a fallback for when the GitHub
  // webhook is not configured (no GITHUB_WEBHOOK_SECRET) or webhook
  // delivery dropped a payload. Five minutes is the worst-case
  // reviewer wait time before a `/sfb` lands; idempotent via
  // lastReviewedCommentAt so duplicate webhook+cron deliveries are
  // safe.
  await ensureDefaultSchedule(JOB_PR_COMMENT_POLL, "*/5 * * * *");

  // P8 self-improvement crons: outcome-poll (02:00 UTC daily) + daily-
  // digest (06:00 UTC daily). Lives in apps/server/src/cron/ so the
  // worker module stays the place where queues + handlers register
  // and the cron module owns its own schedule defaults.
  await registerSelfImprovementCrons();

  log.info("worker ready");
}

await main();
