/**
 * Tests for the email digest render. Subject line, HTML body, and
 * plaintext fallback get a different layout than the per-event
 * notifications (no severity tag in subject, table-format body).
 */

import { describe, expect, it } from "bun:test";
import type { DigestPayload, PipelineNotification } from "@alertforge/core";
import { renderEmailHtml, renderEmailSubject, renderEmailText } from "./render";

function digestNotification(overrides: Partial<DigestPayload> = {}): PipelineNotification {
  const body: DigestPayload = {
    windowStart: new Date("2026-05-14T00:00:00Z"),
    windowEnd: new Date("2026-05-21T00:00:00Z"),
    alertCount: 47,
    fixesAttempted: 47,
    mergedClean: 18,
    mergedWithEdits: 12,
    closedUnmerged: 11,
    open: 6,
    topFingerprints: [
      {
        fingerprint: "fp-A",
        title: "TypeError: cannot read 'x' of undefined",
        count: 8,
        closed: 3,
      },
      { fingerprint: "fp-B", title: "ECONNREFUSED postgres", count: 5, closed: 5 },
    ],
    costCents: 4216,
    capCents: 17500,
    ...overrides,
  };
  return {
    triggerId: "t1",
    runId: "digest-2026-05-21",
    alert: {
      sourceType: "digest",
      sourceProject: "backend-api",
      externalId: "digest:t1",
      fingerprint: "digest:t1",
      title: "Daily digest — backend-api Sentry",
      level: "info",
      firstSeenAt: body.windowStart,
      lastSeenAt: body.windowEnd,
      rawPayloadS3Key: "(digest)",
    },
    status: "digest",
    digestBody: body,
    costCents: 4216,
  };
}

describe("Email digest render", () => {
  it("produces a subject without a severity tag", () => {
    const subject = renderEmailSubject(digestNotification());
    expect(subject.startsWith("[Alertforge] Digest —")).toBe(true);
    expect(subject).not.toContain("[high]");
    expect(subject).not.toContain("[medium]");
  });

  it("HTML body includes Alerts / PRs opened / Merge rate / Cost rows in a table", () => {
    const html = renderEmailHtml(digestNotification());
    expect(html).toContain("Alerts");
    expect(html).toContain("47");
    expect(html).toContain("PRs opened");
    expect(html).toContain("Merge rate");
    expect(html).toContain("Cost");
    // Should be table-based for the digest layout.
    expect(html).toMatch(/<table/);
  });

  it("HTML body lists top recurring fingerprints", () => {
    const html = renderEmailHtml(digestNotification());
    expect(html).toContain("TypeError");
    expect(html).toContain("ECONNREFUSED");
  });

  it("HTML body escapes user-supplied fingerprint titles", () => {
    const html = renderEmailHtml(
      digestNotification({
        topFingerprints: [
          {
            fingerprint: "fp-X",
            title: "<script>alert('x')</script>",
            count: 1,
            closed: 0,
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("plaintext body has key-value lines aligned", () => {
    const text = renderEmailText(digestNotification());
    expect(text).toContain("Alerts:");
    expect(text).toContain("PRs opened:");
    expect(text).toContain("Merge rate");
    expect(text).toContain("Cost:");
    // Contains the top-fingerprint section header.
    expect(text.toLowerCase()).toContain("top recurring");
  });

  it("plaintext body includes suggested action when present", () => {
    const text = renderEmailText(
      digestNotification({
        suggestedAction:
          "Review the prompt for fingerprint fp-A — 3 closures suggest the agent is missing repo convention.",
      }),
    );
    expect(text.toLowerCase()).toContain("suggested");
    expect(text).toContain("fp-A");
  });

  it("falls back to a placeholder body when digestBody is missing on status=digest", () => {
    const broken: PipelineNotification = {
      ...digestNotification(),
      digestBody: undefined,
    };
    expect(() => renderEmailHtml(broken)).not.toThrow();
    expect(() => renderEmailText(broken)).not.toThrow();
    expect(() => renderEmailSubject(broken)).not.toThrow();
  });
});
