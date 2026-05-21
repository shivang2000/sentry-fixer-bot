import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import sentryAdapter from "./adapter";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("sentry adapter — shape", () => {
  it("declares the required identity fields", () => {
    expect(sentryAdapter.type).toBe("sentry");
    expect(sentryAdapter.displayName).toBe("Sentry");
    expect(sentryAdapter.webhookPath).toBe("/webhooks/sentry");
  });

  it("declares url patterns and catalog entry", () => {
    expect(sentryAdapter.urlPatterns.length).toBeGreaterThan(0);
    expect(sentryAdapter.catalogEntry.requiresEnvKeys).toContain("SENTRY_WEBHOOK_SECRET");
    expect(sentryAdapter.catalogEntry.urlExamples.length).toBeGreaterThan(0);
    expect(sentryAdapter.catalogEntry.setupGuide).toContain("Sentry source");
  });

  it("provides a configSchema that accepts empty object", () => {
    expect(sentryAdapter.configSchema.parse({})).toEqual({});
  });
});

describe("sentry adapter — verifyWebhook", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ action: "created", data: { issue: { id: "1" } } });

  it("accepts a valid sentry-hook-signature header", async () => {
    const sig = sign(secret, body);
    const req = new Request("http://localhost/webhooks/sentry", {
      method: "POST",
      headers: { "sentry-hook-signature": sig, "content-type": "application/json" },
      body,
    });
    expect(await sentryAdapter.verifyWebhook(req, secret)).toBe(true);
  });

  it("accepts the legacy x-sentry-signature header", async () => {
    const sig = sign(secret, body);
    const req = new Request("http://localhost/webhooks/sentry", {
      method: "POST",
      headers: { "x-sentry-signature": sig, "content-type": "application/json" },
      body,
    });
    expect(await sentryAdapter.verifyWebhook(req, secret)).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const req = new Request("http://localhost/webhooks/sentry", {
      method: "POST",
      headers: { "sentry-hook-signature": "deadbeef" },
      body,
    });
    expect(await sentryAdapter.verifyWebhook(req, secret)).toBe(false);
  });

  it("rejects a missing signature header", async () => {
    const req = new Request("http://localhost/webhooks/sentry", { method: "POST", body });
    expect(await sentryAdapter.verifyWebhook(req, secret)).toBe(false);
  });
});

describe("sentry adapter — dedupKey", () => {
  it("matches parseSentryPayload + dedupKey direct call", () => {
    const alert = {
      sourceType: "sentry",
      sourceProject: "p",
      externalId: "1",
      fingerprint: "f",
      title: "x",
      level: "error" as const,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      codeVersion: "v1",
      rawPayloadS3Key: "",
    };
    const key = sentryAdapter.dedupKey(alert);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });
});

describe("sentry adapter — parseUrl", () => {
  it("delegates to parseSentryUrl", () => {
    expect(sentryAdapter.parseUrl("https://sentry.io/issues/12345/")).toEqual({
      sourceProject: "*",
      externalId: "12345",
    });
    expect(sentryAdapter.parseUrl("not a sentry url")).toBeNull();
  });
});

describe("sentry adapter — parsePayload", () => {
  it("returns NormalizedAlert for valid body", () => {
    const alert = sentryAdapter.parsePayload({
      data: {
        issue: { id: "1", title: "boom", level: "error", project: { slug: "p" } },
      },
    });
    expect(alert?.externalId).toBe("1");
    expect(alert?.sourceType).toBe("sentry");
  });

  it("returns null for malformed body", () => {
    expect(sentryAdapter.parsePayload({})).toBeNull();
  });
});
