import { describe, expect, it } from "bun:test";
import { parseSentryUrl, SENTRY_URL_PATTERNS } from "./parse-url";

describe("parseSentryUrl", () => {
  it("parses org-scoped URL", () => {
    expect(parseSentryUrl("https://sentry.io/organizations/acme/issues/12345/")).toEqual({
      sourceProject: "*",
      externalId: "12345",
    });
  });

  it("parses bare /issues/<id>/ URL", () => {
    expect(parseSentryUrl("https://sentry.io/issues/7340544098/")).toEqual({
      sourceProject: "*",
      externalId: "7340544098",
    });
  });

  it("parses custom-subdomain URL and captures org slug as sourceProject hint", () => {
    expect(parseSentryUrl("https://acme.sentry.io/issues/12345/")).toEqual({
      sourceProject: "acme",
      externalId: "12345",
    });
  });

  it("parses URL without trailing slash", () => {
    expect(parseSentryUrl("https://sentry.io/issues/999")).toEqual({
      sourceProject: "*",
      externalId: "999",
    });
  });

  it("parses URL with query string", () => {
    expect(parseSentryUrl("https://acme.sentry.io/issues/12345/?project=42")).toEqual({
      sourceProject: "acme",
      externalId: "12345",
    });
  });

  it("returns null for non-Sentry URLs", () => {
    expect(parseSentryUrl("https://github.com/acme/repo/issues/1")).toBeNull();
    expect(parseSentryUrl("https://example.com/issues/1")).toBeNull();
    expect(parseSentryUrl("not a url")).toBeNull();
    expect(parseSentryUrl("")).toBeNull();
  });

  it("returns null for a Sentry URL that is not an issue link", () => {
    expect(parseSentryUrl("https://sentry.io/organizations/acme/")).toBeNull();
    expect(parseSentryUrl("https://sentry.io/")).toBeNull();
  });

  it("exports a non-empty patterns array", () => {
    expect(SENTRY_URL_PATTERNS.length).toBeGreaterThan(0);
    for (const p of SENTRY_URL_PATTERNS) {
      expect(p).toBeInstanceOf(RegExp);
    }
  });
});
