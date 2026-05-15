import { env } from "@sentry-fixer-bot/env/server";
import { Hono } from "hono";
import { dedupKey } from "../alerts/dedup-key";
import { upsertAlert } from "../alerts/persist";
import { archiveJson } from "../archive/s3";
import { verifyHmacSha256 } from "../web/verify-hmac";

export const sentryWebhook = new Hono();

type SentryPayload = {
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

sentryWebhook.post("/webhooks/sentry", async (c) => {
  if (!env.SENTRY_WEBHOOK_SECRET) {
    return c.json({ error: "webhook_secret_not_configured" }, 503);
  }

  const raw = await c.req.text();
  const sig = c.req.header("sentry-hook-signature") ?? c.req.header("x-sentry-signature") ?? null;
  if (!verifyHmacSha256({ secret: env.SENTRY_WEBHOOK_SECRET, body: raw, headerValue: sig })) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: SentryPayload;
  try {
    payload = JSON.parse(raw) as SentryPayload;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const issue = payload.data?.issue;
  if (!issue?.id || !issue.project?.slug) {
    return c.json({ error: "missing_issue" }, 400);
  }

  const project = issue.project.slug;
  const fingerprint = issue.metadata?.fingerprint ?? issue.id;
  const codeVersion = payload.data?.event?.release;
  const dedup = dedupKey({ project, fingerprint, codeVersion });

  const s3Uri = await archiveJson(`alerts/${dedup}.json`, payload);

  const now = new Date();
  const { id, isNew } = await upsertAlert({
    sentryIssueId: issue.id,
    sentryProject: project,
    fingerprint,
    codeVersion,
    dedupKey: dedup,
    title: issue.title ?? "(no title)",
    level: issue.level ?? "error",
    firstSeenAt: now,
    lastSeenAt: now,
    rawPayloadS3: s3Uri,
  });

  // TODO(D8): enqueue triage job here when pg-boss is wired up.
  return c.json({ ok: true, alertId: id, isNew }, 202);
});
