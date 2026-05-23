import { createDb } from "@alertforge/db";
import { mcpInstalls, mcpSecrets } from "@alertforge/db/schema/admin";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../index";
import { CATALOG } from "../mcps-catalog";
import { setEnvSecret } from "../secrets/env-file";

const InstallInput = z.object({
  catalogId: z.string(),
  scope: z.enum(["global", "repo"]),
  repo: z.string().optional(),
  envValues: z.record(z.string(), z.string()),
});

export const mcpsRouter = router({
  catalog: protectedProcedure.query(() => CATALOG),

  installed: protectedProcedure.query(async () => {
    const db = createDb();
    return db.select().from(mcpInstalls).orderBy(mcpInstalls.createdAt);
  }),

  install: adminProcedure.input(InstallInput).mutation(async ({ input, ctx }) => {
    const entry = CATALOG.find((c) => c.id === input.catalogId);
    if (!entry) throw new Error("unknown_catalog_id");
    if (input.scope === "repo" && !input.repo) throw new Error("repo_required_for_repo_scope");

    const db = createDb();
    const envKeys = Object.keys(entry.envSchema);

    // Persist secret env values via the env-file writer; record metadata in mcp_secrets
    for (const [k, v] of Object.entries(input.envValues)) {
      const spec = entry.envSchema[k];
      if (!spec?.secret) continue;
      await setEnvSecret(k, v);
      await db
        .insert(mcpSecrets)
        .values({
          envKey: k,
          description: spec.description,
          scopeHint: input.scope,
          setBy: ctx.user.id,
        })
        .onConflictDoUpdate({
          target: mcpSecrets.envKey,
          set: { setAt: new Date(), setBy: ctx.user.id },
        });
    }

    const inserted = await db
      .insert(mcpInstalls)
      .values({
        scope: input.scope,
        repo: input.repo ?? null,
        catalogId: entry.id,
        displayName: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.argsTemplate,
        envKeys,
        installedBy: ctx.user.id,
      })
      .returning();
    return inserted[0];
  }),

  uninstall: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = createDb();
      await db.delete(mcpInstalls).where(eq(mcpInstalls.id, input.id));
      return { ok: true };
    }),
});
