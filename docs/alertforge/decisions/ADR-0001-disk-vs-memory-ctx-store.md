---
adr: 0001
title: Disk-backed pipeline context store
status: accepted
date: 2026-05-21
---

## Context

The pluggable pipeline (`packages/alertforge-core/`) needs a place to keep per-run state across step boundaries: the parsed alert, classifier output, agent transcript, diff, PR metadata, channel send results. Options were considered:

| Option | Memory footprint | Restart-resilient | Observability | LLM-prompt risk |
|---|---|---|---|---|
| In-process JS object | High (~250 KB/run × concurrency) | No | Hard (no on-disk artifact) | High (easy to `JSON.stringify(ctx)`) |
| `runs` row JSONB column | Low RAM | Yes | Medium (one row to read) | High (same hazard) |
| Per-run disk directory | Very low RAM (~10–50 KB) | Yes (dir survives restart) | High (`ls runs/{id}/` shows progress) | Lower (steps load fields explicitly) |

The disk-directory option also lets us cap individual field sizes via the write-time `capBytes` argument, and write `agent_transcript.log` as an append-only stream rather than a buffered string.

## Decision

Pipeline context is **a per-run directory on disk** at `/var/lib/alertforge/runs/{run_id}/ctx/`, one file per named `CtxField`. Steps interact via a `CtxStore` interface (`read`, `write`, `append`, `exists`, `size`). The Bun worker process never holds the whole context in memory; each step loads only the fields it needs.

After a run completes (or fails terminally), the `ctx/` directory is archived to `s3://.../runs/{run_id}/ctx.tar.zst` and removed locally. Orphaned directories older than 1 hour are force-pruned by `alertforge-cron`.

## Consequences

**Positive:**
- Worker process RAM stays ~10–50 KB per active run; Alertforge runs comfortably on a t3.small.
- Crash mid-run leaves the directory intact; existing 10-minute stale-run sweep continues to work; future V2 can implement step-level resume by reading prior files.
- Operators debugging a failed run can `cat` individual files (`triage.json`, `diff.patch`) without spelunking through a JSONB blob.
- LLM steps see only what `selectInput(ctx)` projects — the disk layout makes "what the LLM saw" auditable.

**Negative:**
- Disk I/O on every step (small, on local EBS — measured negligible vs. LLM call time).
- Two cleanup paths to maintain (in-progress dir + post-archive removal).
- Backups now include the per-run disk dirs if the cron archiver lags; mitigated by short retention and S3 archive.

## Alternatives rejected

- **In-memory JS object**: poor restart resilience; high RAM at concurrency; makes accidental `JSON.stringify(ctx)` into an LLM prompt trivially easy. Rejected for both performance and safety reasons.
- **Postgres JSONB column**: would couple every step to a DB write/read; harder to cap individual fields; turns transcripts into giant JSONB blobs that bloat backups and slow queries.

## Related

- Specs: `specs/2026-05-21-disk-context-store.md`, `specs/2026-05-21-pipeline-step-contract.md`
- Plan: `plans/2026-05-21-phase-1-core-abstraction.md`
- See also: ADR-0006 (Approach A over Approach B — pipeline orchestration shape)
