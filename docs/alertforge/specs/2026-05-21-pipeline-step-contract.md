---
spec: pipeline-step-contract
title: Pipeline step contract
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0006-step-modules-not-step-per-job
related_specs:
  - pluggable-pipeline-design
  - disk-context-store
plan_phases:
  - 2026-05-21-phase-1-core-abstraction
  - 2026-05-21-phase-3-steps-refactor
---

# Pipeline step contract

A pipeline step is a TS module that takes a `CtxStore` + resolved config + deps, does its work, and writes named ctx fields. Steps live under `packages/steps/<name>/`.

## Base interface

```ts
// packages/alertforge-core/src/types.ts
export interface PipelineStep {
  name: string;                                   // 'classify' | 'fix-agent' | ...
  description: string;
  skipIf?(ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean>;
  run(ctx: CtxStore, cfg: ResolvedConfig, deps: StepDeps): Promise<void>;
}

export interface StepDeps {
  modelProvider: ModelProvider;
  log: Logger;
  db: DrizzleClient;
  http: HttpClient;
  github: GithubClient;
  s3: S3Client;
}
```

The framework iterates `DEFAULT_STEPS`, calls `step.skipIf?.(ctx, cfg)` first, calls `step.run(...)` if not skipped, records `step.name` in `runs.steps_completed`, and persists per-step duration to `runs`.

## LLM step wrapper

LLM steps additionally implement `LlmStep<TInput, TOutput>` and wrap themselves with `wrapLlmStep` for token/memory hygiene:

```ts
// packages/alertforge-core/src/llm-step.ts
export interface LlmStep<TInput, TOutput> {
  name: string;
  description: string;
  modelKey: ModelStepKey;                         // 'classify' | 'fix' | 'review' | 'followUp'
  skipIf?(ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean>;
  selectInput(ctx: CtxStore): Promise<TInput>;   // hand-picked projection from ctx files
  buildPrompt(input: TInput): PromptMessages;    // works ONLY on TInput — never CtxStore
  parseOutput(raw: string): TOutput;
  applyToCtx(ctx: CtxStore, out: TOutput): Promise<void>;
}

export function wrapLlmStep<TIn, TOut>(s: LlmStep<TIn, TOut>): PipelineStep {
  return {
    name: s.name,
    description: s.description,
    skipIf: s.skipIf,
    run: async (ctx, cfg, deps) => {
      const input = await s.selectInput(ctx);
      const prompt = s.buildPrompt(input);       // input is TIn, ctx is unreachable here
      const modelId = cfg.models[s.modelKey];
      const raw = await deps.modelProvider.complete({ model: modelId, ...prompt });
      const out = s.parseOutput(raw);
      await s.applyToCtx(ctx, out);
    },
  };
}
```

### CI-enforced no-ctx-in-buildprompt rule

`packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts` uses `@ast-grep/cli` to scan `packages/steps/**/*.ts` and fail CI on any reference to `CtxStore` inside a function literal named `buildPrompt`. Catches accidental ctx leaks at PR time.

## Canonical step ordering

```ts
// packages/alertforge-core/src/pipeline.ts
export const DEFAULT_STEPS: PipelineStep[] = [
  classifyStep,         // LLM, modelKey: 'classify'
  fetchEventStep,       // source adapter call
  budgetStep,
  workspaceStep,        // git clone + branch
  fixAgentStep,         // LLM, modelKey: 'fix' (Claude Code CLI under the hood)
  secretScanStep,       // strictness from cfg
  testGateStep,
  commitPushStep,
  openPrStep,
  reviewPrStep,         // LLM, modelKey: 'review', skipIf=!cfg.toggles.autoReview
  followUpStep,         // LLM, modelKey: 'followUp', skipIf=!cfg.toggles.followUpLoop
  fanOutChannelsStep,   // iterates channel_configs
];
```

`triage_only` preset short-circuits to `fanOutChannelsStep` after `budgetStep` via a `cfg.stopAfter` field consulted by the pipeline runner.

## Step skip rules

| Step | skipIf |
|---|---|
| `classifyStep` | never (always classify) |
| `fetchEventStep` | adapter has no `fetchEventDetail` |
| `budgetStep` | never |
| `workspaceStep` | `cfg.stopAfter === 'budget'` (i.e. triage_only) |
| `fixAgentStep` | `cfg.stopAfter === 'budget'` |
| `secretScanStep` | `cfg.stopAfter === 'budget'` |
| `testGateStep` | `cfg.stopAfter === 'budget'` |
| `commitPushStep` | `cfg.stopAfter === 'budget'`, or `agent_output.json.confidence === 'low'` (write SENTRY_TRIAGE-style note instead) |
| `openPrStep` | `cfg.stopAfter === 'budget'` |
| `reviewPrStep` | `!cfg.toggles.autoReview` |
| `followUpStep` | `!cfg.toggles.followUpLoop` |
| `fanOutChannelsStep` | never (always fan out, even on failure paths) |

## Idempotency contract (forward-looking)

V1 reruns the whole pipeline on retry (existing behavior). V2 will support step-level resume via a `--resume-from` flag; for that, each step must be idempotent:

- Re-reading prior ctx fields and detecting "I've already done this" before redoing work.
- `commitPushStep` checks if branch already pushed and skips re-push.
- `openPrStep` checks if PR already opened for this run and skips re-create.
- `fanOutChannelsStep` reads `ctx/notifications.json` and skips channels already marked `ok`.

Writing steps this way in V1 costs nothing (you're already writing the marker file) and unlocks V2.

## Tests

- Per-step unit tests (existing tests relocated):
  - `classifyStep` — parseTriageJson + selectInput projection (existing 5 tests)
  - `fixAgentStep` — parseAgentOutput (existing 4 tests)
  - `secretScanStep` — scanText (existing 5 tests)
  - `testGateStep` — gate output parsing (existing tests)
  - `budgetStep` — decideBudget (existing 4 tests)
- Integration: full DEFAULT_STEPS run with mocked adapters + mocked LLM provider on each preset.
- Lint: AST-grep no-ctx-in-buildprompt rule with a positive fixture (passes) and negative fixture (fails CI).
