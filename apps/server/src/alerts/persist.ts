import { createDb } from "@sentry-fixer-bot/db";
import { alerts } from "@sentry-fixer-bot/db/schema/domain";
import { eq, sql } from "drizzle-orm";

export type AlertInsert = typeof alerts.$inferInsert;

export type PersistedAlert = {
  id: string;
  isNew: boolean;
};

/**
 * Insert an alert by dedup_key. If a row already exists, bump webhook_count
 * and last_seen_at and return its id. Returns { id, isNew } so the webhook
 * handler can short-circuit on dupes.
 */
export async function upsertAlert(values: AlertInsert): Promise<PersistedAlert> {
  const db = createDb();

  const inserted = await db
    .insert(alerts)
    .values(values)
    .onConflictDoUpdate({
      target: alerts.dedupKey,
      set: {
        webhookCount: sql`${alerts.webhookCount} + 1`,
        lastSeenAt: values.lastSeenAt,
      },
    })
    .returning({ id: alerts.id, webhookCount: alerts.webhookCount });

  const row = inserted[0];
  if (!row) throw new Error("upsertAlert: empty returning clause");
  return { id: row.id, isNew: row.webhookCount === 1 };
}

export async function findAlertById(id: string) {
  const db = createDb();
  const rows = await db.select().from(alerts).where(eq(alerts.id, id)).limit(1);
  return rows[0];
}
