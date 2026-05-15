import { createDb } from "@sentry-fixer-bot/db";
import { user } from "@sentry-fixer-bot/db/schema/auth";
import { env } from "@sentry-fixer-bot/env/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { LOCAL_BOARD_ID } from "./bootstrap-logic";
import { doctorVerdict } from "./doctor-logic";

export async function runStartupDoctor(opts?: {
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}): Promise<void> {
  const log =
    opts?.log ??
    ((m: string, c?: Record<string, unknown>) => console.log(`[doctor] ${m}`, c ?? ""));
  const db = createDb();

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user)
    .where(and(eq(user.role, "instance_admin"), ne(user.id, LOCAL_BOARD_ID)));
  const realAdminCount = rows[0]?.count ?? 0;

  const error = doctorVerdict({
    deploymentMode: env.DEPLOYMENT_MODE,
    bind: env.SERVER_BIND,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    bootstrapAdminEmail: env.SFB_BOOTSTRAP_ADMIN_EMAIL,
    realAdminCount,
  });

  if (error) {
    log("startup-doctor failed", { error });
    throw new Error(error);
  }

  log("startup-doctor passed", { mode: env.DEPLOYMENT_MODE, bind: env.SERVER_BIND });
}
