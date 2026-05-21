import { z } from "zod";

export const DEFAULT_MODELS = {
  classify: "claude-haiku-4-5-20251001",
  fix: "claude-opus-4-7",
  review: "claude-sonnet-4-6",
  followUp: "claude-sonnet-4-6",
} as const;

const DEFAULT_TOGGLES = {
  autoReview: false,
  followUpLoop: false,
  secretScanStrict: "block",
} as const;

const DEFAULT_BUDGET = {
  dailyTokens: 1_000_000,
  dailyCostCents: 2500,
} as const;

export const TriggerConfigSchema = z
  .object({
    toggles: z
      .object({
        autoReview: z.boolean().default(false),
        followUpLoop: z.boolean().default(false),
        secretScanStrict: z.enum(["block", "warn"]).default("block"),
      })
      .default(DEFAULT_TOGGLES),
    models: z
      .object({
        classify: z.string().default(DEFAULT_MODELS.classify),
        fix: z.string().default(DEFAULT_MODELS.fix),
        review: z.string().default(DEFAULT_MODELS.review),
        followUp: z.string().default(DEFAULT_MODELS.followUp),
      })
      .default(DEFAULT_MODELS),
    budget: z
      .object({
        dailyTokens: z.number().int().positive().default(1_000_000),
        dailyCostCents: z.number().int().nonnegative().default(2500),
      })
      .default(DEFAULT_BUDGET),
    sourceConfig: z.record(z.string(), z.unknown()).default({}),
  })
  .default({
    toggles: DEFAULT_TOGGLES,
    models: DEFAULT_MODELS,
    budget: DEFAULT_BUDGET,
    sourceConfig: {},
  });

export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

export const PresetEnum = z.enum(["triage_only", "auto_fix", "auto_fix_review", "custom"]);
// NOTE: the canonical TS `Preset` type lives in ./types so that consumers
// can use it without pulling zod into their type graph.
