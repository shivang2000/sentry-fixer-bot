import { describe, expect, it } from "bun:test";
import { resolvePreset } from "./preset";
import type { TriggerRow } from "./types";

function baseTrigger(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: "trigger-1",
    repoId: "repo-1",
    sourceType: "sentry",
    sourceProject: "backend-api",
    name: "Sentry → backend-api",
    enabled: true,
    preset: "auto_fix",
    config: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("resolvePreset", () => {
  it("triage_only sets stopAfter='budget' and forces both toggles off", () => {
    const cfg = resolvePreset(
      baseTrigger({
        preset: "triage_only",
        config: { toggles: { autoReview: true, followUpLoop: true, secretScanStrict: "warn" } },
      }),
    );
    expect(cfg.stopAfter).toBe("budget");
    expect(cfg.toggles.autoReview).toBe(false);
    expect(cfg.toggles.followUpLoop).toBe(false);
    expect(cfg.toggles.secretScanStrict).toBe("warn"); // not overridden by preset
  });

  it("auto_fix forces both toggles off, no stopAfter", () => {
    const cfg = resolvePreset(
      baseTrigger({
        preset: "auto_fix",
        config: { toggles: { autoReview: true, followUpLoop: true, secretScanStrict: "block" } },
      }),
    );
    expect(cfg.stopAfter).toBeUndefined();
    expect(cfg.toggles.autoReview).toBe(false);
    expect(cfg.toggles.followUpLoop).toBe(false);
  });

  it("auto_fix_review forces autoReview on, followUpLoop off", () => {
    const cfg = resolvePreset(baseTrigger({ preset: "auto_fix_review" }));
    expect(cfg.stopAfter).toBeUndefined();
    expect(cfg.toggles.autoReview).toBe(true);
    expect(cfg.toggles.followUpLoop).toBe(false);
  });

  it("custom honors all input toggles as-set", () => {
    const cfg = resolvePreset(
      baseTrigger({
        preset: "custom",
        config: { toggles: { autoReview: true, followUpLoop: true, secretScanStrict: "warn" } },
      }),
    );
    expect(cfg.stopAfter).toBeUndefined();
    expect(cfg.toggles.autoReview).toBe(true);
    expect(cfg.toggles.followUpLoop).toBe(true);
    expect(cfg.toggles.secretScanStrict).toBe("warn");
  });

  it("custom preserves model picks from input config", () => {
    const cfg = resolvePreset(
      baseTrigger({
        preset: "custom",
        config: {
          models: {
            classify: "claude-sonnet-4-6",
            fix: "claude-opus-4-7",
            review: "claude-haiku-4-5-20251001",
            followUp: "claude-sonnet-4-6",
          },
        },
      }),
    );
    expect(cfg.models.classify).toBe("claude-sonnet-4-6");
    expect(cfg.models.review).toBe("claude-haiku-4-5-20251001");
  });

  it("applies default models when config omits them", () => {
    const cfg = resolvePreset(baseTrigger({ preset: "auto_fix", config: {} }));
    expect(cfg.models.classify).toBe("claude-haiku-4-5-20251001");
    expect(cfg.models.fix).toBe("claude-opus-4-7");
  });

  it("applies default budget when config omits it", () => {
    const cfg = resolvePreset(baseTrigger({ preset: "auto_fix", config: {} }));
    expect(cfg.budget.dailyTokens).toBe(1_000_000);
    expect(cfg.budget.dailyCostCents).toBe(2500);
  });
});
