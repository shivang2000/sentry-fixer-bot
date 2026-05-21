/**
 * Unit tests for followup-fix-agent wrapper. Verifies:
 *   - skipIf true when cfg.stopAfter='budget' or prGuardHandle.terminated.
 *   - Renders the legacy followup prompt verbatim (stripSfbPrefix +
 *     `/sentry-cli` header + alert title + instruction body).
 *   - Single spawn when tests pass; multiple spawns when they fail
 *     until maxAttempts.
 *   - testRecorder side-channel populated with final state.
 *   - Throws when ctx.workspace or ctx.instruction is missing.
 *   - stripSfbPrefix strips `/sfb` prefix case-insensitively.
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
import type { TestRecorder } from "../fix-agent";
import {
  renderFollowupPrompt,
  runFollowupFixAgentStep,
  skipFollowupFixAgentIfFactory,
  stripSfbPrefix,
  wrapFollowupFixAgentStep,
} from "../followup-fix-agent";

function makeDeps(): StepDeps {
  const rec = makeLogRecorder();
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
    appendLog: rec.appendLog,
  };
}

const AGENT_STDOUT_OK =
  "<summary><problem>p</problem><hypotheses>H1</hypotheses><fix>f</fix><confidence>high</confidence><risk>low</risk><severity>medium</severity></summary>";

function emptyRecorder(): TestRecorder {
  return { command: null, passed: null, stdoutTail: "", stderrTail: "", attempts: 0 };
}

describe("followup-fix-agent wrapper", () => {
  it("skipIf true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("r1");
    const skip = skipFollowupFixAgentIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("skipIf true when prGuardHandle.terminated", async () => {
    const ctx = new MemoryCtxStore("r2");
    const skip = skipFollowupFixAgentIfFactory({ terminated: true });
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("single spawn when tests pass on first attempt", async () => {
    const ctx = new MemoryCtxStore("r3");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("instruction", {
      body: "/sfb add null check",
      author: "alice",
      commentId: "1",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const recorder = emptyRecorder();
    let spawnCount = 0;
    await runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "r3",
      testRecorder: recorder,
      prGuardHandle: { terminated: false },
      resolveTestCommandFn: async () => ({ command: "npm test", source: "detected" }),
      ensureDepsFn: async () => ({
        ran: true,
        command: "npm ci",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      }),
      runRepoTestsFn: async () => ({ passed: true, stdout: "ok", stderr: "" }),
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(1);
    expect(recorder.passed).toBe(true);
    expect(recorder.attempts).toBe(1);
    expect(recorder.command).toBe("npm test");
    const out = (await ctx.read("agent_output")) as { confidence: string };
    expect(out.confidence).toBe("high");
  });

  it("retries when tests fail, stops on success", async () => {
    const ctx = new MemoryCtxStore("r4");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("instruction", {
      body: "/sfb make it pass",
      author: "bob",
      commentId: "2",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const recorder = emptyRecorder();
    let testCount = 0;
    let spawnCount = 0;
    await runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "r4",
      testRecorder: recorder,
      prGuardHandle: { terminated: false },
      maxAttempts: 3,
      resolveTestCommandFn: async () => ({ command: "npm test", source: "detected" }),
      ensureDepsFn: async () => ({
        ran: false,
        command: null,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      runRepoTestsFn: async () => {
        testCount++;
        return { passed: testCount >= 2, stdout: "out", stderr: "err" };
      },
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(2);
    expect(recorder.attempts).toBe(2);
    expect(recorder.passed).toBe(true);
  });

  it("exhausts maxAttempts when tests never pass", async () => {
    const ctx = new MemoryCtxStore("r5");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("instruction", {
      body: "/sfb",
      author: "carol",
      commentId: "3",
      createdAt: "2026-05-21T00:00:00Z",
    });
    const recorder = emptyRecorder();
    let spawnCount = 0;
    await runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "r5",
      testRecorder: recorder,
      prGuardHandle: { terminated: false },
      maxAttempts: 3,
      resolveTestCommandFn: async () => ({ command: "npm test", source: "detected" }),
      ensureDepsFn: async () => ({
        ran: false,
        command: null,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      runRepoTestsFn: async () => ({ passed: false, stdout: "F", stderr: "x" }),
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(3);
    expect(recorder.passed).toBe(false);
    expect(recorder.attempts).toBe(3);
  });

  it("breaks the loop on non-zero agent exit", async () => {
    const ctx = new MemoryCtxStore("r6");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("instruction", {
      body: "/sfb x",
      author: "d",
      commentId: "4",
      createdAt: "2026-05-21T00:00:00Z",
    });
    let spawnCount = 0;
    await runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "r6",
      testRecorder: emptyRecorder(),
      prGuardHandle: { terminated: false },
      maxAttempts: 3,
      resolveTestCommandFn: async () => ({ command: "npm test", source: "detected" }),
      ensureDepsFn: async () => ({
        ran: false,
        command: null,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      runRepoTestsFn: async () => ({ passed: false, stdout: "", stderr: "" }),
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 137, stdout: "", stderr: "killed", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(1);
  });

  it("throws when ctx.workspace is missing", async () => {
    const ctx = new MemoryCtxStore("r7");
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("instruction", {
      body: "/sfb x",
      author: "d",
      commentId: "5",
      createdAt: "2026-05-21T00:00:00Z",
    });
    await expect(
      runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
        runId: "r7",
        testRecorder: emptyRecorder(),
        prGuardHandle: { terminated: false },
        spawnAgentFn: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      }),
    ).rejects.toThrow(/workspace/);
  });

  it("throws when ctx.instruction is missing", async () => {
    const ctx = new MemoryCtxStore("r8");
    await ctx.write("workspace", { dir: "/w", branch: "br", baseBranch: "" });
    await ctx.write("alert", SAMPLE_ALERT);
    await expect(
      runFollowupFixAgentStep(ctx, makeCfg(), makeDeps(), {
        runId: "r8",
        testRecorder: emptyRecorder(),
        prGuardHandle: { terminated: false },
        spawnAgentFn: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      }),
    ).rejects.toThrow(/instruction/);
  });

  it("stripSfbPrefix strips the /sfb prefix case-insensitively", () => {
    expect(stripSfbPrefix("/sfb foo")).toBe("foo");
    expect(stripSfbPrefix("/SFB foo")).toBe("foo");
    expect(stripSfbPrefix("   /sfb   bar  ")).toBe("bar");
    expect(stripSfbPrefix("no prefix")).toBe("no prefix");
  });

  it("renderFollowupPrompt embeds reviewer + alert + instruction", () => {
    const prompt = renderFollowupPrompt({
      alertTitle: "Null deref",
      reviewer: "alice",
      instruction: "fix the bug",
      testCommand: "npm test",
    });
    expect(prompt).toContain("/sentry-cli");
    expect(prompt).toContain("@alice");
    expect(prompt).toContain("Null deref");
    expect(prompt).toContain("fix the bug");
    expect(prompt).toContain("npm test");
  });

  it("renderFollowupPrompt handles empty test command", () => {
    const prompt = renderFollowupPrompt({
      alertTitle: "X",
      reviewer: "y",
      instruction: "z",
      testCommand: null,
    });
    expect(prompt).toContain("No automated test command was detected");
  });

  it("wrapFollowupFixAgentStep returns a PipelineStep", () => {
    const step = wrapFollowupFixAgentStep({
      runId: "x",
      testRecorder: emptyRecorder(),
      prGuardHandle: { terminated: false },
    });
    expect(step.name).toBe("followup-fix-agent");
    expect(step.skipIf).toBeDefined();
  });
});
