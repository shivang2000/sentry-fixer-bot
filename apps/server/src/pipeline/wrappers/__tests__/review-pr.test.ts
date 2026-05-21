/**
 * Unit tests for review-pr wrapper. Verifies:
 *   - skipIf true when cfg.toggles.autoReview = false.
 *   - skipIf false when autoReview = true.
 *   - run() invokes runReviewerFn and writes ctx.review.
 *   - Skips silently when workspace or alert or agent_output is missing.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import {
  MemoryCtxStore,
  makeCfg,
  makeLogRecorder,
  SAMPLE_ALERT,
  silentLogger,
} from "../../__tests__/fixtures";
import { runReviewPrStep, skipReviewPrIf } from "../review-pr";

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
    appendLog: makeLogRecorder().appendLog,
  };
}

describe("review-pr wrapper", () => {
  it("skipIf true when autoReview is false (default auto_fix preset)", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipReviewPrIf(ctx, makeCfg())).toBe(true);
  });

  it("skipIf false when autoReview is true (auto_fix_review preset)", async () => {
    const ctx = new MemoryCtxStore("run-2");
    expect(
      await skipReviewPrIf(
        ctx,
        makeCfg({
          toggles: { autoReview: true, followUpLoop: false, secretScanStrict: "block" },
        }),
      ),
    ).toBe(false);
  });

  it("writes ctx.review when prerequisites are present", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("agent_output", {
      summary: "fixed",
      problem: "",
      hypotheses: "",
      fix: "",
      confidence: "high",
      risk: "low",
      severity: "medium",
      exitCode: 0,
      attempts: 1,
    });
    await runReviewPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      runId: "run-3",
      runReviewerFn: async () => ({
        verdict: "blocker",
        body: "found issues",
        exitCode: 0,
        durationMs: 10,
      }),
    });
    const review = (await ctx.read("review")) as { verdict: string; body: string };
    expect(review.verdict).toBe("blocker");
    expect(review.body).toBe("found issues");
  });

  it("no-op when ctx.workspace is missing", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await runReviewPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      runId: "run-4",
      runReviewerFn: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await ctx.exists("review")).toBe(false);
  });

  it("no-op when agent_output is missing", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await ctx.write("workspace", { dir: "/w", branch: "b", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    await runReviewPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      runId: "run-5",
      runReviewerFn: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await ctx.exists("review")).toBe(false);
  });
});
