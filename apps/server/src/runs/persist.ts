import { createDb } from "@sentry-fixer-bot/db";
import { runs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";

export type RunInsert = typeof runs.$inferInsert;
export type RunUpdate = Partial<typeof runs.$inferInsert>;

export async function createRun(values: RunInsert): Promise<string> {
  const db = createDb();
  const inserted = await db.insert(runs).values(values).returning({ id: runs.id });
  const row = inserted[0];
  if (!row) throw new Error("createRun: empty returning");
  return row.id;
}

export async function updateRun(id: string, patch: RunUpdate): Promise<void> {
  const db = createDb();
  await db.update(runs).set(patch).where(eq(runs.id, id));
}

export async function findRunById(id: string) {
  const db = createDb();
  const rows = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return rows[0];
}
