---
plan: phase-2-sentry-refit
phase: 2
status: draft
date: 2026-05-21
implements_specs:
  - source-adapter-contract
risk: low
size: medium
---

# P2 — Sentry source adapter refit

Refit today's Sentry-specific code into the new `SourceAdapter` shape. **Zero user-visible behavior change**; webhook still hits `/webhooks/sentry`, dedup still computes the same keys, comment-posting still works.

## Scope

- Create `packages/sources/sentry/` with `SourceAdapter` export.
- Move existing logic into the new package, preserving function signatures + tests.
- Add `urlPatterns`, `parseUrl`, `fetchByExternalId` for manual URL trigger parity (D17).
- Add generic webhook route `POST /webhooks/:sourceType`; keep `POST /webhooks/sentry` as a back-compat wrapper.

## File-level changes

### Add

```
packages/sources/sentry/
  package.json                              name: @alertforge/source-sentry
  tsconfig.json
  src/index.ts                              barrel export
  src/adapter.ts                            default export: SourceAdapter
  src/config.schema.ts                      zod schema for per-source-project config
  src/dedup.ts                              moved from apps/server/src/alerts/dedup-key.ts
  src/url-parser.ts                         parseUrl + urlPatterns
  src/setup-guide.md                        rendered in UI catalog page
  src/__tests__/dedup.test.ts               existing 6 tests moved here
  src/__tests__/parse-payload.test.ts       existing fixture-based tests moved here
  src/__tests__/verify-webhook.test.ts      existing 5 HMAC tests moved here
  src/__tests__/parse-url.test.ts           new — positive + negative URL fixtures
  src/__tests__/fetch-by-external-id.test.ts new — mocked HTTP

apps/server/src/routes/webhooks-generic.ts  POST /webhooks/:sourceType handler

apps/server/src/register-adapters.ts        explicit boot-time registry
                                            registration (called from index.ts);
                                            replaces planned Bun.glob discovery

packages/alertforge-core/src/hmac.ts        moved from apps/server/src/web/verify-hmac.ts;
                                            now shared util for any adapter
packages/alertforge-core/src/hmac.test.ts   relocated 5 tests

docs/alertforge/catalog/sources.md          add Sentry row
```

### Modify

```
packages/alertforge-core/src/registry.ts    actually call Bun.glob at boot
                                            (was no-op in P1)

apps/server/src/index.ts                    mount /webhooks/:sourceType
                                            keep /webhooks/sentry as compat wrapper

packages/env/src/server.ts                  ensure SENTRY_WEBHOOK_SECRET and
                                            SENTRY_API_TOKEN are still validated
```

### Move (preserve git blame via `git mv`)

```
apps/server/src/sentry/client.ts          → packages/sources/sentry/src/sentry-client.ts
apps/server/src/sentry/comment.ts         → packages/sources/sentry/src/post-comment.ts
apps/server/src/alerts/dedup-key.ts       → packages/sources/sentry/src/dedup.ts
apps/server/src/alerts/dedup-key.test.ts  → packages/sources/sentry/src/dedup.test.ts
apps/server/src/alerts/persist.ts         → packages/sources/sentry/src/alert-upsert.ts
                                            (still imports @sentry-fixer-bot/db; that
                                            renames in P7)
apps/server/src/web/verify-hmac.ts        → packages/alertforge-core/src/hmac.ts
apps/server/src/web/verify-hmac.test.ts   → packages/alertforge-core/src/hmac.test.ts
```

Note: `apps/server/tests/helpers/fixtures.ts` mentioned in earlier draft does not exist;
parsePayload fixtures will be authored fresh under
`packages/sources/sentry/src/parse-payload.test.ts` (was sentry-webhook inlined parsing).

### Adjust imports (no move, just update path)

```
apps/server/src/routes/github-webhook.ts  imports verifyHmacSha256 — repoint to
                                          @alertforge/core
apps/server/src/worker/sentry-poll-job.ts uses getSentryToken + sentry-runner;
                                          left intact in P2 (refactor into a step in P3)
apps/server/src/routes/sentry-webhook.ts  rewrite to use adapter.verifyWebhook /
                                          adapter.parsePayload via registry; keeps
                                          /webhooks/sentry path for back-compat
```

### Delete (after consumers updated)

- `apps/server/src/sentry/` (empty dir after moves)
- `apps/server/src/alerts/` (empty dir after moves)
- `apps/server/src/web/verify-hmac.ts` + `.test.ts` (replaced by @alertforge/core/hmac)

## Concrete contract

`packages/sources/sentry/src/adapter.ts`:

```ts
import type { SourceAdapter } from '@alertforge/core';
import { verifySentryHmac } from './sentry-client';
import { parseSentryPayload, fetchSentryEvent, fetchSentryIssue } from './sentry-client';
import { sentryDedupKey } from './dedup';
import { parseSentryUrl, SENTRY_URL_PATTERNS } from './url-parser';
import { postSentryComment } from './post-comment';
import { sentryConfigSchema } from './config.schema';
import setupGuide from './setup-guide.md' with { type: 'text' };

const adapter: SourceAdapter = {
  type: 'sentry',
  displayName: 'Sentry',
  webhookPath: '/webhooks/sentry',
  verifyWebhook: (req, secret) => verifySentryHmac(req, secret),
  parsePayload: (body) => parseSentryPayload(body),
  fetchEventDetail: (alert, deps) => fetchSentryEvent(alert, deps),
  dedupKey: sentryDedupKey,
  postAlertComment: postSentryComment,
  urlPatterns: SENTRY_URL_PATTERNS,
  parseUrl: parseSentryUrl,
  fetchByExternalId: async (sourceProject, externalId, deps) => {
    return await fetchSentryIssue(sourceProject, externalId, deps);
  },
  configSchema: sentryConfigSchema,
  catalogEntry: {
    description: 'Triage and fix Sentry error issues.',
    setupGuide,
    requiresEnvKeys: ['SENTRY_WEBHOOK_SECRET', 'SENTRY_API_TOKEN'],
    urlExamples: [
      'https://acme.sentry.io/issues/12345/',
      'https://sentry.io/organizations/acme/issues/12345/',
    ],
  },
};

export default adapter;
```

`packages/sources/sentry/src/url-parser.ts`:

```ts
export const SENTRY_URL_PATTERNS: RegExp[] = [
  /sentry\.io\/organizations\/[^\/]+\/issues\/(\d+)/,
  /sentry\.io\/issues\/(\d+)/,
  /([a-z0-9-]+)\.sentry\.io\/issues\/(\d+)/,
];

export function parseSentryUrl(url: string): { sourceProject: string; externalId: string } | null {
  for (const pattern of SENTRY_URL_PATTERNS) {
    const m = url.match(pattern);
    if (m) {
      // We do not always know the project from the URL alone. Return externalId
      // and let the trigger resolver look up the matching trigger by
      // fetching the issue and reading its project slug, OR by the
      // unique-issue-id-globally property.
      return { sourceProject: '*', externalId: m[m.length - 1] };
    }
  }
  return null;
}
```

For Sentry, the URL doesn't reliably encode the project; resolution is done in the trigger router by fetching the issue details and matching `triggers.source_project` against the issue's project slug.

## `apps/server/src/routes/webhooks-generic.ts`

```ts
import { Hono } from 'hono';
import { registry } from '@alertforge/core';
import { alertsUpsert, archivePayload, enqueuePipeline } from '@alertforge/db';

export const webhooksRouter = new Hono()
  .post('/:sourceType', async (c) => {
    const sourceType = c.req.param('sourceType');
    const adapter = registry.sources.get(sourceType);
    if (!adapter) return c.text('Unknown source', 404);

    const secret = process.env[`${sourceType.toUpperCase()}_WEBHOOK_SECRET`];
    if (!secret) return c.text('Adapter not configured', 503);

    const valid = await adapter.verifyWebhook(c.req, secret);
    if (!valid) return c.text('Invalid signature', 401);

    const body = await c.req.json();
    const alert = adapter.parsePayload(body);
    if (!alert) return c.text('Could not parse', 400);

    const dedupKey = adapter.dedupKey(alert);
    const archived = await archivePayload(body, dedupKey);
    alert.rawPayloadS3Key = archived.key;

    const { alertId, isNew } = await alertsUpsert(alert, dedupKey);
    if (isNew) await enqueuePipeline({ alertId, sourceType });

    return c.json({ ok: true, alertId, isNew }, 202);
  });
```

Old `/webhooks/sentry` handler becomes:

```ts
.post('/sentry', (c) => webhooksRouter.fetch(new Request(c.req.raw.url.replace('/webhooks/sentry', '/webhooks/sentry'), c.req.raw)))
```

Or simpler: register the same handler twice with different paths.

## Tests

- All existing Sentry tests (HMAC verify, dedup, parsePayload) pass without semantic change.
- New `parseSentryUrl` tests:
  - `https://acme.sentry.io/issues/12345/` → `{ externalId: '12345', sourceProject: '*' }`
  - `https://wrong.example.com/issues/12345/` → null
  - 5+ fixture URLs
- `fetchByExternalId` mocked HTTP returning a Sentry issue JSON → produces `NormalizedAlert` with correct shape.
- Webhook integration: POST to `/webhooks/sentry` and `/webhooks/sentry` (both routes) returns 202 with the same `alertId`.

## Verification

```bash
bun --filter=@alertforge/source-sentry test
bun --filter=@alertforge/server test                   # integration tests for webhook
bun run check-types
bun run check                                           # lint passes (no-ctx-in-buildprompt: no LLM steps yet in this PR)

# Smoke:
bun run dev
curl -X POST localhost:3000/webhooks/sentry -d @fixtures/sentry-payload.json
# expect 202 + alertId
curl -X POST localhost:3000/webhooks/sentry -d @fixtures/sentry-payload.json
# expect 202 + isNew=false (dedup hit)
```

## Commit

```
refactor(sentry): move to @alertforge/source-sentry adapter

Refit Sentry-specific code into the new SourceAdapter shape from
@alertforge/core. Existing logic preserved (HMAC verify, dedup key,
parsePayload, event fetch, alert comment); only relocation +
interface conformance. All existing tests retained at their new home.

Add parseUrl + fetchByExternalId for manual URL trigger parity (D17).

Add generic POST /webhooks/:sourceType route in apps/server/src/routes/
webhooks-generic.ts; old POST /webhooks/sentry still works (backward
compat for in-flight Sentry deliveries).

Spec: docs/alertforge/specs/2026-05-21-source-adapter-contract.md
Plan: docs/alertforge/plans/2026-05-21-phase-2-sentry-refit.md

Constraint: no user-visible behavior change (D2 spec scope)
Rejected: in-place SourceAdapter interface on existing files | poor type
          checking, lossy migration; relocation is cleaner
Confidence: high
Scope-risk: narrow
Directive: When adding a new source adapter, follow the Sentry adapter
shape; tests live alongside in src/__tests__/.
Not-tested: live PostHog/PagerDuty (no adapters yet)
```
