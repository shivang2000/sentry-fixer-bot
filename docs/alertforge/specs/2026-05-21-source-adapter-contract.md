---
spec: source-adapter-contract
title: Source adapter contract
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0004-code-registry-not-db-adapters
related_specs:
  - pluggable-pipeline-design
plan_phases:
  - 2026-05-21-phase-1-core-abstraction
  - 2026-05-21-phase-2-sentry-refit
---

# Source adapter contract

Source adapters are the inbound boundary of the pipeline. One adapter per source vendor (Sentry, PostHog, PagerDuty, …). Each ships as a TS module under `packages/sources/<name>/`.

## Interface

```ts
// packages/alertforge-core/src/types.ts
export interface SourceAdapter {
  type: string;                                   // 'sentry'
  displayName: string;                            // 'Sentry'
  webhookPath: string;                            // '/webhooks/sentry' (kept for back-compat; also at /webhooks/:type)

  // Webhook ingress
  verifyWebhook(req: HonoRequest, secret: string): Promise<boolean>;
  parsePayload(body: unknown): NormalizedAlert | null;
  fetchEventDetail?(alert: NormalizedAlert, deps: SourceDeps): Promise<EnrichedAlert>;
  dedupKey(alert: NormalizedAlert): string;
  postAlertComment?(alert: NormalizedAlert, message: string, deps: SourceDeps): Promise<void>;

  // Manual URL trigger (parity with today's Sentry-URL trigger)
  urlPatterns: RegExp[];                          // identify a URL as belonging to this source
  parseUrl(url: string): { sourceProject: string; externalId: string } | null;
  fetchByExternalId(
    sourceProject: string,
    externalId: string,
    deps: SourceDeps,
  ): Promise<NormalizedAlert>;                    // produces same shape as parsePayload would

  // Per-source-project install config
  configSchema: z.ZodSchema;
  catalogEntry: {
    description: string;
    setupGuide: string;                           // markdown rendered in UI catalog
    requiresEnvKeys: string[];                    // env keys this adapter needs
    urlExamples: string[];                        // shown in manual-trigger UI placeholder
  };
}
```

## Normalized types

```ts
export interface NormalizedAlert {
  sourceType: string;
  sourceProject: string;
  externalId: string;                             // sentry issue id, posthog event uuid, pagerduty incident key
  fingerprint: string;
  title: string;
  level: 'error' | 'warning' | 'info';
  firstSeenAt: Date;
  lastSeenAt: Date;
  codeVersion?: string;
  rawPayloadS3Key: string;                        // populated after archive
}

export interface EnrichedAlert extends NormalizedAlert {
  stackTrace?: string;
  breadcrumbs?: Array<{ ts: Date; category: string; message: string }>;
  affectedUsers?: number;
  eventCount24h?: number;
}

export interface SourceDeps {
  apiToken?: string;                              // pulled from env per adapter requiresEnvKeys
  httpClient: HttpClient;                         // shared fetch wrapper with retries
  log: Logger;
}
```

## Registry discovery

```ts
// packages/alertforge-core/src/registry.ts
const sourceModules = await Bun.glob('packages/sources/*/adapter.ts');
for (const path of sourceModules) {
  const mod = await import(path);
  registry.sources.set(mod.default.type, mod.default);
}
```

Discovery runs once at process boot. No hot reload (see ADR-0004).

## Webhook routing

`apps/server/src/routes/webhooks-generic.ts` mounts:

```
POST /webhooks/:sourceType
```

For back-compat, today's `POST /webhooks/sentry` continues to work and is functionally `POST /webhooks/sentry` mapped through the new generic route to the Sentry adapter.

Handler flow:
1. Look up adapter by `:sourceType` in registry. 404 if unknown.
2. Resolve adapter secret from env (`<UPPER(type)>_WEBHOOK_SECRET`, e.g. `SENTRY_WEBHOOK_SECRET`).
3. `await adapter.verifyWebhook(req, secret)` — reject 401 if false.
4. `await adapter.parsePayload(body)` — return 400 if null.
5. Compute `dedupKey = adapter.dedupKey(alert)`.
6. Alert upsert + dedup hit check (existing logic).
7. Archive raw payload to S3 (existing pattern).
8. Enqueue pipeline job for the resolved trigger.
9. Return 202.

## Manual URL trigger flow

The UI surface (see [ui-surface](2026-05-21-ui-surface.md)) exposes a "Trigger fix from URL" input. The flow:

1. User pastes URL.
2. Frontend calls `triggers.detectUrl({ url })`.
3. Backend walks `registry.sources.values()` and finds the first adapter where `urlPatterns.some(p => p.test(url))`.
4. `adapter.parseUrl(url)` extracts `{ sourceProject, externalId }`.
5. Backend looks up trigger row matching `(adapter.type, sourceProject, ...)`.
6. UI shows: detected source, matching trigger, preset, [Run] button.
7. On Run, backend calls `triggers.runFromUrl({ url, mode? })`:
   - `await adapter.fetchByExternalId(sourceProject, externalId, deps)` → `NormalizedAlert`
   - Same `alerts.upsert` + dedup as webhook path.
   - Enqueue pipeline; return `{ runId }`.

## Authoring a new adapter — checklist

1. Create `packages/sources/<name>/`:
   - `package.json` (name: `@alertforge/source-<name>`, type: module)
   - `src/adapter.ts` (default export conforming to `SourceAdapter`)
   - `src/config.schema.ts` (zod schema for per-source-project install config)
   - `src/setup-guide.md` (rendered in UI catalog page)
   - `tests/` (parsePayload fixtures, parseUrl positive + negative, dedupKey parity)
2. Add the env keys it needs to `packages/env/src/server.ts` (zod-validated).
3. Add a row to `docs/alertforge/catalog/sources.md`.
4. PR the change; CI runs the new tests automatically.
5. After merge + deploy, the adapter is discoverable in the UI catalog. Users add a trigger via wizard.

## Tests

- `parsePayload`: positive fixtures (real Sentry payload, real PostHog event), negative (malformed, wrong shape).
- `dedupKey`: parity with today's `alerts/dedup-key.ts` for Sentry; per-adapter for others.
- `verifyWebhook`: HMAC-valid + invalid + missing-header cases.
- `parseUrl`: per-adapter positive + negative URL patterns.
- `fetchByExternalId`: mocked HTTP responses returning expected `NormalizedAlert` shape.

## Sentry adapter (V1) — implementation notes

Refits today's `apps/server/src/sentry/{client,comment}.ts` + `apps/server/src/alerts/{dedup-key,persist}.ts` into the new shape. No logic change; module relocation + interface conformance only. Test parity with existing 6 dedup-key tests + 5 HMAC tests retained.

`urlPatterns`:
```ts
[
  /sentry\.io\/organizations\/[^\/]+\/issues\/(\d+)/,
  /sentry\.io\/issues\/(\d+)/,
  /(?:[a-z0-9-]+\.)sentry\.io\/issues\/(\d+)/,    // custom subdomain
]
```

`parseUrl`: extracts `issueId` via regex; resolves `sourceProject` from a Sentry API lookup if not in URL, or from the trigger lookup match.

## Future sources (catalog, not yet implemented)

| Source | Webhook style | Notes |
|---|---|---|
| PostHog | event-based (alerts on insights) | Adapter likely converts a PostHog alert webhook + event ID into `NormalizedAlert` |
| PagerDuty | incident webhook v3 | High signal — incident itself is the alert; codeVersion likely absent |
| OpsGenie | alert webhook | Similar to PagerDuty |
| Datadog | monitor webhook | Aggregates host/service signal |
