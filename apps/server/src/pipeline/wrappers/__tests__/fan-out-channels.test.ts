/**
 * Unit tests for fan-out-channels wrapper. Verifies:
 *   - status derivation: pr present → "pr_opened"; stopAfter='budget' →
 *     "triage_only"; otherwise "failed".
 *   - Configs are filtered by notifyOn (status mismatch is silently skipped).
 *   - One channel's failure does NOT abort the other channel.
 *   - Missing adapter in registry is recorded as a failure with reason.
 *   - notifications array is written to ctx.notifications.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import {
  MemoryCtxStore,
  makeCfg,
  makeLogRecorder,
  RecordingChannel,
  SAMPLE_ALERT,
  SAMPLE_TRIGGER,
  silentLogger,
} from "../../__tests__/fixtures";
import { runFanOutChannelsStep, wrapFanOutChannelsStep } from "../fan-out-channels";

function makeDeps(channels: Map<string, ChannelAdapter>): StepDeps {
  return {
    modelProvider: {
      name: "noop",
      async complete() {
        return "{}";
      },
    },
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels,
    appendLog: makeLogRecorder().appendLog,
  };
}

describe("fan-out-channels wrapper", () => {
  it("status='pr_opened' when ctx.pr exists", async () => {
    const ctx = new MemoryCtxStore("run-1");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("pr", { number: 1, url: "u", isDraft: false });
    const slack = new RecordingChannel("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);
    await runFanOutChannelsStep(ctx, makeCfg(), makeDeps(channels), {
      runId: "run-1",
      listChannelConfigsFn: async () => [
        {
          id: "c1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: {},
        },
      ],
    });
    expect(slack.recordedSends).toHaveLength(1);
    expect(slack.recordedSends[0]?.notification.status).toBe("pr_opened");
  });

  it("status='triage_only' when stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    const email = new RecordingChannel("email");
    const channels = new Map<string, ChannelAdapter>([["email", email]]);
    await runFanOutChannelsStep(ctx, makeCfg({ stopAfter: "budget" }), makeDeps(channels), {
      runId: "run-2",
      listChannelConfigsFn: async () => [
        {
          id: "c1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "email",
          enabled: true,
          notifyOn: ["triage_only"],
          config: {},
        },
      ],
    });
    expect(email.recordedSends).toHaveLength(1);
    expect(email.recordedSends[0]?.notification.status).toBe("triage_only");
  });

  it("status='failed' when no PR was opened and not budget-blocked", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    const slack = new RecordingChannel("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);
    await runFanOutChannelsStep(ctx, makeCfg(), makeDeps(channels), {
      runId: "run-3",
      listChannelConfigsFn: async () => [
        {
          id: "c1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["failed"],
          config: {},
        },
      ],
    });
    expect(slack.recordedSends[0]?.notification.status).toBe("failed");
  });

  it("skips channels whose notifyOn excludes the status", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("pr", { number: 1, url: "u", isDraft: false });
    const slack = new RecordingChannel("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);
    await runFanOutChannelsStep(ctx, makeCfg(), makeDeps(channels), {
      runId: "run-4",
      listChannelConfigsFn: async () => [
        {
          id: "c1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["triage_only"], // pr_opened NOT in list
          config: {},
        },
      ],
    });
    expect(slack.recordedSends).toHaveLength(0);
    const notifications = (await ctx.read("notifications")) as unknown[];
    expect(notifications).toEqual([]);
  });

  it("records one channel's failure but still sends to the other", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("pr", { number: 1, url: "u", isDraft: false });
    const slack = new RecordingChannel("slack");
    const email = new RecordingChannel("email", { fail: true });
    const channels = new Map<string, ChannelAdapter>([
      ["slack", slack],
      ["email", email],
    ]);
    await runFanOutChannelsStep(ctx, makeCfg(), makeDeps(channels), {
      runId: "run-5",
      listChannelConfigsFn: async () => [
        {
          id: "c-slack",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: {},
        },
        {
          id: "c-email",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "email",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: {},
        },
      ],
    });
    const records = (await ctx.read("notifications")) as Array<{
      channelType: string;
      ok: boolean;
    }>;
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.channelType === "slack")?.ok).toBe(true);
    expect(records.find((r) => r.channelType === "email")?.ok).toBe(false);
  });

  it("records a failure when no adapter is registered for a config", async () => {
    const ctx = new MemoryCtxStore("run-6");
    await ctx.write("trigger", SAMPLE_TRIGGER);
    await ctx.write("alert", SAMPLE_ALERT);
    await ctx.write("pr", { number: 1, url: "u", isDraft: false });
    await runFanOutChannelsStep(ctx, makeCfg(), makeDeps(new Map()), {
      runId: "run-6",
      listChannelConfigsFn: async () => [
        {
          id: "c1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "discord",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: {},
        },
      ],
    });
    const records = (await ctx.read("notifications")) as Array<{ ok: boolean; error?: string }>;
    expect(records[0]?.ok).toBe(false);
    expect(records[0]?.error).toContain("no channel adapter");
  });

  it("wrapFanOutChannelsStep returns the correct PipelineStep", () => {
    const step = wrapFanOutChannelsStep({ runId: "x" });
    expect(step.name).toBe("fan-out-channels");
    expect(step.skipIf).toBeUndefined();
  });
});
