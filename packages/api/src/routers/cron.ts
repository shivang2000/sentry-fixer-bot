import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { adminProcedure, protectedProcedure, router } from "../index";

export type Preset = "never" | "15m" | "30m" | "1h" | "4h" | "1d";

export const PRESET_TO_CRON: Record<Exclude<Preset, "never">, string> = {
  "15m": "*/15 * * * *",
  "30m": "*/30 * * * *",
  "1h": "0 * * * *",
  "4h": "0 */4 * * *",
  "1d": "0 0 * * *",
};

export const PRESET_LOOKBACK_MINUTES: Record<Exclude<Preset, "never">, number> = {
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

export function cronToPreset(cron: string | null): Preset {
  if (!cron) return "never";
  for (const [preset, expr] of Object.entries(PRESET_TO_CRON)) {
    if (expr === cron) return preset as Preset;
  }
  return "never";
}

// The api package can't import apps/server, but the cron router needs to
// talk to pg-boss. We do it directly via the `pg-boss` module so api stays
// self-contained. Mirrors the boss singleton in apps/server.
import { PgBoss } from "pg-boss";

let boss: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  // Lazy import so the test runner can load this module without DATABASE_URL.
  const { env } = await import("@alertforge/env/server");
  boss = new PgBoss({ connectionString: env.DATABASE_URL });
  await boss.start();
  return boss;
}

const ALLOWED_NAMES = ["sentry-poll", "health-check"] as const;
type CronName = (typeof ALLOWED_NAMES)[number];
const NameInput = z.enum(ALLOWED_NAMES);

const SetInput = z.object({
  name: NameInput,
  preset: z.enum(["never", "15m", "30m", "1h", "4h", "1d"]),
  lookbackMinutes: z.number().int().positive().optional(),
});

type ScheduleRow = {
  name: string;
  cron: string;
  data: unknown;
};

export const cronRouter = router({
  list: protectedProcedure.query(async () => {
    const b = await getBoss();
    const schedules = (await b.getSchedules()) as ScheduleRow[];
    const out: Array<{
      name: CronName;
      enabled: boolean;
      preset: Preset;
      cron: string | null;
      lookbackMinutes: number | null;
    }> = [];
    for (const name of ALLOWED_NAMES) {
      const row = schedules.find((s) => s.name === name);
      const cron = row?.cron ?? null;
      const data = (row?.data ?? {}) as { lookbackMinutes?: number };
      out.push({
        name,
        enabled: !!cron,
        preset: cronToPreset(cron),
        cron,
        lookbackMinutes:
          name === "sentry-poll"
            ? (data.lookbackMinutes ??
              (cron
                ? (PRESET_LOOKBACK_MINUTES[cronToPreset(cron) as Exclude<Preset, "never">] ?? null)
                : null))
            : null,
      });
    }
    return out;
  }),

  setSchedule: adminProcedure.input(SetInput).mutation(async ({ input }) => {
    const b = await getBoss();
    if (input.preset === "never") {
      await b.unschedule(input.name);
      return { ok: true, enabled: false } as const;
    }
    const cron = PRESET_TO_CRON[input.preset];
    const lookback =
      input.name === "sentry-poll"
        ? (input.lookbackMinutes ?? PRESET_LOOKBACK_MINUTES[input.preset])
        : undefined;
    await b.schedule(input.name, cron, lookback ? { lookbackMinutes: lookback } : {});
    return { ok: true, enabled: true, cron, lookbackMinutes: lookback } as const;
  }),

  runNow: adminProcedure.input(z.object({ name: NameInput })).mutation(async ({ input }) => {
    const b = await getBoss();
    const id = await b.send(input.name, {});
    if (!id) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "publish_failed" });
    }
    return { ok: true as const, jobId: id };
  }),
});
