---
plan: phase-3c-worker-flip
phase: 3c
status: accepted
date: 2026-05-21
authors: ops
implements_specs:
  - pipeline-step-contract
  - disk-context-store
  - pluggable-pipeline-design
adrs:
  - ADR-0001-disk-vs-memory-ctx-store
  - ADR-0006-step-modules-not-step-per-job
related_plans:
  - phase-1-core-abstraction
  - phase-2-sentry-refit
  - phase-3-steps-refactor
risk: high (touches production hot path)
size: large
expected_commits: 2 (P3c.1 wrappers + integration test, P3c.2 worker flip)
tdd: integration test first + per-step unit tests
---

# P3c — agent-job.ts → runPipeline(ctx, cfg, DEFAULT_STEPS, deps)

The behavioral flip. Replaces the ~500 LOC `processAgentJob` body with
a thin wrapper that creates a `DiskCtxStore`, resolves the trigger
config, and calls `runPipeline` against the canonical step list.
Legacy step modules (already relocated in P3a/P3b/P3b.2/P3b.3) get
`PipelineStep` wrappers that bridge ctx I/O to their existing function
signatures.

This phase is the actual switchover. Everything before P3c was
preparatory refactor with zero behavior change; P3c flips the worker
to drive through the new abstraction.

## Scope (locked decisions from 2026-05-21 brainstorming)

| # | Decision |
|---|---|
| D1 | **Two-PR sequence.** P3c.1 ships wrappers + integration test in parallel to legacy worker (zero behavior change). P3c.2 flips the worker over. Each PR independently revertible. |
| D2 | **TDD strategy: integration test first + per-step unit tests.** End-to-end pipeline test written first (red), wrappers built until green, with focused unit tests on each wrapper's selectInput / parseOutput / applyToCtx. |
| D3 | **Background-agent execution.** Spawn Opus 4.7 background agent with max effort to ship both PRs. Agent has self-contained brief; this doc is its source of truth. |
| D4 | **Primary path only.** Only `apps/server/src/worker/agent-job.ts` flips in P3c.2. `pr-followup-job.ts` stays on legacy path; flip lands in P3c.3 (separate session) once primary path proves stable. |

## Architecture

### After P3c.2: agent-job.ts shape

```ts
import { runPipeline, DiskCtxStore, resolvePreset } from "@alertforge/core";
import { DEFAULT_STEPS } from "../pipeline/default-steps";
import { buildPipelineDeps } from "../pipeline/deps-factory";

export async function processAgentJob(payload: AgentJob): Promise<void> {
  const run = await findRunById(payload.runId);
  if (!run) return;
  const alert = await findAlertById(payload.alertId);
  if (!alert) return;
  const trigger = await resolveTriggerForRun(run, alert);
  if (!trigger) {
    await updateRun(payload.runId, { status: "no_repo_match", endedAt: new Date() });
    return;
  }

  const cfg = resolvePreset(trigger);
  const ctx = await DiskCtxStore.create(payload.runId, env.WORK_DIR);
  await ctx.write("trigger", trigger);
  await ctx.write("alert", alert);
  await db
    .update(runs)
    .set({ ctxDir: ctx.dir, triggerId: trigger.id })
    .where(eq(runs.id, payload.runId));

  const deps = buildPipelineDeps({ runId: payload.runId, repo: payload.repo });

  try {
    await runPipeline(ctx, cfg, DEFAULT_STEPS, deps, {
      onStepEnd: async (name) => recordStepCompleted(payload.runId, name),
      onStepError: async (name, err) => recordStepError(payload.runId, name, err),
    });
    await updateRun(payload.runId, { status: "pr_opened", endedAt: new Date() });
  } catch (err) {
    await updateRun(payload.runId, {
      status: "failed",
      error: String(err),
      endedAt: new Date(),
    });
  } finally {
    const archiveKey = await archiveCtxToS3(ctx);
    if (archiveKey) {
      await db
        .update(runs)
        .set({ ctxArchiveS3: archiveKey })
        .where(eq(runs.id, payload.runId));
    }
    await cleanupCtxDir(ctx);
  }
}
```

### DEFAULT_STEPS composition

New file `apps/server/src/pipeline/default-steps.ts`:

```ts
import type { PipelineStep } from "@alertforge/core";
import { wrapClassifyStep } from "./wrappers/classify";
import { wrapFetchEventStep } from "./wrappers/fetch-event";
import { wrapBudgetStep } from "./wrappers/budget";
import { wrapWorkspaceStep } from "./wrappers/workspace";
import { wrapFixAgentStep } from "./wrappers/fix-agent";
import { wrapSecretScanStep } from "./wrappers/secret-scan";
import { wrapTestGateStep } from "./wrappers/test-gate";
import { wrapCommitPushStep } from "./wrappers/commit-push";
import { wrapOpenPrStep } from "./wrappers/open-pr";
import { wrapReviewPrStep } from "./wrappers/review-pr";
import { wrapFollowUpStep } from "./wrappers/follow-up";
import { wrapFanOutChannelsStep } from "./wrappers/fan-out-channels";

export const DEFAULT_STEPS: PipelineStep[] = [
  wrapClassifyStep(),
  wrapFetchEventStep(),
  wrapBudgetStep(),
  wrapWorkspaceStep(),
  wrapFixAgentStep(),
  wrapSecretScanStep(),
  wrapTestGateStep(),
  wrapCommitPushStep(),       // NEW — split from open-pr
  wrapOpenPrStep(),
  wrapReviewPrStep(),
  wrapFollowUpStep(),
  wrapFanOutChannelsStep(),
];
```

Each `wrap*Step()` returns a `PipelineStep` with `name`, `description`,
optional `skipIf`, and `run(ctx, cfg, deps)`. For LLM-bearing wrappers
(`classify`, `fix-agent`, `review-pr`, `follow-up`) use `wrapLlmStep`
from `@alertforge/core` with explicit `selectInput`/`buildPrompt`/
`parseOutput`/`applyToCtx`.

### ctx field allocation (per step)

| Step | reads from ctx | writes to ctx |
|---|---|---|
| classify | `alert` | `triage` |
| fetch-event | `alert`, `trigger` (for sourceType) | `event_detail` |
| budget | `trigger` | `budget` (also sets `cfg.stopAfter='budget'` when blocked) |
| workspace | `trigger` (repo) | `workspace` |
| fix-agent | `alert`, `event_detail`, `triage`, `workspace`, `trigger` (models, mcps) | `agent_transcript` (stream), `agent_output` |
| secret-scan | `workspace`, `agent_output` | `secret_scan` |
| test-gate | `workspace`, `agent_output`, `trigger` (testCommand override) | `test_result` |
| commit-push | `workspace`, `agent_output` | `diff`, `workspace.pushedSha` (updated) |
| open-pr | `workspace`, `agent_output`, `test_result`, `secret_scan`, `trigger` (reviewers) | `pr` |
| review-pr | `workspace`, `pr`, `agent_output`, `trigger` (model) | `review` |
| follow-up | `pr`, `trigger` (model) | `follow_up` |
| fan-out-channels | `trigger`, `alert`, `pr`, `triage`, `review`, `agent_output` | `notifications` |

### commit-push split from open-pr (D6 from earlier plan)

`@alertforge/step-open-pr` currently bundles `git add → commit → push`
with `gh pr create`. P3c.2 introduces `@alertforge/step-commit-push`
package that extracts the first three operations. `wrapOpenPrStep`
then only handles the `gh pr create` call after `commit-push` has
written `ctx/diff.patch` + updated `ctx/workspace`.

The current `openPr` function stays unchanged (back-compat) — the
wrappers compose its halves. Splitting into two packages happens
only if behaviorally necessary; alternative is keeping commit-push
inline and letting wrapOpenPrStep call openPr as today. Let the
background agent decide based on what's clean.

### deps-factory contract

`apps/server/src/pipeline/deps-factory.ts`:

```ts
export interface BuildDepsInput {
  runId: string;
  repo: string;
}

export function buildPipelineDeps(input: BuildDepsInput): StepDeps & ExtraDeps {
  return {
    modelProvider: new AnthropicModelProvider(env.ANTHROPIC_API_KEY),
    log: pinoLog,
    sources: registry.sources,
    channels: registry.channels,
    // Per-run cross-cutting helpers consumed by wrappers:
    appendLog: (line) => appendRunLog({ runId: input.runId, ...line }),
    resolveToken: resolveGithubToken,
    db: createDb(),
    s3: makeS3Client(),
  };
}
```

The `appendLog` + `resolveToken` + `db` + `s3` extensions live alongside
the core `StepDeps` so wrappers can pull them via `deps.appendLog`
etc. Add the extensions to `StepDeps` interface in
`@alertforge/core/types` (additive — won't break existing tests).

## TDD plan

### Integration test (written first, P3c.1)

`apps/server/src/pipeline/__tests__/run-pipeline.integration.test.ts`:

Fixtures:
- in-memory CtxStore that exposes `recordedWrites` for assertions
- mock `ModelProvider` with response queue per `modelKey`
- mock `resolveToken` returning `"fake-token"`
- mock `Bun.spawn` for git/gh/test commands (asserts argv shape, returns canned stdout/stderr/exit)
- mock `S3Client` (in-memory put)
- in-memory channel registry with a `recording-channel` adapter that captures `PipelineNotification`s

Test cases (red before wrappers exist):
1. **happy path, auto_fix preset** — full pipeline runs classify→fix→tests→PR; asserts `steps_completed=[classify,fetch-event,budget,workspace,fix-agent,secret-scan,test-gate,commit-push,open-pr,fan-out-channels]`; asserts `ctx/triage.json`, `ctx/pr.json`, `ctx/notifications.json` all present
2. **triage_only preset** — pipeline halts after budget; asserts steps_completed stops at `budget` then jumps to `fan-out-channels`; no workspace/agent/test
3. **auto_fix_review preset** — adds `review-pr` step after `open-pr`; `ctx/review.json` populated
4. **budget exhausted** — `budgetStep` writes `budget.allowed=false`; pipeline short-circuits
5. **test-gate fails** — pipeline still opens PR (as draft, per legacy behavior); asserts `ctx/pr.json.isDraft=true`
6. **secret-scan strict mode finds secret** — pipeline aborts before openPr; asserts `ctx/secret_scan.json.blocked=true`
7. **channel send fails on one of two channels** — other channel still fires; `ctx/notifications.json` records both results

### Per-step unit tests

`apps/server/src/pipeline/wrappers/__tests__/<step>.test.ts` for each
of the 12 wrappers. Each tests:
- `selectInput(ctx)` projects only declared fields, ignoring others
- `parseOutput(raw)` handles canned positive + negative responses
- `applyToCtx(ctx, out)` writes the right `CtxField`s
- `skipIf(ctx, cfg)` returns true/false per preset

LLM step wrappers additionally verify `buildPrompt(input)` never
references `CtxStore` — the existing `no-ctx-in-buildprompt` lint rule
enforces this at CI time.

### Behavior parity smoke (manual, not automated)

Before P3c.2 merges, the background agent runs ONE manual smoke:
- Fire the existing webhook fixture against a local `bun run dev`
  with `SFB_RUN_MODE=container`
- Confirm a run completes through the new pipeline
- Compare resulting `runs` row + `prs` row shapes against a snapshot
  captured pre-flip

This is documented in the PR description as a verification step, not
checked into the test suite.

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| 3-attempt self-heal loop subtly broken | wrapFixAgentStep test asserts retry triggers on test-gate fail; integration test #5 covers happy-path retry |
| ctx field name typos at runtime | TS `CtxField` union catches at compile time; lint rule blocks at PR time |
| Budget short-circuit drops `fan-out-channels` | Integration test #2 explicitly asserts triage_only fires fan-out |
| S3 archive failure leaves orphan dirs | `finally` block + existing cron orphan-prune (architecture.md §9) |
| Worker crash mid-run | ctx dir survives; existing 10-min stale-run sweep marks failed (no resume V1; V2) |
| pr-followup-job flip is too entangled | Out of scope per D4; lands in P3c.3 |
| Channel registry empty at boot in agent's test env | Background agent injects mock channel registry in deps; production uses `registry.channels` from `register-adapters` |

## File-level changes

### P3c.1 — add wrappers + integration test

Add:
```
apps/server/src/pipeline/default-steps.ts
apps/server/src/pipeline/deps-factory.ts
apps/server/src/pipeline/wrappers/classify.ts
apps/server/src/pipeline/wrappers/fetch-event.ts
apps/server/src/pipeline/wrappers/budget.ts
apps/server/src/pipeline/wrappers/workspace.ts
apps/server/src/pipeline/wrappers/fix-agent.ts
apps/server/src/pipeline/wrappers/secret-scan.ts
apps/server/src/pipeline/wrappers/test-gate.ts
apps/server/src/pipeline/wrappers/commit-push.ts
apps/server/src/pipeline/wrappers/open-pr.ts
apps/server/src/pipeline/wrappers/review-pr.ts
apps/server/src/pipeline/wrappers/follow-up.ts
apps/server/src/pipeline/wrappers/fan-out-channels.ts
apps/server/src/pipeline/wrappers/__tests__/<step>.test.ts  (12 files)
apps/server/src/pipeline/__tests__/run-pipeline.integration.test.ts
apps/server/src/pipeline/__tests__/fixtures.ts
apps/server/src/pipeline/lint-check.ts                       (CI hook for no-ctx-in-buildprompt)
```

Modify:
```
packages/alertforge-core/src/types.ts                        (extend StepDeps with appendLog, resolveToken, db, s3)
```

**Worker handlers UNCHANGED in P3c.1.** Existing 224 tests stay green
plus ~12 wrapper unit tests + 7 integration tests = ~243 total.

### P3c.2 — flip worker

Modify:
```
apps/server/src/worker/agent-job.ts            replace body with runPipeline driver (~50 LOC down from ~500)
apps/server/src/pipeline/trigger-resolver.ts   resolveTriggerForRun() helper
apps/server/src/pipeline/ctx-archive.ts        archiveCtxToS3() helper
```

Delete:
```
(none; legacy step functions live in their @alertforge/step-* packages and are still invoked through wrappers)
```

After P3c.2 lands, `processAgentJob` orchestration becomes ~50 LOC.
Legacy ~450 LOC of step orchestration is replaced by composition of
`wrap*Step()` factories + `runPipeline`.

## Verification

### After P3c.1
```bash
bun install
bun run check-types        # 16+ packages green
bun test                   # 224 + ~80 new = ~300 total, all green
bun run check              # biome + lint passes
bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts
                           # asserts no wrapper buildPrompt references CtxStore
```

### After P3c.2
```bash
# As above, plus:
bun run dev                # start server + worker
# In a separate terminal:
curl -X POST localhost:3000/webhooks/sentry -d @apps/server/tests/fixtures/sentry-payload.json
# Confirm:
#   - 202 returned
#   - runs row created with ctxDir + triggerId populated
#   - /var/lib/alertforge/runs/<id>/ctx/ populated with files in step order
#   - run completes with status=pr_opened (or failed with diagnostic)
psql -c "SELECT id, trigger_id, status, steps_completed, ctx_dir FROM runs ORDER BY started_at DESC LIMIT 1"
```

### Rollback procedure

If P3c.2 surfaces a regression:
```bash
git revert <P3c.2 commit>                      # restores legacy agent-job body
# P3c.1 wrappers stay; harmless (unused by legacy path)
gh repo deploy
```

If P3c.1 itself needs revert (highly unlikely — additive only):
```bash
git revert <P3c.1 commit>
# Drops all new pipeline/ + wrappers/ + integration-test files
# Behavior 100% restored to current state (P5 landed)
```

## Background-agent execution brief

The Opus 4.7 background agent picks up this plan and executes both
PRs. The agent's task contract:

1. Read this plan + the linked specs (`pipeline-step-contract`,
   `disk-context-store`, `pluggable-pipeline-design`).
2. Read existing `agent-job.ts` to understand legacy orchestration
   that the wrappers must preserve.
3. Implement P3c.1 — wrappers + integration test + unit tests. Stop
   and report when `bun test` is green + check-types clean +
   lint clean. Do NOT touch `agent-job.ts` in this PR.
4. Implement P3c.2 — flip `agent-job.ts` body to runPipeline driver.
   Stop and report when tests green + manual smoke documented in PR
   body.
5. Push both commits. Open PRs (or single branch with two commits
   for review) and report URLs / commit SHAs.

Agent stop conditions (any of):
- All P3c.1 + P3c.2 tests green and pushed.
- Any test failure persists for 3 retry cycles with no progress.
- check-types fails after 3 retry cycles.
- Behavior parity smoke surfaces a regression that the agent cannot
  resolve without changing the spec.

Agent must NOT:
- Modify any spec / plan / ADR in `docs/alertforge/`.
- Drop or rename any existing step package (P3a–P3b.3 are settled).
- Touch `pr-followup-job.ts` (P3c.3 scope).
- Skip the integration test (TDD constraint).

## Out of scope

- `pr-followup-job.ts` flip — P3c.3 (separate session after P3c.2 proves stable in prod)
- Step-level resume on crash — V2
- Behavior-parity automated test (running legacy + new side-by-side) — manual smoke instead
- Real backfill of `runs.trigger_id` for historic runs — only NEW runs get the field

---

## Related specs

- `docs/alertforge/specs/2026-05-21-pipeline-step-contract.md` — step contract
- `docs/alertforge/specs/2026-05-21-disk-context-store.md` — ctx store
- `docs/alertforge/decisions/ADR-0001-disk-vs-memory-ctx-store.md`
- `docs/alertforge/decisions/ADR-0006-step-modules-not-step-per-job.md`
- `docs/alertforge/plans/2026-05-21-phase-3-steps-refactor.md` — sibling P3a/P3b plan (now superseded for P3c by this doc)
