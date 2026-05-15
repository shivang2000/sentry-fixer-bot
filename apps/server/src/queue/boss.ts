import { env } from "@sentry-fixer-bot/env/server";
import { PgBoss } from "pg-boss";
import { JOB_AGENT, JOB_TRIAGE } from "./jobs";

let cached: PgBoss | null = null;

async function ensureQueues(boss: PgBoss): Promise<void> {
  // pg-boss v12 requires queues to exist before send/work
  for (const name of [JOB_TRIAGE, JOB_AGENT]) {
    try {
      await boss.createQueue(name);
    } catch {
      // already exists
    }
  }
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
