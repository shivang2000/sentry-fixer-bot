/**
 * Unit tests for commit-push wrapper. Per the wrapper's module-level
 * decision note, this step's job is just to capture the diff;
 * actual git commit/push happens inside open-pr's bundled flow.
 *
 * Verifies:
 *   - skipIf true when cfg.stopAfter='budget'.
 *   - skipIf true when ctx.workspace is missing.
 *   - run() invokes git diff via runScriptedCommand and writes ctx.diff.
 *   - When agent_output.exitCode != 0, the step bails out (no diff).
 *   - When the origin/branch diff is empty, falls back to HEAD diff.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, silentLogger } from "../../__tests__/fixtures";
import { runCommitPushStep, skipCommitPushIf } from "../commit-push";

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

describe("commit-push wrapper", () => {
  it("skipIf true when stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipCommitPushIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("skipIf true when workspace is missing", async () => {
    const ctx = new MemoryCtxStore("run-2");
    expect(await skipCommitPushIf(ctx, makeCfg())).toBe(true);
  });

  it("captures origin/branch diff into ctx.diff", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    let calls = 0;
    await runCommitPushStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async (argv) => {
        calls++;
        // First call: origin/main diff.
        if (argv.join(" ").includes("origin/main")) {
          return { exitCode: 0, stdout: "diff text here", stderr: "" };
        }
        return { exitCode: 0, stdout: "fallback diff", stderr: "" };
      },
    });
    expect(calls).toBe(1);
    expect(await ctx.read<string>("diff")).toBe("diff text here");
  });

  it("falls back to HEAD diff when origin/branch diff is empty", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await runCommitPushStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async (argv) => {
        if (argv.join(" ").includes("origin/main")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "head diff", stderr: "" };
      },
    });
    expect(await ctx.read<string>("diff")).toBe("head diff");
  });

  it("bails when agent_output.exitCode != 0", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("agent_output", { exitCode: 137 });
    await runCommitPushStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await ctx.exists("diff")).toBe(false);
  });
});
