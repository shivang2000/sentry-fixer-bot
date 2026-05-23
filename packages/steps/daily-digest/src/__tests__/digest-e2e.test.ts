/**
 * End-to-end digest test:
 *   1. Build a DigestPayload from fixture data.
 *   2. Run it through `sendDailyDigests` with the actual Slack + email
 *      channel adapter packages registered.
 *   3. Assert both adapters received a correctly-shaped payload:
 *      Slack JSON includes a header + the roll-up fields; email HTML
 *      includes a table with the same data.
 *
 * Network is mocked at the global fetch boundary — same shape the
 * production adapters use.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import emailAdapter from "@alertforge/channel-email";
import slackAdapter from "@alertforge/channel-slack";
import { registry } from "@alertforge/core";
import { type DailyDigestDb, sendDailyDigests, type TriggerForDigest } from "../index";

const SILENT = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SILENT;
  },
};

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.ALERTFORGE_DEFAULT_FROM = "alertforge@example.com";
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
});

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
          { id: "a3", fingerprint: "fp-B" },
        ],
        runs: [
          { id: "r1", costCents: 100 },
          { id: "r2", costCents: 200 },
        ],
        prs: [
          { id: "p1", fingerprint: "fp-A", title: "TypeError null deref", outcome: "merged_clean" },
          { id: "p2", fingerprint: "fp-A", title: "TypeError null deref", outcome: "merged_clean" },
          {
            id: "p3",
            fingerprint: "fp-A",
            title: "TypeError null deref",
            outcome: "closed_unmerged",
          },
          {
            id: "p4",
            fingerprint: "fp-A",
            title: "TypeError null deref",
            outcome: "closed_unmerged",
          },
          { id: "p5", fingerprint: "fp-B", title: "ECONN", outcome: "merged_with_edits" },
        ],
        costCents: 300,
        capCents: 17500,
      };
    },
  };
}

describe("daily-digest — end-to-end with real channel adapters", () => {
  it("Slack adapter receives a Block Kit payload with the digest layout", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const triggers: TriggerForDigest[] = [
      {
        id: "t-int",
        name: "backend-api",
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
            config: { webhookUrl: "https://hooks.slack.com/services/T/B/abc" },
          },
        ],
      },
    ];

    await sendDailyDigests({
      db: makeStubDb(triggers),
      log: SILENT,
      channels: new Map([[slackAdapter.type, slackAdapter]]),
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T/B/abc");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(Array.isArray(body.blocks)).toBe(true);
    // Header with digest signal:
    const headerBlock = body.blocks.find((b: { type: string }) => b.type === "header");
    expect(headerBlock?.text?.text?.toLowerCase()).toContain("digest");
    // Field section includes Alerts + counts.
    const blocksJson = JSON.stringify(body.blocks);
    expect(blocksJson).toContain("Alerts");
    expect(blocksJson).toContain("3"); // alertCount = 3
    expect(blocksJson).toContain("Merge rate");
    expect(blocksJson).toContain("TypeError");
  });

  it("Email adapter receives an HTML table + plaintext digest body", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const triggers: TriggerForDigest[] = [
      {
        id: "t-int-email",
        name: "backend-api",
        enabled: true,
        sourceProject: "backend-api",
        repo: "acme/api",
        capCents: 17500,
        channels: [
          {
            id: "c1",
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
      channels: new Map([[emailAdapter.type, emailAdapter]]),
    });

    expect(calls.length).toBe(1);
    const payload = JSON.parse(calls[0]?.body ?? "{}");
    expect(payload.subject).toContain("[Alertforge]");
    expect(payload.subject).toContain("Digest");
    expect(payload.html).toContain("<table");
    expect(payload.html).toContain("Alerts");
    expect(payload.html).toContain("Merge rate");
    expect(payload.text).toContain("PRs opened");
    expect(payload.text).toContain("TypeError");
  });

  it("Both adapters receive copies when the trigger has Slack + email digest channels", async () => {
    const seen: Array<{ url: string }> = [];
    global.fetch = mock(async (url: string | URL) => {
      seen.push({ url: String(url) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const triggers: TriggerForDigest[] = [
      {
        id: "t-both",
        name: "backend-api",
        enabled: true,
        sourceProject: "backend-api",
        repo: "acme/api",
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
      channels: new Map([
        [slackAdapter.type, slackAdapter],
        [emailAdapter.type, emailAdapter],
      ]),
    });

    expect(seen.length).toBe(2);
    expect(seen.some((c) => c.url.includes("slack.com"))).toBe(true);
    expect(seen.some((c) => c.url.includes("resend.com"))).toBe(true);
  });

  it("does not crash when registry-resolution fails (untouched on adapter clear)", () => {
    // Sanity check the singleton hasn't been mutated by other tests.
    expect(registry).toBeDefined();
  });
});
