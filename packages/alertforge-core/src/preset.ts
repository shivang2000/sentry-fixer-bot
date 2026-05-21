import { TriggerConfigSchema } from "./config.schema";
import type { ResolvedConfig, TriggerRow } from "./types";

export function resolvePreset(trigger: TriggerRow): ResolvedConfig {
  const base = TriggerConfigSchema.parse(trigger.config);
  switch (trigger.preset) {
    case "triage_only":
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: false, followUpLoop: false },
        stopAfter: "budget",
      };
    case "auto_fix":
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: false, followUpLoop: false },
      };
    case "auto_fix_review":
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: true, followUpLoop: false },
      };
    case "custom":
      return base;
    default: {
      const _exhaustive: never = trigger.preset;
      throw new Error(`Unknown preset: ${_exhaustive as string}`);
    }
  }
}
