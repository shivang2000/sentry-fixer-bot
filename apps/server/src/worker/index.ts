/**
 * Worker entry: registers pg-boss handlers for triage + agent jobs +
 * Sentry poll + health-check probes. Run via
 *   `bun apps/server/src/worker/index.ts`
 * standalone, or via the in-band import from the HTTP server in
 * container mode.
 */
import { log } from "../log";
import { getBoss, getScheduleStatus, scheduleRecurring } from "../queue/boss";
import {
  type AgentJob,
  type HealthCheckJob,
  JOB_AGENT,
  JOB_HEALTH_CHECK,
  JOB_SENTRY_POLL,
  JOB_TRIAGE,
  type SentryPollJob,
  type TriageJob,
} from "../queue/jobs";
import { processAgentJob } from "./agent-job";
import { processHealthCheckJob } from "./health-check-job";
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
  ).work<AgentJob>(JOB_AGENT, { expireInSeconds: 30 * 60 }, async (jobs) => {
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

  // First-run defaults. Idempotent: subsequent boots respect whatever
  // the operator set in the UI (including "never"). Defaults match the
  // 15m / 30m / 1h / 4h / 1d presets the UI offers — keep them in that
  // set so the dropdowns reflect actual values.
  await ensureDefaultSchedule(JOB_SENTRY_POLL, "*/15 * * * *", { lookbackMinutes: 15 });
  await ensureDefaultSchedule(JOB_HEALTH_CHECK, "*/15 * * * *");

  log.info("worker ready");
}

await main();
