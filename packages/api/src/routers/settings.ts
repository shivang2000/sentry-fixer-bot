import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../index";
import { hasEnvSecret, setEnvSecret } from "../secrets/env-file";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "SENTRY_WEBHOOK_SECRET",
  "SENTRY_API_TOKEN",
  "SENTRY_ORG_SLUG",
] as const;

type SettingsKey = (typeof KEYS)[number];

const KeySchema = z.enum(KEYS);

export const settingsRouter = router({
  status: adminProcedure.query(() => {
    const out: Record<SettingsKey, boolean> = {} as Record<SettingsKey, boolean>;
    for (const k of KEYS) out[k] = hasEnvSecret(k);
    return out;
  }),

  setSecret: adminProcedure
    .input(z.object({ key: KeySchema, value: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await setEnvSecret(input.key, input.value);
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "set_secret_failed",
        });
      }
      return { ok: true };
    }),
});
