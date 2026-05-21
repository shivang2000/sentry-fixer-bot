import { describe, expect, it } from "bun:test";
import { dedupKeyFromAlert, parseSentryPayload } from "./parse-payload";

const VALID: unknown = {
  action: "created",
  data: {
    issue: {
      id: "7340544098",
      title: "TypeError: cannot read 'x' of undefined",
      level: "error",
      project: { slug: "backend-api" },
      metadata: { fingerprint: "abc123", type: "TypeError", value: "..." },
    },
    event: { release: "frontend@1.2.3" },
  },
};

describe("parseSentryPayload", () => {
  it("returns a NormalizedAlert for a valid webhook body", () => {
    const alert = parseSentryPayload(VALID);
    expect(alert).not.toBeNull();
    expect(alert?.sourceType).toBe("sentry");
    expect(alert?.sourceProject).toBe("backend-api");
    expect(alert?.externalId).toBe("7340544098");
    expect(alert?.title).toBe("TypeError: cannot read 'x' of undefined");
    expect(alert?.level).toBe("error");
    expect(alert?.fingerprint).toBe("abc123");
    expect(alert?.codeVersion).toBe("frontend@1.2.3");
    expect(alert?.firstSeenAt).toBeInstanceOf(Date);
    expect(alert?.lastSeenAt).toBeInstanceOf(Date);
    expect(alert?.rawPayloadS3Key).toBe(""); // route handler populates after S3 write
  });

  it("falls back to issue id when fingerprint is absent", () => {
    const body = {
      data: {
        issue: { id: "999", title: "x", level: "error", project: { slug: "p" } },
      },
    };
    const alert = parseSentryPayload(body);
    expect(alert?.fingerprint).toBe("999");
  });

  it("normalizes unknown level to 'error'", () => {
    const body = {
      data: { issue: { id: "1", level: "fatal", project: { slug: "p" } } },
    };
    expect(parseSentryPayload(body)?.level).toBe("error");
  });

  it("preserves warning + info level", () => {
    const warn = { data: { issue: { id: "1", level: "warning", project: { slug: "p" } } } };
    const info = { data: { issue: { id: "1", level: "info", project: { slug: "p" } } } };
    expect(parseSentryPayload(warn)?.level).toBe("warning");
    expect(parseSentryPayload(info)?.level).toBe("info");
  });

  it("returns null when issue id is missing", () => {
    expect(parseSentryPayload({ data: { issue: { project: { slug: "p" } } } })).toBeNull();
  });

  it("returns null when project slug is missing", () => {
    expect(parseSentryPayload({ data: { issue: { id: "1" } } })).toBeNull();
  });

  it("returns null on totally malformed body", () => {
    expect(parseSentryPayload(null)).toBeNull();
    expect(parseSentryPayload({})).toBeNull();
    expect(parseSentryPayload({ data: {} })).toBeNull();
  });

  it("omits codeVersion when release is absent", () => {
    const body = { data: { issue: { id: "1", project: { slug: "p" } } } };
    const alert = parseSentryPayload(body);
    expect(alert?.codeVersion).toBeUndefined();
  });
});

describe("dedupKeyFromAlert", () => {
  it("produces a hex string", () => {
    const alert = parseSentryPayload(VALID);
    if (!alert) throw new Error("expected parse to succeed");
    expect(dedupKeyFromAlert(alert)).toMatch(/^[0-9a-f]+$/);
  });

  it("matches dedupKey on the same (project, fingerprint, codeVersion) tuple", async () => {
    const { dedupKey } = await import("./dedup");
    const alert = parseSentryPayload(VALID);
    if (!alert) throw new Error("expected parse to succeed");
    const fromAlert = dedupKeyFromAlert(alert);
    const direct = dedupKey({
      project: alert.sourceProject,
      fingerprint: alert.fingerprint,
      codeVersion: alert.codeVersion,
    });
    expect(fromAlert).toBe(direct);
  });
});
