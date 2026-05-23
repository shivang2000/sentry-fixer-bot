import { auth } from "@alertforge/auth";
import { LOCAL_BOARD_EMAIL, LOCAL_BOARD_ID } from "@alertforge/auth/bootstrap-logic";
import { env } from "@alertforge/env/server";
import type { Context as HonoContext } from "hono";

export type CreateContextOptions = {
  context: HonoContext;
};

export type SessionUser = {
  id: string;
  email: string;
  role: "instance_admin" | "member";
};

export async function createContext({ context }: CreateContextOptions) {
  if (env.DEPLOYMENT_MODE === "local_trusted") {
    const user: SessionUser = {
      id: LOCAL_BOARD_ID,
      email: LOCAL_BOARD_EMAIL,
      role: "instance_admin",
    };
    return { user, session: null };
  }
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  const u = session?.user;
  const user: SessionUser | null = u
    ? {
        id: u.id,
        email: u.email,
        role: (u as { role?: string }).role === "instance_admin" ? "instance_admin" : "member",
      }
    : null;
  return { user, session };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
