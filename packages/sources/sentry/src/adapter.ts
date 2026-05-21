import type { NormalizedAlert, SourceAdapter, SourceDeps } from "@alertforge/core";
import { verifyHmacSha256 } from "@alertforge/core";
import { sentryConfigSchema } from "./config.schema";
import { dedupKey } from "./dedup";
import { parseSentryPayload } from "./parse-payload";
import { parseSentryUrl, SENTRY_URL_PATTERNS } from "./parse-url";
import { postIssueComment } from "./post-comment";
import { extractStackTrace, getLatestEvent } from "./sentry-client";
import { SENTRY_SETUP_GUIDE } from "./setup-guide";

const SENTRY_API_BASE = "https://sentry.io/api/0";

type SentryIssueDetail = {
  id: string;
  shortId?: string;
  title?: string;
  level?: string;
  project?: { slug?: string; name?: string };
  firstSeen?: string;
  lastSeen?: string;
  metadata?: { type?: string; value?: string };
};

/**
 * Sentry source adapter. Conforms to SourceAdapter from @alertforge/core.
 * Registered at server boot via apps/server/src/register-adapters.ts.
 *
 * Reads SENTRY_WEBHOOK_SECRET via the route handler (passed to
 * verifyWebhook). Reads SENTRY_API_TOKEN via getSentryToken() from
 * @sentry-fixer-bot/api/run/sentry-runner (existing helper that
 * prefers env then falls back to the sentry CLI's stored token).
 *
 * P3 will refactor consumers to pass token via SourceDeps.apiToken;
 * for now the moved helpers retain their original token-resolution
 * behavior to keep the diff focused on relocation.
 */
const adapter: SourceAdapter = {
  type: "sentry",
  displayName: "Sentry",
  webhookPath: "/webhooks/sentry",

  async verifyWebhook(req: Request, secret: string) {
    // Sentry sends two header names depending on integration vintage;
    // accept either. The route handler passes the raw body string via
    // c.req.text() before calling us — we re-read here for adapter
    // self-containment. Hono lets us read the body twice when we use
    // c.req.text() on the raw Request.
    const sig = req.headers.get("sentry-hook-signature") ?? req.headers.get("x-sentry-signature");
    const raw = await req.clone().text();
    return verifyHmacSha256({ secret, body: raw, headerValue: sig });
  },

  parsePayload(body) {
    return parseSentryPayload(body);
  },

  async fetchEventDetail(alert, _deps: SourceDeps) {
    const event = await getLatestEvent(alert.externalId);
    if (!event) return alert;
    return {
      ...alert,
      stackTrace: extractStackTrace(event),
    };
  },

  dedupKey(alert) {
    return dedupKey({
      project: alert.sourceProject,
      fingerprint: alert.fingerprint,
      codeVersion: alert.codeVersion,
    });
  },

  async postAlertComment(alert, message, _deps: SourceDeps) {
    await postIssueComment(alert.externalId, message);
  },

  urlPatterns: SENTRY_URL_PATTERNS,
  parseUrl: parseSentryUrl,

  async fetchByExternalId(sourceProject, externalId, _deps: SourceDeps): Promise<NormalizedAlert> {
    const { getSentryToken } = await import("@sentry-fixer-bot/api/run/sentry-runner");
    const token = await getSentryToken();
    if (!token) {
      throw new Error("Sentry not configured — set SENTRY_API_TOKEN or run `sentry auth login`");
    }

    const res = await fetch(`${SENTRY_API_BASE}/issues/${externalId}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Sentry returned ${res.status} for issue ${externalId}`);
    }
    const issue = (await res.json()) as SentryIssueDetail;

    const project = issue.project?.slug ?? sourceProject;
    if (project === "*") {
      throw new Error("Sentry issue did not carry a project slug; cannot resolve trigger");
    }

    return {
      sourceType: "sentry",
      sourceProject: project,
      externalId: issue.id,
      fingerprint: issue.shortId ?? issue.id,
      title: issue.title ?? "(no title)",
      level: normalizeLevel(issue.level),
      firstSeenAt: issue.firstSeen ? new Date(issue.firstSeen) : new Date(),
      lastSeenAt: issue.lastSeen ? new Date(issue.lastSeen) : new Date(),
      rawPayloadS3Key: `manual:sentry:${issue.id}`,
    };
  },

  configSchema: sentryConfigSchema,
  catalogEntry: {
    description: "Triage and fix Sentry error issues.",
    setupGuide: SENTRY_SETUP_GUIDE,
    requiresEnvKeys: ["SENTRY_WEBHOOK_SECRET", "SENTRY_API_TOKEN", "SENTRY_ORG_SLUG"],
    urlExamples: [
      "https://acme.sentry.io/issues/12345/",
      "https://sentry.io/organizations/acme/issues/12345/",
      "https://sentry.io/issues/12345/",
    ],
  },
};

function normalizeLevel(level: string | undefined): NormalizedAlert["level"] {
  if (level === "warning") return "warning";
  if (level === "info") return "info";
  return "error";
}

export default adapter;
