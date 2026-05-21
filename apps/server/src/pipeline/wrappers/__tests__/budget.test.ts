/**
 * Unit tests for budget wrapper. Verifies:
 *   - allowed → ctx.budget.allowed=true and cfg.stopAfter is NOT mutated.
 *   - denied → ctx.budget.allowed=false and cfg.stopAfter='budget'.
 *   - default impl (no checkBudgetFn override) reads from cfg.budget.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, silentLogger } from "../../__tests__/fixtures";
import { runBudgetStep, wrapBudgetStep } from "../budget";

function makeDeps(): StepDeps {
  return {
    modelProvider: {
      name: "noop",
      async complete() {
        return "{}";
      },
    },
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels: new Map<string, ChannelAdapter>(),
  };
}

describe("budget wrapper", () => {
  it("allowed: writes ctx.budget.allowed=true, leaves cfg.stopAfter untouched", async () => {
    const ctx = new MemoryCtxStore("run-1");
    const cfg = makeCfg();
    await runBudgetStep(ctx, cfg, makeDeps(), {
      repo: "acme/api",
      checkBudgetFn: async () => ({ allowed: true }),
    });
    expect(await ctx.read<{ allowed: boolean }>("budget")).toEqual({ allowed: true });
    expect(cfg.stopAfter).toBeUndefined();
  });

  it("denied: writes ctx.budget.allowed=false and sets cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-2");
    const cfg = makeCfg();
    await runBudgetStep(ctx, cfg, makeDeps(), {
      repo: "acme/api",
      checkBudgetFn: async () => ({ allowed: false, reason: "tokens_exceeded" }),
    });
    expect(await ctx.read<{ allowed: boolean; reason: string }>("budget")).toEqual({
      allowed: false,
      reason: "tokens_exceeded",
    });
    expect(cfg.stopAfter).toBe("budget");
  });

  it("default impl falls back to cfg.budget caps", async () => {
    const ctx = new MemoryCtxStore("run-3");
    const cfg = makeCfg({ budget: { dailyTokens: 0, dailyCostCents: 0 } });
    await runBudgetStep(ctx, cfg, makeDeps(), { repo: "acme/api" });
    // 0 cap with 0 used → tokens_exceeded since 0 >= 0
    const budget = (await ctx.read("budget")) as { allowed: boolean };
    expect(budget.allowed).toBe(false);
    expect(cfg.stopAfter).toBe("budget");
  });

  it("wrapBudgetStep returns the correct PipelineStep", () => {
    const step = wrapBudgetStep({ repo: "acme/api" });
    expect(step.name).toBe("budget");
    expect(step.skipIf).toBeUndefined();
  });
});
