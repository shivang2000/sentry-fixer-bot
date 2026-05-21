---
plan: phase-1-core-abstraction
phase: 1
status: draft
date: 2026-05-21
implements_specs:
  - pluggable-pipeline-design
  - disk-context-store
  - pipeline-step-contract
risk: low
size: medium
---

# P1 — Core abstraction (alertforge-core package)

Introduce the abstraction with **zero runtime behavior change**. New package exists, types are defined, tests pass; nothing yet uses it.

## Scope

- New workspace package `packages/alertforge-core/`.
- Types, registry, pipeline runner, preset resolver, ctx store, LLM step wrapper, lint rule.
- Pure-function TDD tests for everything.
- No changes to existing pipeline code yet (Sentry adapter refit is P2; step refactor is P3).

## File-level changes

### Add

```
packages/alertforge-core/
  package.json                              name: @alertforge/core (NEW workspace member)
  tsconfig.json                             extends root tsconfig
  src/index.ts                              barrel re-export
  src/types.ts                              SourceAdapter, ChannelAdapter, PipelineStep,
                                            LlmStep, NormalizedAlert, EnrichedAlert,
                                            PipelineNotification, CtxField, ResolvedConfig
  src/config.schema.ts                      zod TriggerConfigSchema
  src/registry.ts                           boot-time glob discovery (deferred call; no-op until P2 lands sources)
  src/pipeline.ts                           runPipeline(ctxRef, steps[]) — iterates steps,
                                            calls skipIf, calls run, records steps_completed
  src/preset.ts                             resolvePreset(trigger) → ResolvedConfig
  src/ctx-store.ts                          DiskCtxStore implementing CtxStore
  src/llm-step.ts                           wrapLlmStep + ModelProvider interface +
                                            AnthropicModelProvider stub
  src/lint/no-ctx-in-buildprompt.ts         ast-grep rule for CI
  src/__tests__/ctx-store.test.ts
  src/__tests__/preset.test.ts
  src/__tests__/pipeline.test.ts
  src/__tests__/llm-step.test.ts
  src/__tests__/no-ctx-in-buildprompt.test.ts
```

### Modify

```
package.json                                add workspace pattern if needed
tsconfig.json                               add path mapping for @alertforge/core
```

### Not touched in P1

- `apps/server/src/**` — no changes
- `apps/web/src/**` — no changes
- `packages/db/**` — no changes
- `packages/api/**` — no changes

## Concrete file contents (sketches)

### `packages/alertforge-core/src/types.ts`

Types defined in [pluggable-pipeline-design](../specs/2026-05-21-pluggable-pipeline-design.md), [source-adapter-contract](../specs/2026-05-21-source-adapter-contract.md), [channel-adapter-contract](../specs/2026-05-21-channel-adapter-contract.md), [pipeline-step-contract](../specs/2026-05-21-pipeline-step-contract.md).

### `packages/alertforge-core/src/ctx-store.ts`

DiskCtxStore reads/writes JSON to `${runDir}/ctx/<field>.json` or `.log` for `agent_transcript`. Implements:

```ts
async read<T>(field: CtxField): Promise<T | null> {
  const path = this.pathFor(field);
  if (!(await Bun.file(path).exists())) return null;
  if (field === 'agent_transcript') return await Bun.file(path).text() as unknown as T;
  return JSON.parse(await Bun.file(path).text()) as T;
}

async write<T>(field: CtxField, value: T, opts?: { capBytes?: number }): Promise<void> {
  const text = field === 'agent_transcript'
    ? (value as unknown as string)
    : JSON.stringify(value, null, 2);
  const cap = opts?.capBytes ?? DEFAULT_CAP[field];
  if (text.length > cap) {
    await Bun.write(this.pathFor(field), text.slice(0, cap));
    await Bun.write(`${this.pathFor(field)}.truncated.flag`, '');
  } else {
    await Bun.write(this.pathFor(field), text);
  }
}
```

### `packages/alertforge-core/src/preset.ts`

Implementation per [trigger-config-schema](../specs/2026-05-21-trigger-config-schema.md) §`resolvePreset`.

### `packages/alertforge-core/src/pipeline.ts`

```ts
export async function runPipeline(
  ctx: CtxStore,
  cfg: ResolvedConfig,
  steps: PipelineStep[],
  deps: StepDeps,
  onProgress?: (stepName: string, durationMs: number) => Promise<void>,
): Promise<void> {
  for (const step of steps) {
    if (await step.skipIf?.(ctx, cfg)) continue;
    if (cfg.stopAfter && step.name === cfg.stopAfter) {
      // run this step then continue only with fan-out
      const t0 = Date.now();
      await step.run(ctx, cfg, deps);
      await onProgress?.(step.name, Date.now() - t0);
      // jump to fanOutChannelsStep
      const fanOut = steps.find(s => s.name === 'fan-out-channels');
      if (fanOut) {
        const t1 = Date.now();
        await fanOut.run(ctx, cfg, deps);
        await onProgress?.(fanOut.name, Date.now() - t1);
      }
      return;
    }
    const t0 = Date.now();
    await step.run(ctx, cfg, deps);
    await onProgress?.(step.name, Date.now() - t0);
  }
}
```

### `packages/alertforge-core/src/llm-step.ts`

Implementation per [pipeline-step-contract](../specs/2026-05-21-pipeline-step-contract.md) §LLM step wrapper.

`ModelProvider` interface defined; `AnthropicModelProvider` stub wraps `@anthropic-ai/sdk` `Messages.create` call. Only this provider registered V1 (see ADR-0002).

### `packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts`

Uses `@ast-grep/cli` via Bun script:

```ts
import { $ } from 'bun';

export async function checkNoCtxInBuildprompt(): Promise<{ ok: boolean; violations: string[] }> {
  const result = await $`bunx ast-grep run --pattern 'buildPrompt($_) { $$$ CtxStore $$$ }' packages/steps`.text();
  const violations = result.trim().split('\n').filter(Boolean);
  return { ok: violations.length === 0, violations };
}
```

Hook into existing `bun run check` chain by adding a script in root `package.json`.

## Tests (TDD)

### `ctx-store.test.ts`

- write + read round-trip for each field type
- read missing field returns null
- write past cap creates `.truncated.flag` sidecar
- append to `agent_transcript` accumulates
- exists / size accurate

### `preset.test.ts`

- `triage_only` sets `stopAfter='budget'`, forces toggles off
- `auto_fix` forces toggles off, no `stopAfter`
- `auto_fix_review` forces autoReview on, followUpLoop off
- `custom` honors all input toggles

### `pipeline.test.ts`

- runs all steps in order with mock steps that record their names
- skipIf causes step to be skipped (not recorded)
- stopAfter halts the pipeline and runs only `fan-out-channels`
- thrown error from a step bubbles up; subsequent steps not run

### `llm-step.test.ts`

- wrapLlmStep calls selectInput, then buildPrompt, then modelProvider.complete, then parseOutput, then applyToCtx — in order
- buildPrompt receives the selectInput result, not the ctx
- modelProvider is called with `cfg.models[modelKey]`

### `no-ctx-in-buildprompt.test.ts`

- Fixture file with a clean `buildPrompt(input: TInput)` passes
- Fixture file with `buildPrompt(input: TInput) { ctx.read(...) }` fails

## Verification

```bash
# Inside repo root:
bun install                              # picks up new workspace package
bun run check-types                      # green across all packages
bun --filter=@alertforge/core test       # new tests pass
bun run check                            # includes new lint rule; no violations (nothing uses ctx yet)

# Visual:
ls packages/alertforge-core/src/         # all 7 files present
cat packages/alertforge-core/package.json
```

Existing 120-test suite must remain green (it's not touching anything we changed).

## Commit (per CLAUDE.md commit_protocol)

```
feat(alertforge-core): pipeline runner + disk ctx store + step contract

Introduce the abstraction layer for the Alertforge 2.0 refactor.
New @alertforge/core workspace package exports SourceAdapter,
ChannelAdapter, PipelineStep, LlmStep types; DiskCtxStore for per-run
disk-backed context; runPipeline orchestrator; resolvePreset for
preset → effective config; wrapLlmStep with selectInput/buildPrompt
boundary to keep ctx out of LLM prompts; AST-grep lint rule to enforce
that boundary in CI.

Zero runtime behavior change. No existing code calls into this package
yet — that lands in P2 (Sentry refit) and P3 (steps refactor).

Spec: docs/alertforge/specs/2026-05-21-pluggable-pipeline-design.md
Plan: docs/alertforge/plans/2026-05-21-phase-1-core-abstraction.md

Constraint: ctx must be disk-backed, not in-memory (ADR-0001)
Constraint: buildPrompt must not reach CtxStore (ADR-0006 + lint)
Rejected: in-memory ctx | RAM scaling + accidental ctx leak risk
Rejected: step-per-pg-boss-job | 5-10x queue traffic, deferred to V2
Confidence: high
Scope-risk: narrow
Directive: New LLM-bearing steps MUST implement LlmStep + wrapLlmStep
to satisfy the no-ctx-in-buildprompt lint rule.
Not-tested: archive-to-S3 hook (no S3 step exists yet); covered when P2 lands.
```
