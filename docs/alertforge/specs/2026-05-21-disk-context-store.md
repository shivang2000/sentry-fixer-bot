---
spec: disk-context-store
title: Disk-backed pipeline context store
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0001-disk-vs-memory-ctx-store
related_specs:
  - pluggable-pipeline-design
  - pipeline-step-contract
plan: 2026-05-21-phase-1-core-abstraction
---

# Disk-backed pipeline context store

## Why

Pipeline state must persist across steps without bloating worker RAM and without making it easy to accidentally send the whole context to an LLM. See [ADR-0001](../decisions/ADR-0001-disk-vs-memory-ctx-store.md) for the decision rationale.

## Layout

Each run gets a directory:

```
/var/lib/alertforge/runs/{run_id}/
  ctx/
    trigger.json          resolved trigger config (preset expanded)
    alert.json            NormalizedAlert from source adapter
    event_detail.json     enriched payload (may be absent)
    triage.json           classifier output {severity, suspectedFiles, summary, confidence}
    budget.json           {allowed: bool, reason?, capRemaining}
    workspace.json        {path, branch, commit}
    agent_transcript.log  streaming stdout/stderr from claude CLI (cap 200 KB, truncate oldest)
    agent_output.json     parsed agent result {summary, risk, confidence, filesChanged}
    secret_scan.json      {findings: [...], blocked: bool}
    test_result.json      {passed: bool, exitCode, duration, stdoutKey: 's3://...'}
    diff.patch            git diff (cap 64 KB)
    pr.json               {url, number, isDraft}
    review.json           reviewer LLM output (if review-pr step ran)
    follow_up.json        latest follow-up agent result (if loop step ran)
    notifications.json    [{channel, sentAt, ok, error?}, ...]
  workspace/              git clone tree
  logs/                   stream-mirror of agent_transcript.log for live UI
```

The DB `runs` row holds only the index (status, step counters, S3 keys, IDs). No `ctx_blob JSONB`.

## `CtxStore` interface

```ts
// packages/alertforge-core/src/ctx-store.ts
export type CtxField =
  | 'trigger' | 'alert' | 'event_detail' | 'triage' | 'budget' | 'workspace'
  | 'agent_transcript' | 'agent_output' | 'secret_scan' | 'test_result'
  | 'diff' | 'pr' | 'review' | 'follow_up' | 'notifications';

export interface CtxStore {
  runId: string;
  dir: string;                                              // /var/lib/alertforge/runs/{id}/ctx
  read<T>(field: CtxField): Promise<T | null>;              // null if not yet written
  write<T>(field: CtxField, value: T, opts?: { capBytes?: number }): Promise<void>;
  append(field: CtxField, chunk: Buffer): Promise<void>;    // for streaming agent_transcript.log
  exists(field: CtxField): Promise<boolean>;
  size(field: CtxField): Promise<number>;
}
```

JSON fields written with `JSON.stringify(value, null, 2)`; log fields written raw. `write` enforces `capBytes` by truncating + writing a sidecar `{field}.truncated.flag` (recorded in `runs.was_truncated`).

## Per-field caps

| Field | Cap | Truncation strategy |
|---|---|---|
| `agent_transcript` (log) | 200 KB | truncate oldest lines (rolling buffer) |
| `agent_output` | 64 KB | truncate string fields; preserve JSON shape |
| `diff.patch` | 64 KB | truncate at last full hunk boundary |
| `event_detail.json` | 128 KB | truncate breadcrumbs first, then stack frames |
| Other JSON | 16 KB | truncate to "{}" + record flag |

Caps come from `packages/alertforge-core/src/ctx-store.ts`; individual steps can request smaller caps via `opts.capBytes`.

## Cleanup

- End of run (success or terminal failure): archive `ctx/` to `s3://.../runs/{run_id}/ctx.tar.zst` (using `tar -I zstd`). Set `runs.ctx_archive_s3 = '<key>'`. Remove local `ctx/` directory.
- `alertforge-cron` hourly: force-prune any `runs/{id}/` directory whose `runs.ended_at` is more than 1 hour old (catches dropped archive jobs).
- `alertforge-cron` daily: prune S3 archives older than 90 days (matches existing log archive retention).

## Restart resilience

- Worker crash leaves `ctx/` intact. Existing 10-minute stale-run sweep marks `runs.status` failed for any in-progress run not heartbeating.
- V2 (out of scope here): operator can re-enqueue with `--resume-from <step>`; each step is idempotent and reads prior fields before redoing work.

## Hygiene invariants — enforced by code + CI

1. Steps `ctx.read(field)` only what they need; never iterate the dir.
2. LLM steps implement `selectInput(ctx)` → `buildPrompt(input)`. `buildPrompt` cannot reference `CtxStore` (AST-grep rule, see [pipeline-step-contract](2026-05-21-pipeline-step-contract.md)).
3. Step output writes pass through `capBytes`; over-cap writes truncate + record the flag.
4. No code path serializes the whole ctx (no `for field of ALL_FIELDS`, no `JSON.stringify(ctxStore)`).

## Tests

- Pure-function: write/read round-trip, append-streams, cap-bytes truncation, exists/size, missing-field returns null.
- Integration: full pipeline run produces all expected files in expected order; archive + cleanup hooks fire correctly.
- Property test: writes never blow the cap (random byte sizes from 1 B to 10 MB).
- CI lint: no-ctx-in-buildprompt AST rule on `packages/steps/**/buildPrompt*`.

## Operational notes

- Workspace dir (clone target) lives next to `ctx/` under the same `runs/{id}/`. systemd `alertforge-worker` runs as user `alertforge-runner` with write access to `/var/lib/alertforge/runs/`.
- EBS volume sizing: 50 GB headroom for `/var/lib/alertforge/runs/` (current observed ~250 KB ctx + ~50 MB workspace per concurrent run; 3 concurrent runs + 24 h retention worst case ~4 GB).
- `df` check via `alertforge-cron`: at >80% usage on `/var/lib/alertforge`, force-prune runs older than 1 h regardless of archive state and alert operator.
