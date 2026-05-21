/**
 * Unit tests for fix-agent wrapper. Verifies:
 *   - skipIf returns true when cfg.stopAfter='budget'.
 *   - run() spawns the agent, parses output, writes ctx.agent_output.
 *   - Self-heal retry loop: when tests fail, re-spawn up to maxAttempts.
 *   - Side-channel testRecorder is filled with final test attempt state.
 *   - When tests pass on the first attempt, no retry happens.
 *   - When the agent exits non-zero, the loop breaks early.
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
import { runFixAgentStep, skipFixAgentIf, type TestRecorder } from "../fix-agent";

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

describe("fix-agent wrapper", () => {
  it("skipIf returns true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipFixAgentIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
    expect(await skipFixAgentIf(ctx, makeCfg())).toBe(false);
  });

  it("runs once when tests pass; writes ctx.agent_output + agent_transcript", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    let spawnCount = 0;
    const recorder: TestRecorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 0,
    };
    await runFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "run-2",
      testRecorder: recorder,
      resolveTestCommandFn: async () => ({ command: "npm test", source: "detected" }),
      ensureDepsFn: async () => ({
        ran: true,
        command: "npm ci",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      runRepoTestsFn: async () => ({ passed: true, stdout: "ok", stderr: "" }),
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 10 };
      },
    });
    expect(spawnCount).toBe(1);
    expect(await ctx.exists("agent_output")).toBe(true);
    const out = (await ctx.read("agent_output")) as { confidence: string };
    expect(out.confidence).toBe("high");
    expect(await ctx.exists("agent_transcript")).toBe(true);
    expect(recorder.passed).toBe(true);
    expect(recorder.attempts).toBe(1);
  });

  it("retries when tests fail, stops on success", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    let spawnCount = 0;
    let testCount = 0;
    const recorder: TestRecorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 0,
    };
    await runFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "run-3",
      testRecorder: recorder,
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
        // Fail first attempt, pass second.
        return { passed: testCount >= 2, stdout: "out", stderr: "err" };
      },
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 5 };
      },
    });
    expect(spawnCount).toBe(2);
    expect(recorder.passed).toBe(true);
    expect(recorder.attempts).toBe(2);
  });

  it("exhausts maxAttempts when tests never pass", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    let spawnCount = 0;
    const recorder: TestRecorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 0,
    };
    await runFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "run-4",
      testRecorder: recorder,
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
      runRepoTestsFn: async () => ({ passed: false, stdout: "FAIL", stderr: "x" }),
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(3);
    expect(recorder.passed).toBe(false);
    expect(recorder.attempts).toBe(3);
  });

  it("breaks the loop early on non-zero agent exit", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    let spawnCount = 0;
    const recorder: TestRecorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 0,
    };
    await runFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "run-5",
      testRecorder: recorder,
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

  it("when no test command is detected, doesn't loop", async () => {
    const ctx = new MemoryCtxStore("run-6");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await ctx.write("alert", SAMPLE_ALERT);
    let spawnCount = 0;
    const recorder: TestRecorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 0,
    };
    await runFixAgentStep(ctx, makeCfg(), makeDeps(), {
      runId: "run-6",
      testRecorder: recorder,
      resolveTestCommandFn: async () => null,
      ensureDepsFn: async () => ({
        ran: false,
        command: null,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
      }),
      runRepoTestsFn: async () => {
        throw new Error("should not be called when no test command");
      },
      spawnAgentFn: async () => {
        spawnCount++;
        return { exitCode: 0, stdout: AGENT_STDOUT_OK, stderr: "", durationMs: 1 };
      },
    });
    expect(spawnCount).toBe(1);
    expect(recorder.passed).toBeNull();
  });

  it("throws when ctx.workspace is missing", async () => {
    const ctx = new MemoryCtxStore("run-7");
    await ctx.write("alert", SAMPLE_ALERT);
    await expect(
      runFixAgentStep(ctx, makeCfg(), makeDeps(), {
        runId: "run-7",
        testRecorder: {
          command: null,
          passed: null,
          stdoutTail: "",
          stderrTail: "",
          attempts: 0,
        },
        spawnAgentFn: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
      }),
    ).rejects.toThrow(/workspace/);
  });
});
