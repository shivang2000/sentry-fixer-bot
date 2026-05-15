import { env } from "@sentry-fixer-bot/env/server";
import { PgBoss } from "pg-boss";

let cached: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (cached) return cached;
  const boss = new PgBoss({ connectionString: env.DATABASE_URL });
  await boss.start();
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
