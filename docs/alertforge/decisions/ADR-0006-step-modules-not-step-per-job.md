---
adr: 0006
title: Step modules with shared ctx (Approach A) over step-per-pg-boss-job (Approach B)
status: accepted
date: 2026-05-21
---

## Context

The pluggable pipeline needs an orchestration shape. Three approaches were considered during the 2026-05-21 brainstorming session:

- **Approach A — Step modules + shared pipeline context**: one pg-boss job per trigger event; the worker handler calls named step modules sequentially, each reading/writing a shared `CtxStore`.
- **Approach B — Step-per-pg-boss-job**: every step is its own queue job. Steps read prior state from DB, do work, enqueue successor.
- **Approach C — Declarative pipeline DSL**: pipelines defined as YAML/JSON data, interpreted by a generic engine.

## Decision

**Approach A.** The worker handler imports named step modules and calls them in order against a `CtxStore` instance. One pg-boss job per trigger event (matches today's `agent` job).

Steps are pure-ish: `(ctx, cfg, deps) → Promise<void>`. The framework iterates the step array, calls each, persists progress to `runs.steps_completed`, and short-circuits on a step throwing or being marked `skipIf`.

Crash recovery uses the existing pattern: `runs.status` in non-terminal states older than 10 min get marked failed by `alertforge-cron`. Step-level resume is V2.

## Consequences

**Positive:**
- Smallest delta from today's architecture — `apps/server/src/worker/agent-job.ts` becomes a thin wrapper around `runPipeline(ctxRef, DEFAULT_STEPS)`.
- pg-boss traffic unchanged. No new queue patterns to operate.
- Named-step structure makes the codebase legible: a contributor can read `packages/steps/` and see exactly what the pipeline does, in order.
- Disk-backed `CtxStore` (see ADR-0001) is the natural pairing — ctx survives crashes even without step-level resume.

**Negative:**
- Crash mid-step requires re-running the whole pipeline from scratch (today's behavior; no regression). Step-level resume is a future enhancement.
- Steps must be designed to be idempotent if we want V2 step-level resume — modest design tax we pay anyway for safety.

## Alternatives rejected

- **Approach B (step-per-pg-boss-job)**: rejected. 5–10× queue traffic; complex state machine where today there's a clean sequence; failure paths multiply (each step is now an enqueue boundary, each enqueue can fail). Marginal benefit (step-level resume) doesn't justify the cost; deferred to V2 if monitoring shows resume value.
- **Approach C (declarative DSL)**: rejected. Massive over-engineering for V1. The variation we actually need is captured by presets (ADR-0005). User-defined pipelines as data are a V3+ research question.

## Related

- Specs: `specs/2026-05-21-pipeline-step-contract.md`, `specs/2026-05-21-pluggable-pipeline-design.md`
- See also: ADR-0001 (disk ctx pairing), ADR-0005 (preset-driven shape)
