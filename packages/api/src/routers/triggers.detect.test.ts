import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { registry, type SourceAdapter } from "@alertforge/core";
import { z } from "zod";

/**
 * Unit-tests the URL-detect side of the triggers router without
 * spinning up tRPC + Postgres. The actual procedure is small and
 * delegates to:
 *
 *   - registry.sources.values() walked in order
 *   - adapter.parseUrl(url) → first non-null wins
 *   - adapter.urlPatterns serialized as { source, flags }
 *
 * This test asserts the contract the UI relies on:
 *   - serialized urlPatterns recreate to working RegExp on the client
 *   - parseUrl returns { sourceProject, externalId } for known URLs
 *   - parseUrl returns null for unrelated URLs
 *   - listSourceAdapters returns one entry per registered source
 */

function makeFakeAdapter(type: string, urlMatcher: RegExp): SourceAdapter {
  return {
    type,
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    webhookPath: `/webhooks/${type}`,
    async verifyWebhook() {
      return true;
    },
    parsePayload() {
      return null;
    },
    dedupKey() {
      return "";
    },
    urlPatterns: [urlMatcher],
    parseUrl(url: string) {
      const m = url.match(urlMatcher);
      if (!m) return null;
      return { sourceProject: m[1] ?? "*", externalId: m[2] ?? "" };
    },
    async fetchByExternalId(sourceProject: string, externalId: string) {
      return {
        sourceType: type,
        sourceProject,
        externalId,
        fingerprint: externalId,
        title: "Fake alert",
        level: "error",
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        rawPayloadS3Key: `fake:${externalId}`,
      };
    },
    configSchema: z.object({}),
    catalogEntry: {
      description: `${type} test adapter`,
      setupGuide: "",
      requiresEnvKeys: [],
      urlExamples: [],
    },
  };
}

describe("triggers — URL detection contract", () => {
  beforeEach(() => {
    registry.clear();
  });
  afterEach(() => {
    registry.clear();
  });

  it("returns null parseUrl for an unrelated URL across all sources", () => {
    registry.registerSource(
      makeFakeAdapter("posthog", /posthog\.com\/project\/(\w+)\/events\/(\w+)/),
    );
    registry.registerSource(makeFakeAdapter("pagerduty", /pagerduty\.com\/incidents\/(P\w+)/));

    for (const adapter of registry.sources.values()) {
      expect(adapter.parseUrl("https://example.org/random")).toBeNull();
    }
  });

  it("matches the right adapter when multiple are registered", () => {
    registry.registerSource(
      makeFakeAdapter("posthog", /posthog\.com\/project\/(\w+)\/events\/(\w+)/),
    );
    registry.registerSource(makeFakeAdapter("pagerduty", /pagerduty\.com\/incidents\/(P\w+)/));

    let matched: { type: string; parsed: unknown } | null = null;
    const url = "https://us.posthog.com/project/123/events/abc";
    for (const adapter of registry.sources.values()) {
      const parsed = adapter.parseUrl(url);
      if (parsed) {
        matched = { type: adapter.type, parsed };
        break;
      }
    }
    expect(matched?.type).toBe("posthog");
    expect(matched?.parsed).toEqual({ sourceProject: "123", externalId: "abc" });
  });

  it("serialized urlPatterns round-trip into a working RegExp on the client", () => {
    const adapter = makeFakeAdapter("posthog", /posthog\.com\/project\/(\w+)\/events\/(\w+)/i);
    registry.registerSource(adapter);

    const serialized = adapter.urlPatterns.map((p) => ({ source: p.source, flags: p.flags }));
    expect(serialized).toHaveLength(1);
    const rebuilt = new RegExp(serialized[0]!.source, serialized[0]!.flags);
    expect(rebuilt.test("https://us.posthog.com/project/123/events/abc")).toBe(true);
    expect(rebuilt.flags).toContain("i");
  });

  it("listSourceAdapters shape carries displayName + urlPatterns + catalogEntry", () => {
    registry.registerSource(
      makeFakeAdapter("posthog", /posthog\.com\/project\/(\w+)\/events\/(\w+)/),
    );
    registry.registerSource(makeFakeAdapter("pagerduty", /pagerduty\.com\/incidents\/(P\w+)/));

    const serialized = [...registry.sources.values()].map((adapter) => ({
      type: adapter.type,
      displayName: adapter.displayName,
      urlPatterns: adapter.urlPatterns.map((p) => ({ source: p.source, flags: p.flags })),
      catalogEntry: { ...adapter.catalogEntry },
    }));
    expect(serialized).toHaveLength(2);
    expect(serialized[0]?.type).toBe("posthog");
    expect(serialized[0]?.urlPatterns[0]?.source).toContain("posthog");
    expect(serialized[1]?.catalogEntry.description).toContain("pagerduty");
  });

  it("listSourceAdapters returns empty when registry is empty (UI shows 'configure a source')", () => {
    registry.clear();
    expect([...registry.sources.values()]).toHaveLength(0);
  });
});
