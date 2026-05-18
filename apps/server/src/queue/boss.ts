import { env } from "@sentry-fixer-bot/env/server";
import { PgBoss } from "pg-boss";
import {
  JOB_AGENT,
  JOB_HEALTH_CHECK,
  JOB_PR_COMMENT_POLL,
  JOB_PR_FOLLOWUP,
  JOB_SENTRY_POLL,
  JOB_TRIAGE,
} from "./jobs";

let cached: PgBoss | null = null;

async function ensureQueues(boss: PgBoss): Promise<void> {
  // pg-boss v12 requires queues to exist before send/work
  for (const name of [
    JOB_TRIAGE,
    JOB_AGENT,
    JOB_SENTRY_POLL,
    JOB_HEALTH_CHECK,
    JOB_PR_FOLLOWUP,
    JOB_PR_COMMENT_POLL,
  ]) {
    try {
      await boss.createQueue(name);
    } catch {
      // already exists
    }
  }
}

/**
 * Install a recurring schedule. pg-boss stores the cron in postgres and
 * enqueues a fresh job on every tick. Idempotent across re-calls — boss
 * upserts the schedule row by name. Standard 5-field cron syntax.
 */
export async function scheduleRecurring(
  name: string,
  cron: string,
  data: object = {},
): Promise<void> {
  const boss = await getBoss();
  await boss.schedule(name, cron, data);
}

/**
 * Inverse of scheduleRecurring. No-op if the schedule doesn't exist —
 * pg-boss raises in that case and we don't care.
 */
export async function unscheduleRecurring(name: string): Promise<void> {
  const boss = await getBoss();
  try {
    await boss.unschedule(name);
  } catch {
    // not scheduled
  }
}

/**
 * Read the schedule row for `name` if one exists. Used by the cron UI to
 * render "enabled? at <cron>? last tick when?".
 */
export async function getScheduleStatus(
  name: string,
): Promise<{ cron: string | null; data: unknown | null }> {
  const boss = await getBoss();
  const schedules = (await boss.getSchedules()) as Array<{
    name: string;
    cron: string;
    data: unknown;
  }>;
  const row = schedules.find((s) => s.name === name);
  return row ? { cron: row.cron, data: row.data } : { cron: null, data: null };
}

export async function getBoss(): Promise<PgBoss> {
  if (cached) return cached;
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  await boss.start();
  await ensureQueues(boss);
  cached = boss;
  return boss;
}

export async function publishJob<Name extends string, Data extends object>(
  name: Name,
  data: Data,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(name, data);
}
