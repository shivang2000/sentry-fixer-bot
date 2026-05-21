/**
 * Unit tests for pr-guard wrapper.
 *   - When PR is open, handle.terminated stays false.
 *   - When PR is closed or merged, handle.terminated=true.
 *   - When PR is unknown, handle.terminated stays false (fail open).
 *   - When ctx.pr is missing, handle.terminated=true.
 *   - skipIfPrGuardTerminated returns true once handle is flipped.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, makeLogRecorder, silentLogger } from "../../__tests__/fixtures";
import {
  type PrGuardHandle,
  runPrGuardStep,
  skipIfPrGuardTerminated,
  wrapPrGuardStep,
} from "../pr-guard";

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

describe("pr-guard wrapper", () => {
  it("PR open → handle.terminated stays false", async () => {
    const ctx = new MemoryCtxStore("r1");
    await ctx.write("pr", { repo: "a/b", number: 1, branch: "x", url: "u", isDraft: false });
    const handle: PrGuardHandle = { terminated: false };
    await runPrGuardStep(ctx, makeCfg(), makeDeps(), {
      handle,
      getPrStateFn: async () => "open",
    });
    expect(handle.terminated).toBe(false);
    expect(handle.state).toBe("open");
  });

  it("PR closed → handle.terminated=true", async () => {
    const ctx = new MemoryCtxStore("r2");
    await ctx.write("pr", { repo: "a/b", number: 1, branch: "x", url: "u", isDraft: false });
    const handle: PrGuardHandle = { terminated: false };
    await runPrGuardStep(ctx, makeCfg(), makeDeps(), {
      handle,
      getPrStateFn: async () => "closed",
    });
    expect(handle.terminated).toBe(true);
    expect(handle.state).toBe("closed");
  });

  it("PR merged → handle.terminated=true", async () => {
    const ctx = new MemoryCtxStore("r3");
    await ctx.write("pr", { repo: "a/b", number: 1, branch: "x", url: "u", isDraft: false });
    const handle: PrGuardHandle = { terminated: false };
    await runPrGuardStep(ctx, makeCfg(), makeDeps(), {
      handle,
      getPrStateFn: async () => "merged",
    });
    expect(handle.terminated).toBe(true);
    expect(handle.state).toBe("merged");
  });

  it("PR state unknown → handle.terminated stays false (fail open)", async () => {
    const ctx = new MemoryCtxStore("r4");
    await ctx.write("pr", { repo: "a/b", number: 1, branch: "x", url: "u", isDraft: false });
    const handle: PrGuardHandle = { terminated: false };
    await runPrGuardStep(ctx, makeCfg(), makeDeps(), {
      handle,
      getPrStateFn: async () => "unknown",
    });
    expect(handle.terminated).toBe(false);
    expect(handle.state).toBe("unknown");
  });

  it("ctx.pr missing → handle.terminated=true", async () => {
    const ctx = new MemoryCtxStore("r5");
    const handle: PrGuardHandle = { terminated: false };
    let called = false;
    await runPrGuardStep(ctx, makeCfg(), makeDeps(), {
      handle,
      getPrStateFn: async () => {
        called = true;
        return "open";
      },
    });
    expect(handle.terminated).toBe(true);
    expect(called).toBe(false);
  });

  it("skipIfPrGuardTerminated reflects the handle", async () => {
    const ctx = new MemoryCtxStore("r6");
    const handle: PrGuardHandle = { terminated: false };
    const skip = skipIfPrGuardTerminated(handle);
    expect(await skip(ctx, makeCfg())).toBe(false);
    handle.terminated = true;
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("wrapPrGuardStep returns a PipelineStep with the right name", () => {
    const step = wrapPrGuardStep({
      handle: { terminated: false },
      getPrStateFn: async () => "open",
    });
    expect(step.name).toBe("pr-guard");
    // pr-guard has no skipIf — it always runs first.
    expect(step.skipIf).toBeUndefined();
  });
});
