---
spec: self-improvement-loop
title: Self-improvement loop (Hermes-inspired)
status: accepted
date: 2026-05-21
authors: ops
related_specs:
  - pluggable-pipeline-design
plan_phases:
  - 2026-05-21-phase-8-outcome-feedback
---

# Self-improvement loop

Modeled on [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s closed-loop learning patterns, adapted for the alert→fix pipeline domain.

## Why

Today, every PR opened by the bot eventually resolves to one of:
- Merged clean (no human commits before merge)
- Merged with edits (human pushed commits before merge)
- Closed unmerged (human rejected)
- Still open after N days (stale)

This is ground-truth supervised signal. Today we discard it. Hermes-style: collect it, surface it, eventually act on it.

## Phasing

| Capability | V1 (this spec) | V1.5 | V2 |
|---|---|---|---|
| `prs.outcome` tracking | ✓ | | |
| Daily digest channel post | ✓ | | |
| `find_similar_past_alerts` agent tool | | ✓ | |
| `run_summaries` table + FTS index | | ✓ | |
| Auto-skill distillation | design only | | ✓ |
| Reviewer-style modeling | design only | | ✓ |

V1 ships data collection + reporting. V1.5 closes the recall loop (agent uses its own past). V2 closes the writing loop (agent generates skills, models reviewers).

## V1 — outcome tracking + daily digest

### Outcome tracking

`alertforge-cron` poll every PR opened by the bot for 14 days post-open:

```ts
// packages/steps/outcome-poll/  (cron-driven, not pipeline-driven)
for (const pr of openBotPrs) {
  const state = await github.pulls.get({ owner, repo, pull_number: pr.number });
  const humanCommits = await countHumanCommitsBetween(pr.base, pr.merged_commit_sha ?? pr.head);
  if (state.merged) {
    await db.update(prs).set({
      outcome: humanCommits > 0 ? 'merged_with_edits' : 'merged_clean',
      outcomeRecordedAt: new Date(),
      humanCommits,
    }).where(eq(prs.id, pr.id));
  } else if (state.closed_at && !state.merged) {
    await db.update(prs).set({
      outcome: 'closed_unmerged',
      outcomeRecordedAt: new Date(),
      reviewCommentsJsonb: await fetchReviewComments(pr),
    }).where(eq(prs.id, pr.id));
  } else if (Date.now() - pr.openedAt.getTime() > 14 * 24 * 60 * 60 * 1000) {
    await db.update(prs).set({
      outcome: 'stale_open',
      outcomeRecordedAt: new Date(),
    }).where(eq(prs.id, pr.id));
  }
}
```

Review comments captured for closed-unmerged PRs because they contain the human's reasons for rejection (input to V2 reviewer-style modeling).

### Daily digest channel post

`alertforge-cron` once daily per trigger:

```
Alertforge digest — backend-api Sentry, last 7d

  Alerts:           47 (dedup-saved: 1,203)
  Fixes attempted:  47
    merged-clean:   18 (38%)
    merged-with-edits: 12 (26%)
    closed:         11 (23%)
    open:           6 (13%)

  Top recurring fingerprints (not getting fixed):
    1. TypeError: cannot read 'x' of undefined  ×8 (3 closed, 5 stale)
    2. ECONNREFUSED postgres  ×5 (5 closed)

  Cost: $42.16 / $175 weekly cap (24%)

  Suggested action:
    Review fingerprint #1 prompt — closures suggest agent missing
    repo convention. See /triggers/abc/audit?fp=...
```

Posted via the same `fanOutChannels` machinery — any channel adapter that's enabled on this trigger and includes `digest` in `notify_on` receives the digest.

## V1.5 — cross-run recall (designed, behind a flag)

### `run_summaries` table

```sql
CREATE TABLE run_summaries (
  run_id        UUID PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  trigger_id    UUID NOT NULL,
  repo_id       UUID NOT NULL,
  summary_tsv   TSVECTOR NOT NULL,                -- generated from cols below
  alert_title   TEXT NOT NULL,
  stack_top     TEXT NOT NULL,
  agent_summary TEXT,
  outcome       TEXT,
  embedding     VECTOR(1024)                      -- optional pgvector for similarity
);
CREATE INDEX run_summaries_tsv_idx ON run_summaries USING GIN (summary_tsv);
CREATE INDEX run_summaries_trigger_idx ON run_summaries (trigger_id);
-- optional, V1.5+:
CREATE INDEX run_summaries_embedding_idx ON run_summaries USING HNSW (embedding vector_cosine_ops);
```

Populated by a new step `recordRunSummary` running after `openPr` (or after `budget` for triage_only).

### Agent tool

The `fix-agent` step exposes a new tool to the LLM:

```
Tool: find_similar_past_alerts
Description: Look up past runs in this repo that had similar alert titles or
             stack frames. Returns up to 3 (run_id, summary, outcome, diff_link).
Input: { query: string }
```

The agent decides when to call it (when stuck, when alert looks familiar). Result feeds back as a tool message in the conversation. Bounded to 3 results × 4 KB each.

## V2 — auto-skill distillation + reviewer-style modeling

### Auto-skill distillation

After K=3 merged-clean fixes share the same dedup-fingerprint family, `alertforge-cron` runs a distillation LLM step:

```
Input: K (run_summary, diff) pairs sharing fingerprint family F
Prompt: "Distill the common pattern into a reusable skill markdown:
         - When this applies (alert signature)
         - Files to look in
         - Fix template
         Output as a complete Claude Code skill .md."
Output: candidate skill markdown
```

Inserted into `skills_install` table with `state='proposed'`. User approves in `/skills` UI before activation. Approved skill auto-mounted into agent claude-home dir on next matching alert (existing `render-claude-home` machinery).

### Reviewer-style modeling

`reviewer_profiles` table:

```sql
CREATE TABLE reviewer_profiles (
  github_handle TEXT PRIMARY KEY,
  notes         TEXT NOT NULL,                    -- LLM-distilled "@alice prefers X, flags Y, ..."
  source_comments INT NOT NULL,                   -- how many comments fed the distillation
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`alertforge-cron` nightly per active reviewer: pull last 30 review comments, run distillation LLM step, upsert notes. When a reviewer is in the trigger's `pr_reviewers`, the notes get injected into the fix-agent's system prompt:

```
Reviewer notes (auto-distilled from past comments):
  - @alice prefers function components over class components
  - @alice flags missing test cases on async paths
  - @alice does not approve PRs that add new dependencies
```

Cost guard: distillation runs at most once per reviewer per night; uses Sonnet (mid-tier) not Opus.

## Privacy considerations

- Review comments stored in `prs.review_comments_jsonb` are private to the operator's deployment — never sent outside the configured LLM provider.
- Reviewer profiles attribute notes to a GitHub handle, which is already pseudo-public via the PR. Document in `docs/alertforge/PRIVACY.md` when V2 ships.
- Opt-out: a reviewer can request their profile be deleted via an admin-only mutation; we re-run distillation excluding them.

## Out-of-scope (deferred to V3)

- Cross-repo skill sharing (would expose one customer's fixes to another).
- Public skill marketplace.
- Online RL — agent updates its own prompt template based on merge rate.
- Multi-armed bandit over prompt templates.
