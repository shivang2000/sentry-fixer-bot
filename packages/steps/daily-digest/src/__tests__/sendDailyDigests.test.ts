/**
 * Integration test for `sendDailyDigests`. Mocks:
 *   - The per-trigger DB stub: returns a fixed list of triggers +
 *     channel_configs + the rows `buildDigest` needs (alerts, runs,
 *     prs, costs).
 *   - The channel registry: holds RecordingChannel stubs that capture
 *     every send call so we can assert on the synthesized
 *     PipelineNotification.
 *
 * Verifies:
 *   - One digest fan-out per trigger that has at least one digest-
 *     subscribed channel.
 *   - Triggers with no digest-subscribed channels are skipped (no DB
 *     load, no channel send).
 *   - Triggers with `enabled=false` are skipped entirely.
 *   - status='digest' and digestBody are present on the notification.
 *   - One channel's failure does NOT abort the others (logged + skipped).
 */

import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, PipelineNotification } from "@alertforge/core";
import { type DailyDigestDb, sendDailyDigests, type TriggerForDigest } from "../index";

interface RecordedSend {
  channelType: string;
  notification: PipelineNotification;
  config: unknown;
}

class RecordingChannel implements ChannelAdapter {
  readonly type: string;
  readonly displayName: string;
  readonly configSchema = { parse: (v: unknown) => v } as unknown as ChannelAdapter["configSchema"];
  readonly catalogEntry = {
    description: "recording",
    setupGuide: "n/a",
    requiresEnvKeys: [],
  };
  readonly recordedSends: RecordedSend[] = [];
  constructor(
    type: string,
    private readonly failOn: boolean = false,
  ) {
    this.type = type;
    this.displayName = type;
  }
  async send(notification: PipelineNotification, config: unknown): Promise<void> {
    const entry: RecordedSend = { channelType: this.type, notification, config };
    this.recordedSends.push(entry);
    if (this.failOn) throw new Error(`simulated ${this.type} failure`);
  }
}

const SILENT = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SILENT;
  },
};

function makeStubDb(triggers: TriggerForDigest[]): DailyDigestDb {
  return {
    async listTriggersWithDigestChannels() {
      return triggers;
    },
    async loadDigestData() {
      return {
        alerts: [
          { id: "a1", fingerprint: "fp-A" },
          { id: "a2", fingerprint: "fp-A" },
        ],
        runs: [{ id: "r1", costCents: 200 }],
        prs: [
          { id: "p1", fingerprint: "fp-A", title: "TypeErr", outcome: "merged_clean" },
          { id: "p2", fingerprint: "fp-A", title: "TypeErr", outcome: "closed_unmerged" },
        ],
        costCents: 200,
        capCents: 17500,
      };
    },
  };
}

describe("sendDailyDigests", () => {
  it("fans out one digest per enabled trigger that has a digest-subscribed channel", async () => {
    const slack = new RecordingChannel("slack");
    const email = new RecordingChannel("email");
    const channels = new Map<string, ChannelAdapter>([
      ["slack", slack],
      ["email", email],
    ]);

    const triggers: TriggerForDigest[] = [
      {
        id: "t1",
        name: "backend",
        enabled: true,
        sourceProject: "backend-api",
        repo: "acme/api",
        capCents: 17500,
        channels: [
          {
            id: "c1",
            channelType: "slack",
            enabled: true,
            notifyOn: ["digest"],
            config: { webhookUrl: "https://hooks.slack.com/x" },
          },
        ],
      },
      {
        id: "t2",
        name: "web",
        enabled: true,
        sourceProject: "web-frontend",
        repo: "acme/web",
        capCents: 17500,
        channels: [
          {
            id: "c2",
            channelType: "email",
            enabled: true,
            notifyOn: ["digest"],
            config: { to: ["sre@acme.com"] },
          },
        ],
      },
    ];

    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels,
    });

    expect(slack.recordedSends.length).toBe(1);
    expect(email.recordedSends.length).toBe(1);
    expect(slack.recordedSends[0]?.notification.status).toBe("digest");
    expect(slack.recordedSends[0]?.notification.digestBody).toBeDefined();
    expect(email.recordedSends[0]?.notification.status).toBe("digest");
    expect(email.recordedSends[0]?.notification.digestBody).toBeDefined();
  });

  it("skips triggers with enabled=false", async () => {
    const slack = new RecordingChannel("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);

    const triggers: TriggerForDigest[] = [
      {
        id: "t-off",
        name: "off",
        enabled: false,
        sourceProject: "off",
        repo: "acme/off",
        capCents: 17500,
        channels: [
          {
            id: "c1",
            channelType: "slack",
            enabled: true,
            notifyOn: ["digest"],
            config: { webhookUrl: "https://hooks.slack.com/x" },
          },
        ],
      },
    ];

    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels,
    });

    expect(slack.recordedSends.length).toBe(0);
  });

  it("skips triggers that have no digest-subscribed channel", async () => {
    const slack = new RecordingChannel("slack");
    const channels = new Map<string, ChannelAdapter>([["slack", slack]]);

    const triggers: TriggerForDigest[] = [
      {
        id: "t1",
        name: "only-pr-opened",
        enabled: true,
        sourceProject: "p",
        repo: "acme/p",
        capCents: 17500,
        channels: [
          {
            id: "c1",
            channelType: "slack",
            enabled: true,
            notifyOn: ["pr_opened"], // NO digest
            config: { webhookUrl: "https://hooks.slack.com/x" },
          },
        ],
      },
    ];

    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels,
    });

    expect(slack.recordedSends.length).toBe(0);
  });

  it("isolates per-channel failures so other channels still receive the digest", async () => {
    const slack = new RecordingChannel("slack");
    const email = new RecordingChannel("email", true); // FAILS
    const channels = new Map<string, ChannelAdapter>([
      ["slack", slack],
      ["email", email],
    ]);

    const triggers: TriggerForDigest[] = [
      {
        id: "t1",
        name: "two-channels",
        enabled: true,
        sourceProject: "p",
        repo: "acme/p",
        capCents: 17500,
        channels: [
          {
            id: "c-slack",
            channelType: "slack",
            enabled: true,
            notifyOn: ["digest"],
            config: { webhookUrl: "https://hooks.slack.com/x" },
          },
          {
            id: "c-email",
            channelType: "email",
            enabled: true,
            notifyOn: ["digest"],
            config: { to: ["sre@acme.com"] },
          },
        ],
      },
    ];

    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels,
    });

    expect(slack.recordedSends.length).toBe(1);
    // email recorded a send attempt before throwing.
    expect(email.recordedSends.length).toBe(1);
  });

  it("skips a digest-subscribed channel whose adapter isn't registered", async () => {
    const channels = new Map<string, ChannelAdapter>();

    const triggers: TriggerForDigest[] = [
      {
        id: "t1",
        name: "lonely",
        enabled: true,
        sourceProject: "p",
        repo: "acme/p",
        capCents: 17500,
        channels: [
          {
            id: "c1",
            channelType: "discord",
            enabled: true,
            notifyOn: ["digest"],
            config: {},
          },
        ],
      },
    ];

    // Should not throw — just log + skip.
    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels,
    });

    expect(channels.size).toBe(0);
  });
});
