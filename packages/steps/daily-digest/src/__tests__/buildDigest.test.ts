/**
 * Tests for `buildDigest` — assembles a `DigestPayload` for one trigger
 * from raw runs + PRs + budget fixtures.
 *
 * Verifies:
 *   - merge-rate math: counts each outcome correctly.
 *   - alertCount counts unique alerts in the 7d window.
 *   - topFingerprints groups by fingerprint, sorts by count desc, and
 *     includes the closed-count per fingerprint.
 *   - cost vs cap rollup.
 *   - suggestedAction populated when there's at least one frequently-
 *     closing fingerprint; absent otherwise.
 *   - empty input → zeros, no top fingerprints, no suggestion.
 */

import { describe, expect, it } from "bun:test";
import { buildDigest, type DigestInput } from "../build-digest";

function makeInput(overrides: Partial<DigestInput> = {}): DigestInput {
  const baseInput: DigestInput = {
    trigger: {
      id: "t1",
      name: "backend-api Sentry",
    },
    window: {
      start: new Date("2026-05-14T00:00:00Z"),
      end: new Date("2026-05-21T00:00:00Z"),
    },
    alerts: [],
    runs: [],
    prs: [],
    costCents: 0,
    capCents: 17500,
  };
  return { ...baseInput, ...overrides };
}

describe("buildDigest", () => {
  it("returns all-zero counts when the window had no activity", () => {
    const digest = buildDigest(makeInput());
    expect(digest.alertCount).toBe(0);
    expect(digest.fixesAttempted).toBe(0);
    expect(digest.mergedClean).toBe(0);
    expect(digest.mergedWithEdits).toBe(0);
    expect(digest.closedUnmerged).toBe(0);
    expect(digest.open).toBe(0);
    expect(digest.topFingerprints).toEqual([]);
    expect(digest.suggestedAction).toBeUndefined();
  });

  it("counts each outcome correctly and aggregates open + stale PRs into `open`", () => {
    // "open" in the digest payload covers both pending (null outcome)
    // and stale_open (>14d, still open) — both represent PRs that never
    // hit merge or reject. The split lives in the prs row, but a 7-day
    // roll-up reads cleaner with one bucket.
    const digest = buildDigest(
      makeInput({
        prs: [
          { id: "p1", fingerprint: "fp-A", title: "Null deref", outcome: "merged_clean" },
          { id: "p2", fingerprint: "fp-A", title: "Null deref", outcome: "merged_clean" },
          { id: "p3", fingerprint: "fp-B", title: "ECONN", outcome: "merged_with_edits" },
          { id: "p4", fingerprint: "fp-C", title: "Timeout", outcome: "closed_unmerged" },
          { id: "p5", fingerprint: "fp-C", title: "Timeout", outcome: "closed_unmerged" },
          { id: "p6", fingerprint: "fp-D", title: "Pending", outcome: null },
          { id: "p7", fingerprint: "fp-D", title: "Pending", outcome: null },
          { id: "p8", fingerprint: "fp-E", title: "Stale", outcome: "stale_open" },
        ],
        runs: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, costCents: 100 })),
      }),
    );
    expect(digest.fixesAttempted).toBe(8);
    expect(digest.mergedClean).toBe(2);
    expect(digest.mergedWithEdits).toBe(1);
    expect(digest.closedUnmerged).toBe(2);
    expect(digest.open).toBe(3); // 2 pending + 1 stale_open
  });

  it("sorts topFingerprints by count desc and pairs with closed-count", () => {
    const digest = buildDigest(
      makeInput({
        prs: [
          { id: "p1", fingerprint: "fp-A", title: "TypeErr A", outcome: "closed_unmerged" },
          { id: "p2", fingerprint: "fp-A", title: "TypeErr A", outcome: "closed_unmerged" },
          { id: "p3", fingerprint: "fp-A", title: "TypeErr A", outcome: "stale_open" },
          { id: "p4", fingerprint: "fp-B", title: "ECONN", outcome: "closed_unmerged" },
          { id: "p5", fingerprint: "fp-C", title: "Once", outcome: "merged_clean" },
        ],
      }),
    );
    expect(digest.topFingerprints[0]?.fingerprint).toBe("fp-A");
    expect(digest.topFingerprints[0]?.count).toBe(3);
    expect(digest.topFingerprints[0]?.closed).toBe(2);
    expect(digest.topFingerprints[1]?.fingerprint).toBe("fp-B");
    // Fingerprints with a single merged-clean shouldn't outrank fp-A.
    // Cap default = 5.
    expect(digest.topFingerprints.length).toBeLessThanOrEqual(5);
  });

  it("counts unique alerts (not runs) in the window", () => {
    const digest = buildDigest(
      makeInput({
        alerts: [
          { id: "a1", fingerprint: "fp-A" },
          { id: "a2", fingerprint: "fp-A" },
          { id: "a3", fingerprint: "fp-B" },
        ],
      }),
    );
    expect(digest.alertCount).toBe(3);
  });

  it("rolls up cost + cap and computes a suggested action when closed PRs cluster", () => {
    const digest = buildDigest(
      makeInput({
        costCents: 4216,
        capCents: 17500,
        prs: [
          { id: "p1", fingerprint: "fp-A", title: "Recurring", outcome: "closed_unmerged" },
          { id: "p2", fingerprint: "fp-A", title: "Recurring", outcome: "closed_unmerged" },
          { id: "p3", fingerprint: "fp-A", title: "Recurring", outcome: "closed_unmerged" },
        ],
      }),
    );
    expect(digest.costCents).toBe(4216);
    expect(digest.capCents).toBe(17500);
    expect(digest.suggestedAction).toBeDefined();
    expect(typeof digest.suggestedAction).toBe("string");
    expect(digest.suggestedAction!).toContain("fp-A");
  });

  it("omits suggestedAction when no fingerprint is closing repeatedly", () => {
    const digest = buildDigest(
      makeInput({
        prs: [{ id: "p1", fingerprint: "fp-A", title: "Once", outcome: "merged_clean" }],
      }),
    );
    expect(digest.suggestedAction).toBeUndefined();
  });
});
