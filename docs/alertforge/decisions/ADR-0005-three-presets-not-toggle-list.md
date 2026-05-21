---
adr: 0005
title: Three presets + advanced disclosure, not a raw toggle list
status: accepted
date: 2026-05-21
---

## Context

The pipeline has multiple independently-toggleable behaviors: auto-PR-review on/off, follow-up `/sfb` loop on/off, secret-scan strictness, plus three (now four) LLM-bearing steps each with a model picker. Exposing all of these as raw toggles on the trigger config form is a decision-paralysis UX problem — users either don't read the labels and accept defaults, or feel obligated to understand every knob.

## Decision

The trigger config UI exposes a **single preset dropdown** with three named choices plus a `Custom` mode:

| Preset | autoReview | followUpLoop | Behavior summary |
|---|---|---|---|
| `triage_only` | false | false | Classify + notify only. No PR. Big token savings. |
| `auto_fix` | false | false | Classify + fix + tests + PR. Default. Matches today's behavior. |
| `auto_fix_review` | true | false | Above + LLM reviews own PR before marking ready. |
| `custom` | as-configured | as-configured | Exposes raw toggles in an "Advanced" disclosure. |

The "Advanced" disclosure shows all individual toggles below the preset dropdown. When a non-`custom` preset is selected, Advanced toggles are visible but greyed out, with a "set by preset" indicator. Switching to `custom` makes them editable.

Model pickers (one per LLM step) stay always-visible because they're a routine choice users *should* make per trigger, not a power-user concern.

Channels remain in a separate Channels tab — they're orthogonal to pipeline behavior.

Default preset for new triggers: `auto_fix` (matches today's behavior; backfilled `repos_config` rows get this preset).

## Consequences

**Positive:**
- Default config form for a new trigger is one dropdown + N channel cards. Vast majority of users never see Advanced.
- Power users get full control via `custom` without UX clutter for everyone else.
- Preset names map directly to cost expectations (`triage_only` cheap, `auto_fix_review` most expensive) — pricing intuition matches UI labels.

**Negative:**
- Two ways to express the same configuration (preset-with-locked-toggles vs. `custom`-with-same-toggle-values). Migration tools and audit logs need to handle both.
- Adding new toggles in future requires deciding whether they belong in `Advanced`, get folded into existing presets, or warrant new presets. Process not yet documented.

## Alternatives rejected

- **Raw toggle list, no presets**: rejected. Bad UX for the 80% case; decision-paralysis.
- **Presets only, no custom mode**: rejected. Power users would have to fork the code to get a non-preset combo (e.g., fix without review *but* with follow-up).
- **5 presets including Notify-only and Aggressive**: rejected as too many. The variation between `auto_fix` and `auto_fix_review` already captures the common reviewer choice; further variants belong in `custom`.

## Related

- Specs: `specs/2026-05-21-ui-surface.md`, `specs/2026-05-21-trigger-config-schema.md`
- Code: `packages/alertforge-core/src/preset.ts` (resolves preset → effective config)
