import { afterEach, describe, expect, it, mock } from "bun:test";
import type { PipelineNotification } from "@alertforge/core";
import slackAdapter from "./adapter";

function fakeNotification(overrides: Partial<PipelineNotification> = {}): PipelineNotification {
  return {
    triggerId: "trigger-1",
    runId: "run-1",
    alert: {
      sourceType: "sentry",
      sourceProject: "backend-api",
      externalId: "12345",
      fingerprint: "abc",
      title: "TypeError: cannot read 'x' of undefined",
      level: "error",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawPayloadS3Key: "s3://archive/abc",
    },
    status: "pr_opened",
    prUrl: "https://github.com/acme/api/pull/42",
    triageSummary: "Null deref in checkout flow",
    severity: "high",
    confidence: 0.85,
    costCents: 124,
    ...overrides,
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("slack adapter — shape", () => {
  it("declares identity + catalog fields", () => {
    expect(slackAdapter.type).toBe("slack");
    expect(slackAdapter.displayName).toBe("Slack");
    expect(slackAdapter.catalogEntry.description).toMatch(/slack/i);
    expect(slackAdapter.catalogEntry.requiresEnvKeys).toEqual([]);
  });

  it("configSchema accepts a valid webhook URL config", () => {
    expect(slackAdapter.configSchema.parse({ webhookUrl: "https://hooks.slack.com/x" })).toEqual({
      webhookUrl: "https://hooks.slack.com/x",
    });
  });

  it("configSchema rejects a non-URL webhook", () => {
    expect(() => slackAdapter.configSchema.parse({ webhookUrl: "not a url" })).toThrow();
  });

  it("configSchema rejects a missing webhook URL", () => {
    expect(() => slackAdapter.configSchema.parse({})).toThrow();
  });
});

describe("slack adapter — send", () => {
  it("POSTs Block Kit JSON to the configured webhook URL", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await slackAdapter.send(fakeNotification(), {
      webhookUrl: "https://hooks.slack.com/services/T1/B1/abc",
    });

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T1/B1/abc");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.text).toContain("TypeError");
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it("includes channel override when configured", async () => {
    let captured = "";
    global.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await slackAdapter.send(fakeNotification(), {
      webhookUrl: "https://hooks.slack.com/x",
      channel: "#oncall",
    });

    const body = JSON.parse(captured);
    expect(body.channel).toBe("#oncall");
  });

  it("includes @-mention text when mentionUserIds set", async () => {
    let captured = "";
    global.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await slackAdapter.send(fakeNotification(), {
      webhookUrl: "https://hooks.slack.com/x",
      mentionUserIds: ["U01ABC", "U02DEF"],
    });

    const body = JSON.parse(captured);
    expect(body.text).toContain("<@U01ABC>");
    expect(body.text).toContain("<@U02DEF>");
  });

  it("throws on non-2xx response with status + body", async () => {
    global.fetch = mock(
      async () => new Response("invalid_payload", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(
      slackAdapter.send(fakeNotification(), { webhookUrl: "https://hooks.slack.com/x" }),
    ).rejects.toThrow(/Slack send failed: 400/);
  });

  it("renders different status emojis for different statuses", async () => {
    const captures: string[] = [];
    global.fetch = mock(async (_url: string | URL, init?: RequestInit) => {
      captures.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    await slackAdapter.send(fakeNotification({ status: "pr_opened" }), {
      webhookUrl: "https://hooks.slack.com/x",
    });
    await slackAdapter.send(fakeNotification({ status: "failed" }), {
      webhookUrl: "https://hooks.slack.com/x",
    });

    expect(captures[0]).not.toBe(captures[1]);
  });
});
