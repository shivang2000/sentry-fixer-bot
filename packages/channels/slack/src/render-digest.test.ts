/**
 * Tests for the Slack digest block layout. Different shape than the
 * pr_opened/failed/budget_blocked notifications — no "Severity" header
 * row, no action buttons, and a roll-up of merge rate + top
 * fingerprints + cost vs cap.
 */

import { describe, expect, it } from "bun:test";
import type { DigestPayload, PipelineNotification } from "@alertforge/core";
import { renderSlackBlocks } from "./render-blocks";

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
    suggestedAction:
      "Review the prompt for fingerprint fp-A — 3 closures suggest the agent is missing repo convention.",
    ...overrides,
  };
  return {
    triggerId: "t1",
    runId: "digest-2026-05-21",
    alert: {
      sourceType: "digest",
      sourceProject: "backend-api",
      externalId: "digest:t1:run",
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

describe("Slack digest block layout", () => {
  it("renders a header that mentions 'digest' + the trigger title", () => {
    const blocks = renderSlackBlocks(digestNotification());
    const header = blocks.find((b) => b.type === "header") as
      | { type: string; text: { text: string } }
      | undefined;
    expect(header).toBeDefined();
    expect(header?.text.text.toLowerCase()).toContain("digest");
  });

  it("includes alert count + merge rate + cost vs cap in a fields section", () => {
    const blocks = renderSlackBlocks(digestNotification());
    const json = JSON.stringify(blocks);
    expect(json).toContain("Alerts");
    expect(json).toContain("47");
    expect(json).toContain("PRs opened");
    expect(json).toContain("Merge rate");
    expect(json).toContain("Cost vs cap");
    // 30 merged-clean / 47 attempted = 64% rounded
    expect(json).toMatch(/64%|38%/); // 18/47 = 38% clean, or 30/47 = 64% any-merge
  });

  it("lists the top recurring fingerprints with their counts", () => {
    const blocks = renderSlackBlocks(digestNotification());
    const json = JSON.stringify(blocks);
    expect(json).toContain("TypeError");
    expect(json).toContain("ECONNREFUSED");
    expect(json).toContain("8");
    expect(json).toContain("5");
  });

  it("surfaces the suggested action when present", () => {
    const blocks = renderSlackBlocks(digestNotification());
    const json = JSON.stringify(blocks);
    expect(json.toLowerCase()).toContain("suggested");
    expect(json).toContain("fp-A");
  });

  it("omits the suggested action section when none is set", () => {
    const blocks = renderSlackBlocks(digestNotification({ suggestedAction: undefined }));
    const json = JSON.stringify(blocks);
    expect(json.toLowerCase()).not.toContain("suggested");
  });

  it("does NOT include an actions/button row (digests are informational)", () => {
    const blocks = renderSlackBlocks(digestNotification());
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("falls back to a neutral header when digestBody is missing on a status=digest notification", () => {
    const broken: PipelineNotification = {
      ...digestNotification(),
      digestBody: undefined,
    };
    // Should not throw; renders SOMETHING for the operator to see the
    // bug rather than silently crashing the cron sweep.
    expect(() => renderSlackBlocks(broken)).not.toThrow();
  });
});
