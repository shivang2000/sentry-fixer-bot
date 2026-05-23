/**
 * Unit tests for pr-followup-comment wrapper. Verifies:
 *   - skipIf true when budget-blocked or terminated.
 *   - outcome.pushed=true → markPrReady (when isDraft) + applied
 *     comment.
 *   - outcome.reason=tests_failed → no markPrReady; failure comment
 *     surfacing the tail.
 *   - outcome.reason=secret_blocked → secret-finding comment.
 *   - outcome.reason=agent_failed → agent-exit comment.
 *   - outcome.reason=no_diff → no-diff comment.
 *   - outcome.reason=terminated → NO comment posted (pr-guard owns
 *     the closed-PR no-op message).
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, makeLogRecorder, silentLogger } from "../../__tests__/fixtures";
import {
  runPrFollowupCommentStep,
  skipPrFollowupCommentIfFactory,
  wrapPrFollowupCommentStep,
} from "../pr-followup-comment";

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

function makePrTarget(overrides: Partial<{ isDraft: boolean; number: number }> = {}) {
  return {
    repo: "acme/api",
    number: overrides.number ?? 42,
    branch: "alertforge/r",
    url: `https://github.com/acme/api/pull/${overrides.number ?? 42}`,
    isDraft: overrides.isDraft ?? true,
    needsHuman: false,
  };
}

describe("pr-followup-comment wrapper", () => {
  it("skipIf true when stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("r1");
    const skip = skipPrFollowupCommentIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("skipIf true when terminated", async () => {
    const ctx = new MemoryCtxStore("r2");
    const skip = skipPrFollowupCommentIfFactory({ terminated: true });
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("outcome.pushed=true on draft PR → markPrReady + applied comment", async () => {
    const ctx = new MemoryCtxStore("r3");
    await ctx.write("pr", makePrTarget({ isDraft: true }));
    await ctx.write("instruction", {
      body: "/alertforge apply fix",
      author: "alice",
      commentId: "c1",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const readyCalls: Array<{ repo: string; prNumber: number }> = [];
    const commentCalls: Array<{ repo: string; prNumber: number; body: string }> = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: true } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async (i) => {
        readyCalls.push(i);
        return 0;
      },
    });
    expect(readyCalls).toHaveLength(1);
    expect(readyCalls[0]).toEqual({ repo: "acme/api", prNumber: 42 });
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.body).toContain("alice");
    expect(commentCalls[0]?.body).toContain("apply fix");
    expect(commentCalls[0]?.body).toMatch(/applied|pushed/i);
  });

  it("outcome.pushed=true on ready PR → no markPrReady, still comments", async () => {
    const ctx = new MemoryCtxStore("r4");
    await ctx.write("pr", makePrTarget({ isDraft: false }));
    await ctx.write("instruction", {
      body: "/alertforge x",
      author: "alice",
      commentId: "c2",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const readyCalls: unknown[] = [];
    const commentCalls: unknown[] = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: true } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async (i) => {
        readyCalls.push(i);
        return 0;
      },
    });
    expect(readyCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(1);
  });

  it("outcome.reason=tests_failed → failure comment with stderr tail", async () => {
    const ctx = new MemoryCtxStore("r5");
    await ctx.write("pr", makePrTarget());
    await ctx.write("instruction", {
      body: "/alertforge x",
      author: "alice",
      commentId: "c3",
      createdAt: "2026-05-21T00:00:00Z",
    });
    await ctx.write("test_result", {
      passed: false,
      command: "npm test",
      stdoutTail: "",
      stderrTail: "FAIL: src/foo.test.ts",
      attempts: 3,
    });
    const readyCalls: unknown[] = [];
    const commentCalls: Array<{ body: string }> = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: false, reason: "tests_failed" } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async (i) => {
        readyCalls.push(i);
        return 0;
      },
    });
    expect(readyCalls).toHaveLength(0);
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.body).toContain("npm test");
    expect(commentCalls[0]?.body).toContain("FAIL: src/foo.test.ts");
  });

  it("outcome.reason=secret_blocked → secret-finding comment", async () => {
    const ctx = new MemoryCtxStore("r6");
    await ctx.write("pr", makePrTarget());
    await ctx.write("instruction", {
      body: "/alertforge x",
      author: "a",
      commentId: "c4",
      createdAt: "2026-05-21T00:00:00Z",
    });
    await ctx.write("secret_scan", {
      findings: [{ file: "f.ts", line: 1, pattern: "aws_access_key" }],
      blocked: true,
    });
    const commentCalls: Array<{ body: string }> = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: false, reason: "secret_blocked" } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async () => 0,
    });
    expect(commentCalls[0]?.body).toMatch(/secret/i);
  });

  it("outcome.reason=agent_failed → agent-exit comment", async () => {
    const ctx = new MemoryCtxStore("r7");
    await ctx.write("pr", makePrTarget());
    await ctx.write("instruction", {
      body: "/alertforge foo",
      author: "a",
      commentId: "c5",
      createdAt: "2026-05-21T00:00:00Z",
    });
    await ctx.write("agent_output", { exitCode: 137 });
    const commentCalls: Array<{ body: string }> = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: false, reason: "agent_failed" } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async () => 0,
    });
    expect(commentCalls[0]?.body).toContain("137");
    expect(commentCalls[0]?.body).toContain("foo");
  });

  it("outcome.reason=no_diff → no-diff comment", async () => {
    const ctx = new MemoryCtxStore("r8");
    await ctx.write("pr", makePrTarget());
    await ctx.write("instruction", {
      body: "/alertforge x",
      author: "a",
      commentId: "c6",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const commentCalls: Array<{ body: string }> = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: false, reason: "no_diff" } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async () => 0,
    });
    expect(commentCalls[0]?.body).toMatch(/no diff|no\s+diff|didn.?t produce/i);
  });

  it("outcome.reason=terminated → no comment posted", async () => {
    const ctx = new MemoryCtxStore("r9");
    await ctx.write("pr", makePrTarget());
    const commentCalls: unknown[] = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: false, reason: "terminated" } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async () => 0,
    });
    expect(commentCalls).toHaveLength(0);
  });

  it("ctx.pr missing → no comment posted", async () => {
    const ctx = new MemoryCtxStore("r10");
    const commentCalls: unknown[] = [];
    await runPrFollowupCommentStep(ctx, makeCfg(), makeDeps(), {
      prGuardHandle: { terminated: false },
      outcomeHandle: { outcome: { pushed: true } },
      commentOnPrFn: async (i) => {
        commentCalls.push(i);
        return null;
      },
      markPrReadyFn: async () => 0,
    });
    expect(commentCalls).toHaveLength(0);
  });

  it("wrapPrFollowupCommentStep returns the right PipelineStep", () => {
    const step = wrapPrFollowupCommentStep({
      prGuardHandle: { terminated: false },
      outcomeHandle: {},
      commentOnPrFn: async () => null,
      markPrReadyFn: async () => 0,
    });
    expect(step.name).toBe("pr-followup-comment");
    expect(step.skipIf).toBeDefined();
  });
});
