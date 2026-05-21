/**
 * Unit tests for test-gate wrapper. Verifies it reads from the
 * TestRecorder side-channel and writes ctx.test_result.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, makeLogRecorder, silentLogger } from "../../__tests__/fixtures";
import { runTestGateStep, skipTestGateIf, wrapTestGateStep } from "../test-gate";

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

describe("test-gate wrapper", () => {
  it("skipIf returns true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipTestGateIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
    expect(await skipTestGateIf(ctx, makeCfg())).toBe(false);
  });

  it("writes passed=true from the side-channel", async () => {
    const ctx = new MemoryCtxStore("run-2");
    const recorder = {
      command: "npm test",
      passed: true,
      stdoutTail: "ok",
      stderrTail: "",
      attempts: 1,
    };
    await runTestGateStep(ctx, makeCfg(), makeDeps(), { testRecorder: recorder });
    const result = (await ctx.read("test_result")) as { passed: boolean; attempts: number };
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("writes passed=false from the side-channel", async () => {
    const ctx = new MemoryCtxStore("run-3");
    const recorder = {
      command: "npm test",
      passed: false,
      stdoutTail: "fail",
      stderrTail: "err",
      attempts: 3,
    };
    await runTestGateStep(ctx, makeCfg(), makeDeps(), { testRecorder: recorder });
    const result = (await ctx.read("test_result")) as { passed: boolean; attempts: number };
    expect(result.passed).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it("writes passed=null when no test command was detected", async () => {
    const ctx = new MemoryCtxStore("run-4");
    const recorder = {
      command: null,
      passed: null,
      stdoutTail: "",
      stderrTail: "",
      attempts: 1,
    };
    await runTestGateStep(ctx, makeCfg(), makeDeps(), { testRecorder: recorder });
    const result = (await ctx.read("test_result")) as { passed: null | boolean };
    expect(result.passed).toBeNull();
  });

  it("wrapTestGateStep returns the correct PipelineStep", () => {
    const step = wrapTestGateStep({
      testRecorder: {
        command: null,
        passed: null,
        stdoutTail: "",
        stderrTail: "",
        attempts: 0,
      },
    });
    expect(step.name).toBe("test-gate");
    expect(step.skipIf).toBeDefined();
  });
});
