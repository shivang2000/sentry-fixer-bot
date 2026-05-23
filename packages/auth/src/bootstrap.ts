import { createHash, randomBytes } from "node:crypto";
import { createDb } from "@alertforge/db";
import { user } from "@alertforge/db/schema/auth";
import { boardClaimTokens } from "@alertforge/db/schema/invites";
import { env } from "@alertforge/env/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { LOCAL_BOARD_EMAIL, LOCAL_BOARD_ID, shouldSeedLocalBoard } from "./bootstrap-logic";

export { LOCAL_BOARD_EMAIL, LOCAL_BOARD_ID, shouldSeedLocalBoard };

export async function bootstrapLocalTrustedAdmin(opts?: {
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}): Promise<void> {
  const db = createDb();
  const log = opts?.log ?? ((m: string) => console.log(`[bootstrap] ${m}`));

  const existing = await db.select().from(user).where(eq(user.id, LOCAL_BOARD_ID));
  if (
    !shouldSeedLocalBoard({
      deploymentMode: env.DEPLOYMENT_MODE,
      existingLocalBoard: existing.length > 0,
    })
  ) {
    return;
  }

  await db.insert(user).values({
    id: LOCAL_BOARD_ID,
    email: LOCAL_BOARD_EMAIL,
    name: "Local Board",
    role: "instance_admin",
    emailVerified: true,
  });
  log("seeded local-board admin for local_trusted mode", { id: LOCAL_BOARD_ID });
}

export async function maybeEmitClaimUrl(opts?: {
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}): Promise<void> {
  if (env.DEPLOYMENT_MODE !== "authenticated") return;

  const db = createDb();
  const log =
    opts?.log ??
    ((m: string, c?: Record<string, unknown>) => console.warn(`[claim] ${m}`, c ?? ""));

  const realAdmins = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user)
    .where(and(eq(user.role, "instance_admin"), ne(user.id, LOCAL_BOARD_ID)));
  if ((realAdmins[0]?.count ?? 0) > 0) return;

  const token = randomBytes(32).toString("base64url");
  const code = randomBytes(6).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await db.insert(boardClaimTokens).values({ tokenHash, code, expiresAt });

  const base = env.PUBLIC_BASE_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:3000";
  log(
    "AUTHENTICATED mode active but no real admin exists. Sign up at the URL above, then visit /board-claim to claim instance_admin.",
    { url: `${base}/board-claim/${token}?code=${code}` },
  );
}
