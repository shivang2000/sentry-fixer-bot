/**
 * Unit tests for open-pr wrapper. Verifies:
 *   - skipIf true when cfg.stopAfter='budget'.
 *   - happy path: invokes openPrFn, writes ctx.pr with number+url+isDraft.
 *   - Aborts when agent_output.exitCode != 0.
 *   - Aborts when secret_scan.blocked = true.
 *   - isDraft=true when secret findings exist (warn mode).
 *   - isDraft=true when test_result.passed = false.
 *   - reviewers list passed through to openPrFn.
 *   - throws when deps.resolveToken missing.
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
import { renderPrBody, runOpenPrStep, skipOpenPrIf } from "../open-pr";

function makeDeps(overrides: Partial<StepDeps> = {}): StepDeps {
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
    resolveToken: async () => "tok",
    appendLog: makeLogRecorder().appendLog,
    ...overrides,
  };
}

async function seedHappyCtx(ctx: MemoryCtxStore) {
  await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
  await ctx.write("alert", SAMPLE_ALERT);
  await ctx.write("agent_output", {
    summary: "fixed it",
    problem: "p",
    hypotheses: "H1",
    fix: "f",
    confidence: "high",
    risk: "low",
    severity: "medium",
    exitCode: 0,
    attempts: 1,
  });
  await ctx.write("test_result", {
    passed: true,
    command: "npm test",
    stdoutTail: "",
    stderrTail: "",
    attempts: 1,
  });
  await ctx.write("secret_scan", { findings: [], blocked: false });
}

describe("open-pr wrapper", () => {
  it("skipIf true when stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipOpenPrIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("happy path: writes ctx.pr with number+url+isDraft=false", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await seedHappyCtx(ctx);
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      openPrFn: async () => ({ number: 99, url: "https://github.com/acme/api/pull/99" }),
    });
    const pr = (await ctx.read("pr")) as {
      number: number;
      url: string;
      isDraft: boolean;
      needsHuman: boolean;
    };
    expect(pr).toEqual({
      number: 99,
      url: "https://github.com/acme/api/pull/99",
      isDraft: false,
      needsHuman: false,
    });
  });

  it("aborts when agent_output.exitCode != 0", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await seedHappyCtx(ctx);
    await ctx.write("agent_output", {
      exitCode: 137,
      summary: "",
      problem: "",
      hypotheses: "",
      fix: "",
      confidence: "unknown",
      risk: "unknown",
      severity: "unknown",
      attempts: 1,
    });
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      openPrFn: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await ctx.exists("pr")).toBe(false);
  });

  it("aborts when secret_scan.blocked", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await seedHappyCtx(ctx);
    await ctx.write("secret_scan", {
      findings: [{ file: "leak.ts", line: 1, pattern: "aws_access_key" }],
      blocked: true,
    });
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      openPrFn: async () => {
        throw new Error("should not be called");
      },
    });
    expect(await ctx.exists("pr")).toBe(false);
  });

  it("isDraft=true when test gate failed", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await seedHappyCtx(ctx);
    await ctx.write("test_result", {
      passed: false,
      command: "npm test",
      stdoutTail: "",
      stderrTail: "",
      attempts: 3,
    });
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      openPrFn: async () => ({ number: 1, url: "u" }),
    });
    const pr = (await ctx.read("pr")) as { isDraft: boolean };
    expect(pr.isDraft).toBe(true);
  });

  it("isDraft=true and needsHuman=true when warn-mode secrets present", async () => {
    const ctx = new MemoryCtxStore("run-6");
    await seedHappyCtx(ctx);
    await ctx.write("secret_scan", {
      findings: [{ file: "leak.ts", line: 1, pattern: "aws_access_key" }],
      blocked: false,
    });
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      openPrFn: async () => ({ number: 7, url: "u" }),
    });
    const pr = (await ctx.read("pr")) as { isDraft: boolean; needsHuman: boolean };
    expect(pr.isDraft).toBe(true);
    expect(pr.needsHuman).toBe(true);
  });

  it("threads reviewers through to openPrFn", async () => {
    const ctx = new MemoryCtxStore("run-7");
    await seedHappyCtx(ctx);
    let captured: string[] = [];
    await runOpenPrStep(ctx, makeCfg(), makeDeps(), {
      repo: "acme/api",
      reviewers: ["alice", "bob"],
      openPrFn: async (input) => {
        captured = input.reviewers;
        return { number: 1, url: "u" };
      },
    });
    expect(captured).toEqual(["alice", "bob"]);
  });

  it("throws when deps.resolveToken missing", async () => {
    const ctx = new MemoryCtxStore("run-8");
    await seedHappyCtx(ctx);
    const deps = makeDeps();
    delete deps.resolveToken;
    await expect(
      runOpenPrStep(ctx, makeCfg(), deps, {
        repo: "acme/api",
        openPrFn: async () => ({ number: 1, url: "u" }),
      }),
    ).rejects.toThrow(/resolveToken/);
  });

  it("renderPrBody includes structured sections when problem/hypotheses/fix are set", () => {
    const body = renderPrBody({
      alert: "Null deref",
      problem: "X happened",
      hypotheses: "H1: ...",
      fix: "did the thing",
      summary: "ignored",
      confidence: "high",
      risk: "low",
      severity: "medium",
      testPassed: true,
      findings: [],
    });
    expect(body).toContain("## Problem");
    expect(body).toContain("## Alternatives considered");
    expect(body).toContain("## Fix");
  });
});
