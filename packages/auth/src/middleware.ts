import { env } from "@alertforge/env/server";
import type { Context, Next } from "hono";
import { LOCAL_BOARD_EMAIL, LOCAL_BOARD_ID } from "./bootstrap-logic";
import { auth } from "./index";
import { checkRole } from "./middleware-logic";

export type SessionUser = {
  id: string;
  email: string;
  role: "instance_admin" | "member";
};

declare module "hono" {
  interface ContextVariableMap {
    sfbUser?: SessionUser;
  }
}

/**
 * Resolves the session user for a request.
 * - In `local_trusted` mode every request is the local-board admin.
 * - In `authenticated` mode the Better-Auth session cookie is required.
 * Returns null on unauthenticated requests (handler decides whether to 401).
 */
export async function resolveSessionUser(headers: Headers): Promise<SessionUser | null> {
  if (env.DEPLOYMENT_MODE === "local_trusted") {
    return { id: LOCAL_BOARD_ID, email: LOCAL_BOARD_EMAIL, role: "instance_admin" };
  }
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  const role =
    (session.user as { role?: string }).role === "instance_admin" ? "instance_admin" : "member";
  return { id: session.user.id, email: session.user.email, role };
}

/**
 * Hono middleware: attach the resolved user to ctx.sfbUser (or 401 if absent).
 */
export async function authMiddleware(c: Context, next: Next) {
  const user = await resolveSessionUser(c.req.raw.headers);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("sfbUser", user);
  await next();
}

export function requireRole(role: "instance_admin" | "member") {
  return async (c: Context, next: Next) => {
    const user = c.get("sfbUser");
    const result = checkRole({ required: role, actual: user?.role ?? null });
    if (result === "unauthorized") return c.json({ error: "unauthorized" }, 401);
    if (result === "forbidden") return c.json({ error: "forbidden" }, 403);
    await next();
  };
}
