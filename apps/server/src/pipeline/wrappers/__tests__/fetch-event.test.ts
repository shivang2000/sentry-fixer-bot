/**
 * Unit tests for fetch-event wrapper. Verifies:
 *   - skipIf is true when ctx.alert is missing.
 *   - run() looks up adapter by alert.sourceType and writes enriched
 *     alert to ctx.event_detail.
 *   - adapter throws → wrapper records a warning + falls back to bare alert.
 *   - adapter has no fetchEventDetail → skipped (event_detail stays
 *     unwritten).
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import {
  MemoryCtxStore,
  makeLogRecorder,
  makeStubSentrySource,
  SAMPLE_ALERT,
  silentLogger,
} from "../../__tests__/fixtures";
import { runFetchEventStep, skipFetchEventIf, wrapFetchEventStep } from "../fetch-event";

function makeDeps(
  sources: Map<string, SourceAdapter>,
  appendLog = makeLogRecorder().appendLog,
): StepDeps {
  return {
    modelProvider: {
      name: "noop",
      async complete() {
        return "{}";
      },
    },
    log: silentLogger,
    sources,
    channels: new Map<string, ChannelAdapter>(),
    appendLog,
  };
}

describe("fetch-event wrapper", () => {
  it("skipIf returns true when ctx.alert is missing", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipFetchEventIf(ctx, {} as never)).toBe(true);
  });

  it("skipIf returns false when ctx.alert exists", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await ctx.write("alert", SAMPLE_ALERT);
    expect(await skipFetchEventIf(ctx, {} as never)).toBe(false);
  });

  it("writes enriched alert to ctx.event_detail when adapter supports it", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("alert", SAMPLE_ALERT);
    const sources = new Map<string, SourceAdapter>();
    sources.set("sentry", makeStubSentrySource({ stackTrace: "boom at line 1" }));
    await runFetchEventStep(ctx, {} as never, makeDeps(sources));
    const detail = (await ctx.read("event_detail")) as { stackTrace: string };
    expect(detail.stackTrace).toBe("boom at line 1");
  });

  it("falls back to bare alert when fetchEventDetail throws", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("alert", SAMPLE_ALERT);
    const sources = new Map<string, SourceAdapter>();
    const throwing = makeStubSentrySource();
    throwing.fetchEventDetail = async () => {
      throw new Error("Sentry 503");
    };
    sources.set("sentry", throwing);
    const logRec = makeLogRecorder();
    await runFetchEventStep(ctx, {} as never, makeDeps(sources, logRec.appendLog));
    const detail = await ctx.read("event_detail");
    expect(detail).toBeDefined();
    expect(logRec.lines.some((l) => l.message.includes("Sentry 503"))).toBe(true);
  });

  it("is a no-op when adapter has no fetchEventDetail", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await ctx.write("alert", SAMPLE_ALERT);
    const sources = new Map<string, SourceAdapter>();
    const bare = makeStubSentrySource();
    delete (bare as { fetchEventDetail?: unknown }).fetchEventDetail;
    sources.set("sentry", bare);
    await runFetchEventStep(ctx, {} as never, makeDeps(sources));
    expect(await ctx.exists("event_detail")).toBe(false);
  });

  it("wrapFetchEventStep returns the correct PipelineStep", () => {
    const step = wrapFetchEventStep();
    expect(step.name).toBe("fetch-event");
    expect(step.skipIf).toBeDefined();
  });
});
