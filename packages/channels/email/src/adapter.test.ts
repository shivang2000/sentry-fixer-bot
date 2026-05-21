import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PipelineNotification } from "@alertforge/core";
import emailAdapter from "./adapter";

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
    triageSummary: "Null deref",
    severity: "high",
    confidence: 0.8,
    costCents: 100,
    ...overrides,
  };
}

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

describe("email adapter — shape", () => {
  it("declares identity + catalog fields", () => {
    expect(emailAdapter.type).toBe("email");
    expect(emailAdapter.displayName).toBe("Email");
    expect(emailAdapter.catalogEntry.requiresEnvKeys).toContain("RESEND_API_KEY");
  });

  it("configSchema accepts a valid config + applies severity default", () => {
    const parsed = emailAdapter.configSchema.parse({ to: ["a@example.com"] }) as {
      to: string[];
      notifyOnSeverityAtLeast: string;
    };
    expect(parsed.to).toEqual(["a@example.com"]);
    expect(parsed.notifyOnSeverityAtLeast).toBe("medium");
  });

  it("configSchema rejects empty `to` list", () => {
    expect(() => emailAdapter.configSchema.parse({ to: [] })).toThrow();
  });

  it("configSchema caps `to` at 20", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    expect(() => emailAdapter.configSchema.parse({ to: tooMany })).toThrow();
  });

  it("configSchema rejects malformed emails", () => {
    expect(() => emailAdapter.configSchema.parse({ to: ["not an email"] })).toThrow();
  });
});

describe("email adapter — send", () => {
  it("POSTs to Resend with auth header + HTML + text bodies", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    global.fetch = mock(async (url: string | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of new Headers(init?.headers ?? {})) headers[k.toLowerCase()] = v;
      calls.push({ url: String(url), headers, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    await emailAdapter.send(fakeNotification(), { to: ["sre@acme.com"] });

    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.to).toEqual(["sre@acme.com"]);
    expect(body.subject).toContain("Alertforge");
    expect(body.html).toContain("Open PR");
    expect(body.text).toContain("PR: https://github.com/acme/api/pull/42");
  });

  it("uses ALERTFORGE_DEFAULT_FROM when config.from absent", async () => {
    let captured = "";
    global.fetch = mock(async (_url, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await emailAdapter.send(fakeNotification(), { to: ["sre@acme.com"] });

    const body = JSON.parse(captured);
    expect(body.from).toBe("alertforge@example.com");
  });

  it("config.from overrides env default", async () => {
    let captured = "";
    global.fetch = mock(async (_url, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await emailAdapter.send(fakeNotification(), {
      to: ["sre@acme.com"],
      from: "alerts@override.com",
    });

    const body = JSON.parse(captured);
    expect(body.from).toBe("alerts@override.com");
  });

  it("silently skips when severity is below floor", async () => {
    let called = 0;
    global.fetch = mock(async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await emailAdapter.send(fakeNotification({ severity: "low" }), {
      to: ["sre@acme.com"],
      notifyOnSeverityAtLeast: "high",
    });
    expect(called).toBe(0);

    await emailAdapter.send(fakeNotification({ severity: "critical" }), {
      to: ["sre@acme.com"],
      notifyOnSeverityAtLeast: "high",
    });
    expect(called).toBe(1);
  });

  it("throws when RESEND_API_KEY is unset", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(emailAdapter.send(fakeNotification(), { to: ["sre@acme.com"] })).rejects.toThrow(
      /RESEND_API_KEY/,
    );
  });

  it("throws when no from address and no env default", async () => {
    delete process.env.ALERTFORGE_DEFAULT_FROM;
    await expect(emailAdapter.send(fakeNotification(), { to: ["sre@acme.com"] })).rejects.toThrow(
      /from-address/,
    );
  });

  it("throws with status + body on non-2xx Resend response", async () => {
    global.fetch = mock(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(emailAdapter.send(fakeNotification(), { to: ["sre@acme.com"] })).rejects.toThrow(
      /Resend send failed: 429/,
    );
  });

  it("notifications without a severity always pass the floor", async () => {
    let called = 0;
    global.fetch = mock(async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const noSev = fakeNotification();
    delete noSev.severity;

    await emailAdapter.send(noSev, {
      to: ["sre@acme.com"],
      notifyOnSeverityAtLeast: "critical",
    });
    expect(called).toBe(1);
  });
});
