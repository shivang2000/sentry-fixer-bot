/**
 * `buildDigest` — assemble a `DigestPayload` for one trigger over a
 * fixed window. Pure-of-side-effects: takes already-loaded rows and
 * does the counting + ranking + cost rollup in memory.
 *
 * Top-fingerprint ranking:
 *   - Group by `fingerprint`, sum the PR count.
 *   - Track the number of those that closed unmerged ("not getting
 *     fixed" signal).
 *   - Sort desc by total count, tie-break by closed count desc.
 *   - Cap at 5 (the spec example shows top-2; 5 keeps a little room
 *     for variance without being too wordy).
 *
 * Suggested action: only when at least one fingerprint has ≥2 closed
 * PRs (signal: this fingerprint keeps getting rejected). Otherwise
 * the digest is just a roll-up with no recommendation.
 */

import type { DigestPayload, NormalizedAlert } from "@alertforge/core";

const TOP_FINGERPRINTS_CAP = 5;
const SUGGEST_THRESHOLD_CLOSED = 2;

export interface DigestPrRow {
  id: string;
  fingerprint: string;
  title: string;
  outcome: "merged_clean" | "merged_with_edits" | "closed_unmerged" | "stale_open" | null;
}

export interface DigestAlertRow {
  id: string;
  fingerprint: string;
}

export interface DigestRunRow {
  id: string;
  costCents: number;
}

export interface DigestInput {
  trigger: { id: string; name: string };
  window: { start: Date; end: Date };
  alerts: DigestAlertRow[];
  runs: DigestRunRow[];
  prs: DigestPrRow[];
  costCents: number;
  capCents: number;
}

export interface DigestEnvelope {
  body: DigestPayload;
  /**
   * Synthetic alert attached to the PipelineNotification so adapters
   * that always-deref `notification.alert` don't crash. Carries the
   * trigger's source signature in title/fingerprint so an operator
   * scanning a Slack feed can see at a glance which trigger this is.
   */
  syntheticAlert: NormalizedAlert;
}

export function buildDigest(input: DigestInput): DigestPayload {
  const { prs, alerts, window, costCents, capCents } = input;
  const alertCount = alerts.length;
  let mergedClean = 0;
  let mergedWithEdits = 0;
  let closedUnmerged = 0;
  let open = 0;
  type FpAggregate = { fingerprint: string; title: string; count: number; closed: number };
  const fpMap = new Map<string, FpAggregate>();

  for (const pr of prs) {
    if (pr.outcome === "merged_clean") mergedClean += 1;
    else if (pr.outcome === "merged_with_edits") mergedWithEdits += 1;
    else if (pr.outcome === "closed_unmerged") closedUnmerged += 1;
    else if (pr.outcome === "stale_open") open += 1;
    else open += 1; // null = still pending; surface alongside stale.

    const existing = fpMap.get(pr.fingerprint);
    if (existing) {
      existing.count += 1;
      if (pr.outcome === "closed_unmerged") existing.closed += 1;
    } else {
      fpMap.set(pr.fingerprint, {
        fingerprint: pr.fingerprint,
        title: pr.title,
        count: 1,
        closed: pr.outcome === "closed_unmerged" ? 1 : 0,
      });
    }
  }

  const topFingerprints = [...fpMap.values()]
    .sort((a, b) => b.count - a.count || b.closed - a.closed)
    .slice(0, TOP_FINGERPRINTS_CAP);

  const fixesAttempted = prs.length;

  const payload: DigestPayload = {
    windowStart: window.start,
    windowEnd: window.end,
    alertCount,
    fixesAttempted,
    mergedClean,
    mergedWithEdits,
    closedUnmerged,
    open,
    topFingerprints,
    costCents,
    capCents,
  };

  const topWithClosures = topFingerprints.find((fp) => fp.closed >= SUGGEST_THRESHOLD_CLOSED);
  if (topWithClosures) {
    payload.suggestedAction = `Review the prompt for fingerprint ${topWithClosures.fingerprint} (${topWithClosures.title.slice(0, 80)}) — ${topWithClosures.closed} closures suggest the agent is missing repo convention.`;
  }
  return payload;
}

/**
 * Build a `PipelineNotification` for the digest fan-out. The synthetic
 * alert carries the trigger's source signature so downstream adapters
 * that always render `notification.alert.title` show something useful.
 */
export function buildDigestNotification(input: {
  trigger: { id: string; name: string; sourceProject: string };
  runId: string;
  payload: DigestPayload;
  /** Cost roll-up to mirror on the top-level field (adapter UI surfaces it separately). */
  costCents?: number;
}): {
  triggerId: string;
  alert: NormalizedAlert;
  runId: string;
  status: "digest";
  digestBody: DigestPayload;
  costCents?: number;
} {
  const alert: NormalizedAlert = {
    sourceType: "digest",
    sourceProject: input.trigger.sourceProject,
    externalId: `digest:${input.trigger.id}:${input.runId}`,
    fingerprint: `digest:${input.trigger.id}`,
    title: `Daily digest — ${input.trigger.name}`,
    level: "info",
    firstSeenAt: input.payload.windowStart,
    lastSeenAt: input.payload.windowEnd,
    rawPayloadS3Key: "(digest)",
  };
  const out: ReturnType<typeof buildDigestNotification> = {
    triggerId: input.trigger.id,
    alert,
    runId: input.runId,
    status: "digest",
    digestBody: input.payload,
  };
  if (input.costCents !== undefined) out.costCents = input.costCents;
  return out;
}
