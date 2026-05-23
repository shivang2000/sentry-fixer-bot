import { registry } from "@alertforge/core";
import { createDb } from "@alertforge/db";
import { channelConfigs, triggers } from "@alertforge/db/schema/triggers";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, router } from "../index";
import { describeZodObject, type SchemaShape } from "./describe-schema";

export type { SchemaShape };

// V1: Slack + email scaffolds land in P5; the type whitelist expands
// as adapter packages are added. Until then the router accepts any
// non-empty string so a future Slack adapter can wire up without a
// schema change here.
const ChannelTypeSchema = z.string().min(1);

const NotifyOnSchema = z
  .array(z.enum(["pr_opened", "triage_only", "failed", "budget_blocked", "duplicate_pr", "digest"]))
  .min(1);

const CreateInput = z.object({
  triggerId: z.string().uuid(),
  channelType: ChannelTypeSchema,
  notifyOn: NotifyOnSchema.default(["pr_opened", "failed"]),
  config: z.record(z.string(), z.unknown()),
});

const UpdateInput = z.object({
  id: z.string().uuid(),
  enabled: z.boolean().optional(),
  notifyOn: NotifyOnSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const channelsRouter = router({
  /**
   * List every channel_configs row for a given trigger. Ordered by
   * createdAt desc so newest channels appear first on the trigger
   * detail page.
   */
  list: adminProcedure
    .input(z.object({ triggerId: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = createDb();
      return db
        .select()
        .from(channelConfigs)
        .where(eq(channelConfigs.triggerId, input.triggerId))
        .orderBy(desc(channelConfigs.createdAt));
    }),

  byId: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const db = createDb();
    const rows = await db
      .select()
      .from(channelConfigs)
      .where(eq(channelConfigs.id, input.id))
      .limit(1);
    return rows[0] ?? null;
  }),

  create: adminProcedure.input(CreateInput).mutation(async ({ input }) => {
    const db = createDb();

    // FK exists already, but a friendly error beats a Postgres
    // constraint violation surfacing through the UI.
    const triggerRows = await db
      .select({ id: triggers.id })
      .from(triggers)
      .where(eq(triggers.id, input.triggerId))
      .limit(1);
    if (!triggerRows[0]) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "unknown_trigger_id" });
    }

    const inserted = await db
      .insert(channelConfigs)
      .values({
        triggerId: input.triggerId,
        channelType: input.channelType,
        notifyOn: input.notifyOn,
        config: input.config,
      })
      .returning();
    return inserted[0];
  }),

  update: adminProcedure.input(UpdateInput).mutation(async ({ input }) => {
    const db = createDb();
    const updated = await db
      .update(channelConfigs)
      .set({
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.notifyOn !== undefined && { notifyOn: input.notifyOn }),
        ...(input.config !== undefined && { config: input.config }),
      })
      .where(eq(channelConfigs.id, input.id))
      .returning();
    if (!updated[0]) {
      throw new TRPCError({ code: "NOT_FOUND", message: "channel_config_not_found" });
    }
    return updated[0];
  }),

  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const db = createDb();
    await db.delete(channelConfigs).where(eq(channelConfigs.id, input.id));
    return { ok: true as const };
  }),

  /**
   * Catalog of registered channel adapters with their configSchema
   * walked into a serializable shape the UI can render as a dynamic
   * form via RegistryConfigForm. Sourced from the singleton registry
   * populated at apps/server boot.
   *
   * requiresEnvKeysPresent maps env-key → boolean(process.env present)
   * so the UI can flag "Resend API key missing" before the user picks
   * the channel.
   */
  listAdapters: adminProcedure.query(() => {
    const out = [] as Array<{
      type: string;
      displayName: string;
      catalogEntry: {
        description: string;
        setupGuide: string;
        requiresEnvKeys: string[];
      };
      requiresEnvKeysPresent: Record<string, boolean>;
      configSchema: SchemaShape;
    }>;
    for (const adapter of registry.channels.values()) {
      out.push({
        type: adapter.type,
        displayName: adapter.displayName,
        catalogEntry: { ...adapter.catalogEntry },
        requiresEnvKeysPresent: Object.fromEntries(
          adapter.catalogEntry.requiresEnvKeys.map((k) => [k, !!process.env[k]]),
        ),
        configSchema: describeZodObject(adapter.configSchema),
      });
    }
    return out;
  }),
});
