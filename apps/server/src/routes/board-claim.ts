import { createHash } from "node:crypto";
import { auth as betterAuth } from "@sentry-fixer-bot/auth";
import { validateClaimRequest } from "@sentry-fixer-bot/auth/claim-logic";
import { createDb } from "@sentry-fixer-bot/db";
import { user as userTable } from "@sentry-fixer-bot/db/schema/auth";
import { boardClaimTokens } from "@sentry-fixer-bot/db/schema/invites";
import { env } from "@sentry-fixer-bot/env/server";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

export const boardClaim = new Hono();

boardClaim.post("/board-claim/:token", async (c) => {
  if (env.DEPLOYMENT_MODE === "local_trusted") {
    return c.json({ error: "claim_not_applicable_in_local_trusted" }, 400);
  }

  const session = await betterAuth.api.getSession({ headers: c.req.raw.headers });
  const sessionUser = session?.user ? { id: session.user.id } : null;

  const token = c.req.param("token");
  const code = c.req.query("code") ?? null;

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const db = createDb();
  const rows = await db
    .select()
    .from(boardClaimTokens)
    .where(eq(boardClaimTokens.tokenHash, tokenHash))
    .limit(1);
  const dbRow = rows[0] ?? null;

  const verdict = validateClaimRequest({
    sessionUser,
    code,
    dbRow: dbRow
      ? { code: dbRow.code, expiresAt: dbRow.expiresAt, consumedAt: dbRow.consumedAt ?? null }
      : null,
    now: new Date(),
  });

  switch (verdict) {
    case "unauthorized":
      return c.json({ error: "unauthorized" }, 401);
    case "missing_code":
      return c.json({ error: "missing_code" }, 400);
    case "invalid_or_expired":
      return c.json({ error: "invalid_or_expired" }, 400);
    case "consumed":
      return c.json({ error: "consumed" }, 400);
  }

  if (!dbRow || !sessionUser) {
    // unreachable after the switch above; defensive
    return c.json({ error: "internal_inconsistency" }, 500);
  }

  await db.transaction(async (tx) => {
    await tx
      .update(userTable)
      .set({ role: "instance_admin" })
      .where(eq(userTable.id, sessionUser.id));
    await tx
      .update(boardClaimTokens)
      .set({ consumedAt: new Date(), consumedByUserId: sessionUser.id })
      .where(eq(boardClaimTokens.id, dbRow.id));
  });

  return c.json({ ok: true });
});
