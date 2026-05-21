import { registry } from "@alertforge/core";
import { upsertAlert } from "@alertforge/source-sentry";
import { env } from "@sentry-fixer-bot/env/server";
import { Hono } from "hono";
import { archiveJson } from "../archive/s3";
import { publishJob } from "../queue/boss";
import { JOB_TRIAGE } from "../queue/jobs";

export const webhooksGeneric = new Hono();

/**
 * Generic source-adapter-driven webhook route. Accepts POSTs at
 * /webhooks/:sourceType where sourceType matches a SourceAdapter
 * registered via register-adapters.ts. The Sentry adapter still
 * answers at /webhooks/sentry through this same route — no separate
 * Sentry-specific handler exists after P2.
 *
 * Flow:
 *   1. Resolve adapter by :sourceType. 404 if unknown.
 *   2. Resolve webhook secret from env (<UPPER>_WEBHOOK_SECRET).
 *      503 if not configured.
 *   3. adapter.verifyWebhook(req, secret). 401 if invalid.
 *   4. JSON-parse body. 400 if invalid.
 *   5. adapter.parsePayload(body). 400 if null.
 *   6. adapter.dedupKey(alert), archive payload to S3.
 *   7. upsertAlert with current schema columns (Sentry-flavoured;
 *      P4 normalizes to source_type/source_project/external_id).
 *   8. publishJob(JOB_TRIAGE) only when isNew. Otherwise 202 dedup hit.
 *
 * The upsertAlert path is still Sentry-coupled because the alerts
 * table column shape predates the abstraction. P4 (triggers + schema
 * migration 0003) replaces sentryIssueId/sentryProject with
 * external_id/source_type/source_project columns. Until then, every
 * source adapter writes through these Sentry-named columns; the
 * dedup_key column already supports multi-source without rename
 * because it is opaque hash.
 */
webhooksGeneric.post("/webhooks/:sourceType", async (c) => {
  const sourceType = c.req.param("sourceType");
  const adapter = registry.sources.get(sourceType);
  if (!adapter) {
    return c.json({ error: "unknown_source", sourceType }, 404);
  }

  const secretEnvKey = `${sourceType.toUpperCase()}_WEBHOOK_SECRET` as keyof typeof env;
  const secret = env[secretEnvKey] as string | undefined;
  if (!secret) {
    return c.json({ error: "webhook_secret_not_configured", sourceType }, 503);
  }

  const raw = await c.req.text();
  const reqForAdapter = new Request(c.req.raw.url, {
    method: "POST",
    headers: c.req.raw.headers,
    body: raw,
  });
  if (!(await adapter.verifyWebhook(reqForAdapter, secret))) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const alert = adapter.parsePayload(body);
  if (!alert) {
    return c.json({ error: "could_not_parse", sourceType }, 400);
  }

  const dedup = adapter.dedupKey(alert);
  const s3Uri = await archiveJson(`alerts/${dedup}.json`, body);

  const { id, isNew } = await upsertAlert({
    sentryIssueId: alert.externalId,
    sentryProject: alert.sourceProject,
    fingerprint: alert.fingerprint,
    ...(alert.codeVersion ? { codeVersion: alert.codeVersion } : {}),
    dedupKey: dedup,
    title: alert.title,
    level: alert.level,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    rawPayloadS3: s3Uri,
  });

  if (isNew) {
    await publishJob(JOB_TRIAGE, { alertId: id });
  }
  return c.json({ ok: true, alertId: id, isNew }, 202);
});
