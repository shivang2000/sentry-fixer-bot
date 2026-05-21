---
plan: phase-3-steps-refactor
phase: 3
status: draft
date: 2026-05-21
implements_specs:
  - pipeline-step-contract
risk: medium
size: large
---

# P3 — Steps refactor (worker.ts → step modules)

Refactor today's `apps/server/src/worker/{agent-job,triage-job,pr-followup-job}.ts` into named step modules implementing `PipelineStep` from `@alertforge/core`. **Zero user-visible behavior change**; pipeline does exactly what it does today.

## Scope

- One package per step under `packages/steps/<name>/`.
- Worker handler becomes a thin wrapper that calls `runPipeline(ctx, cfg, DEFAULT_STEPS, deps)`.
- Existing tests for individual step concerns (classify parsing, secret scan, budget decide, agent output parse, gate output parse) relocated to their step packages.

## Step packages to create

| Package | Source | LLM step? |
|---|---|---|
| `packages/steps/classify` | `apps/server/src/triage/` | yes (modelKey: classify) |
| `packages/steps/fetch-event` | `apps/server/src/triage/*` + source adapter call | no |
| `packages/steps/budget` | `apps/server/src/budget/` | no |
| `packages/steps/workspace` | `apps/server/src/agent/workspace.ts` | no |
| `packages/steps/fix-agent` | `apps/server/src/agent/{spawn,prompt,parse,render-claude-home}.ts` | yes (modelKey: fix) |
| `packages/steps/secret-scan` | `apps/server/src/agent/secret-scan.ts` | no |
| `packages/steps/test-gate` | `apps/server/src/gate/run-tests.ts` | no |
| `packages/steps/commit-push` | `apps/server/src/agent/commit-push.ts` | no |
| `packages/steps/open-pr` | `apps/server/src/github/pr.ts` + `app-auth.ts` (shared via @alertforge/github helper) | no |
| `packages/steps/review-pr` | `apps/server/src/review/` | yes (modelKey: review) |
| `packages/steps/follow-up` | `apps/server/src/worker/pr-followup-job.ts` + `pr-comment-poll-job.ts` | yes (modelKey: followUp) |
| `packages/steps/fan-out-channels` | NEW (channels not yet implemented; placeholder step that does nothing in P3) | no |

Note: `fan-out-channels` is a placeholder in P3 because channel adapters land in P5. It writes `ctx/notifications.json` as `[]`.

## Each step package layout

```
packages/steps/<name>/
  package.json                              name: @alertforge/step-<name>
  tsconfig.json
  src/index.ts                              barrel + default export of PipelineStep
  src/step.ts                               the step's run() / selectInput() / buildPrompt() / etc.
  src/__tests__/                            relocated unit tests
```

## Worker becomes thin

`apps/server/src/worker/index.ts` (after P3):

```ts
import { Boss } from '../queue/boss';
import { runPipeline, DiskCtxStore, resolvePreset, registry } from '@alertforge/core';
import { DEFAULT_STEPS } from '@alertforge/core/pipeline';   // composed from packages/steps/*
import { db } from '@alertforge/db';

await Boss.work('alertforge-pipeline', async (job) => {
  const { alertId } = job.data;
  const alert = await db.query.alerts.findFirst({ where: eq(alerts.id, alertId) });
  const trigger = await resolveTriggerForAlert(alert);
  const cfg = resolvePreset(trigger);

  const runId = await db.insert(runs).values({
    alertId,
    triggerId: trigger.id,
    status: 'triaging',
    ctxDir: `/var/lib/alertforge/runs/${crypto.randomUUID()}/ctx`,
  }).returning({ id: runs.id }).then(r => r[0].id);

  const ctx = await DiskCtxStore.create(runId);
  await ctx.write('trigger', trigger);
  await ctx.write('alert', alert);

  try {
    await runPipeline(ctx, cfg, DEFAULT_STEPS, makeDeps());
    await db.update(runs).set({ status: 'pr_opened', endedAt: new Date() }).where(eq(runs.id, runId));
  } catch (err) {
    await db.update(runs).set({ status: 'failed', error: String(err), endedAt: new Date() }).where(eq(runs.id, runId));
    throw err;
  } finally {
    await archiveCtxToS3(ctx);
    await cleanupCtxDir(ctx);
  }
});
```

Old `triage-job`/`agent-job`/`pr-followup-job` distinct queues are collapsed into the single `alertforge-pipeline` job. Backward-compat: keep old job types registered, processing forwards to the new flow for in-flight jobs.

## Tests

- Each step's relocated test file passes unchanged.
- New integration test: `worker/__tests__/full-pipeline.test.ts` runs the full DEFAULT_STEPS against fixture alert + fake source/channel registry + mocked LLM provider; asserts each ctx field is written, each `runs.steps_completed` entry appears in order.
- Behavior parity test: run the same fixture alert through old `apps/server/src/worker/agent-job.ts` (commit it as a fixture) and new pipeline; assert the resulting PR-body / commit-message / DB row state are byte-identical.

## Risk

Medium — touches every step file. Mitigations:

- Stage the refactor: P3a moves non-LLM steps (workspace, budget, secret-scan, test-gate, commit-push, open-pr); P3b moves LLM steps (classify, fix-agent, review-pr, follow-up). Each P3a/P3b lands as a separate PR with green CI.
- Keep old worker handler entry point importing the new step modules in-place during transition; no big-bang.
- Reuse the existing 120-test suite as the regression net.

## Verification

```bash
bun run check-types
bun --filter='@alertforge/step-*' test     # all step unit tests
bun --filter=@alertforge/server test       # full integration
bun run check                              # lint, including no-ctx-in-buildprompt — now actively enforces

# Smoke:
bun run dev
curl -X POST localhost:3000/webhooks/sentry -d @fixtures/sentry-payload.json
# observe ctx/ dir populating with files as steps complete
ls /var/lib/alertforge/runs/<runId>/ctx/
```

## Commit

```
refactor(steps): split worker into named step modules

Decompose apps/server/src/worker/{agent-job,triage-job,pr-followup-job}.ts
into one workspace package per step under packages/steps/. Each step
implements PipelineStep from @alertforge/core; the worker becomes a
thin wrapper around runPipeline(ctx, cfg, DEFAULT_STEPS, deps).

LLM-bearing steps (classify, fix-agent, review-pr, follow-up) use
wrapLlmStep with explicit selectInput/buildPrompt projection — the
no-ctx-in-buildprompt CI lint rule now actively enforces the ctx
boundary. No user-visible behavior change.

Spec: docs/alertforge/specs/2026-05-21-pipeline-step-contract.md
Plan: docs/alertforge/plans/2026-05-21-phase-3-steps-refactor.md

Constraint: no behavior change (D2 spec scope)
Constraint: each LLM step must implement LlmStep + wrapLlmStep (ADR-0006 lint)
Rejected: keep step logic inside worker handlers | obscures structure,
          can't reuse across pipelines, harder to test in isolation
Confidence: medium
Scope-risk: moderate
Directive: New step packages must export their step as default, follow
           the @alertforge/step-* naming convention, and live under
           packages/steps/<name>/.
Not-tested: channel fan-out (placeholder until P5); restart-resume (V2)
```
