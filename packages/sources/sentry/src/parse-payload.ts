import type { NormalizedAlert } from "@alertforge/core";
import { dedupKey } from "./dedup";

/**
 * Shape of an inbound Sentry webhook payload — only the fields we
 * actually use to construct a NormalizedAlert. Sentry's payload has
 * many more fields; everything else is archived to S3 in the route
 * handler.
 */
export type SentryPayload = {
  action?: string;
  data?: {
    issue?: {
      id?: string;
      title?: string;
      level?: string;
      project?: { slug?: string };
      metadata?: { fingerprint?: string; type?: string; value?: string };
    };
    event?: { release?: string };
  };
};

/**
 * Convert a raw Sentry webhook body into a NormalizedAlert. Returns
 * null if the payload doesn't carry the minimum fields we need
 * (issue id + project slug). The route handler turns null into a
 * 400. Computes the dedup key as well so the caller can do the
 * upsert in one DB hop.
 *
 * Callers responsibility: archive the raw body to S3 and pass
 * `rawPayloadS3Key` separately when persisting — we don't touch S3
 * from this function.
 */
export function parseSentryPayload(body: unknown): NormalizedAlert | null {
  const payload = body as SentryPayload;
  const issue = payload?.data?.issue;
  if (!issue?.id || !issue.project?.slug) return null;

  const project = issue.project.slug;
  const fingerprint = issue.metadata?.fingerprint ?? issue.id;
  const codeVersion = payload.data?.event?.release;
  const now = new Date();

  return {
    sourceType: "sentry",
    sourceProject: project,
    externalId: issue.id,
    fingerprint,
    title: issue.title ?? "(no title)",
    level: normalizeLevel(issue.level),
    firstSeenAt: now,
    lastSeenAt: now,
    ...(codeVersion ? { codeVersion } : {}),
    // route handler fills in rawPayloadS3Key after the S3 archive write
    rawPayloadS3Key: "",
  };
}

/**
 * Dedup-key helper specific to the parse-payload flow. Re-exports the
 * shared dedupKey but pre-applies the Sentry-specific (project,
 * fingerprint, codeVersion) tuple.
 */
export function dedupKeyFromAlert(alert: NormalizedAlert): string {
  return dedupKey({
    project: alert.sourceProject,
    fingerprint: alert.fingerprint,
    codeVersion: alert.codeVersion,
  });
}

function normalizeLevel(level: string | undefined): NormalizedAlert["level"] {
  if (level === "warning") return "warning";
  if (level === "info") return "info";
  return "error";
}
