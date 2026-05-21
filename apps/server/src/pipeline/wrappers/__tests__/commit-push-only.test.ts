/**
 * Unit tests for commit-push-only wrapper. Verifies:
 *   - skipIf true when cfg.stopAfter='budget' or terminated or no workspace.
 *   - When tests passed + dirty tree: runs add + commit + push.
 *   - When tests passed + clean tree: outcome=no_diff, no commit.
 *   - When tests failed: outcome=tests_failed, no commit.
 *   - When secret_scan.blocked: outcome=secret_blocked.
 *   - When agent_output.exitCode != 0: outcome=agent_failed.
 *   - Captures git diff into ctx.diff on successful push.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, makeLogRecorder, silentLogger } from "../../__tests__/fixtures";
import {
  type CommitPushOnlyHandle,
  runCommitPushOnlyStep,
  skipCommitPushOnlyIfFactory,
  wrapCommitPushOnlyStep,
} from "../commit-push-only";

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
    resolveToken: async () => "token-xyz",
  };
}

describe("commit-push-only wrapper", () => {
  it("skipIf true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("r1");
    const skip = skipCommitPushOnlyIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("skipIf true when terminated", async () => {
    const ctx = new MemoryCtxStore("r2");
    const skip = skipCommitPushOnlyIfFactory({ terminated: true });
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("skipIf true when workspace is missing", async () => {
    const ctx = new MemoryCtxStore("r3");
    const skip = skipCommitPushOnlyIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("dirty tree → runs add + commit + push; outcome.pushed=true", async () => {
    const ctx = new MemoryCtxStore("r4");
    await ctx.write("workspace", { dir: "/w", branch: "sfb/r-orig", baseBranch: "" });
    await ctx.write("agent_output", { exitCode: 0 });
    await ctx.write("test_result", { passed: true });
    await ctx.write("secret_scan", { findings: [], blocked: false });
    await ctx.write("instruction", {
      body: "/sfb add a check",
      author: "alice",
      commentId: "c1",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const handle: CommitPushOnlyHandle = {};
    const calls: string[] = [];
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async (argv) => {
        calls.push(argv.join(" "));
        if (argv.join(" ").includes("status --porcelain")) {
          return { exitCode: 0, stdout: "M file.ts\n", stderr: "" };
        }
        if (argv.join(" ").includes("diff HEAD")) {
          return { exitCode: 0, stdout: "diff text", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(handle.outcome?.pushed).toBe(true);
    expect(calls.some((c) => c.includes("status --porcelain"))).toBe(true);
    expect(calls.some((c) => c.includes("git add"))).toBe(true);
    expect(calls.some((c) => c.includes("commit"))).toBe(true);
    expect(calls.some((c) => c.includes("push"))).toBe(true);
    // Verify the commit message embeds the reviewer + stripped instruction.
    const commitCall = calls.find((c) => c.includes("commit"));
    expect(commitCall).toContain("alice");
    expect(commitCall).toContain("add a check");
    // Verify diff captured.
    expect(await ctx.read<string>("diff")).toBe("diff text");
  });

  it("clean tree → outcome.reason=no_diff, no commit", async () => {
    const ctx = new MemoryCtxStore("r5");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("agent_output", { exitCode: 0 });
    await ctx.write("test_result", { passed: true });
    const handle: CommitPushOnlyHandle = {};
    const calls: string[] = [];
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async (argv) => {
        calls.push(argv.join(" "));
        if (argv.join(" ").includes("status --porcelain")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(handle.outcome?.pushed).toBe(false);
    expect(handle.outcome?.reason).toBe("no_diff");
    expect(calls.some((c) => c.includes("commit"))).toBe(false);
    expect(calls.some((c) => c.includes("push"))).toBe(false);
  });

  it("test_result.passed=false → outcome.reason=tests_failed", async () => {
    const ctx = new MemoryCtxStore("r6");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("agent_output", { exitCode: 0 });
    await ctx.write("test_result", { passed: false });
    const handle: CommitPushOnlyHandle = {};
    let called = false;
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async () => {
        called = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    expect(handle.outcome?.pushed).toBe(false);
    expect(handle.outcome?.reason).toBe("tests_failed");
    expect(called).toBe(false);
  });

  it("secret_scan.blocked → outcome.reason=secret_blocked", async () => {
    const ctx = new MemoryCtxStore("r7");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("agent_output", { exitCode: 0 });
    await ctx.write("test_result", { passed: true });
    await ctx.write("secret_scan", {
      findings: [{ file: "f.ts", line: 1, pattern: "x" }],
      blocked: true,
    });
    const handle: CommitPushOnlyHandle = {};
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async () => {
        throw new Error("should not be called");
      },
    });
    expect(handle.outcome?.reason).toBe("secret_blocked");
  });

  it("agent_output.exitCode != 0 → outcome.reason=agent_failed", async () => {
    const ctx = new MemoryCtxStore("r8");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("agent_output", { exitCode: 137 });
    const handle: CommitPushOnlyHandle = {};
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async () => {
        throw new Error("should not be called");
      },
    });
    expect(handle.outcome?.reason).toBe("agent_failed");
  });

  it("no workspace → outcome.reason=terminated", async () => {
    const ctx = new MemoryCtxStore("r9");
    const handle: CommitPushOnlyHandle = {};
    await runCommitPushOnlyStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: handle,
      runScriptedCommand: async () => {
        throw new Error("should not be called");
      },
    });
    expect(handle.outcome?.reason).toBe("terminated");
  });

  it("wrapCommitPushOnlyStep returns the right PipelineStep", () => {
    const step = wrapCommitPushOnlyStep({
      prGuardHandle: { terminated: false },
      outcomeHandle: {},
    });
    expect(step.name).toBe("commit-push-only");
    expect(step.skipIf).toBeDefined();
  });
});
