# Model catalog

Lists model IDs the trigger config UI exposes per LLM step. V1 ships Anthropic-only (see [ADR-0002](../decisions/ADR-0002-anthropic-only-v1.md)). Multi-provider lands V2.

## Anthropic models (V1)

### Recommended per step

| Step | Default model | Why |
|---|---|---|
| `classify` (triage) | `claude-haiku-4-5-20251001` | Tiny prompt, structured output. Haiku is fast + cheap. ~$0.001/alert. |
| `fix` (agent) | `claude-opus-4-7` | Highest-quality code generation. Used inside Claude Code CLI. ~$1.00–$1.50/alert. |
| `review` (auto-PR-review) | `claude-sonnet-4-6` | Sonnet is the right tier for diff review — Opus is overkill, Haiku misses nuance. ~$0.50/run. |
| `followUp` (`/alertforge` mention loop) | `claude-sonnet-4-6` | Same reasoning as review — Sonnet balances cost vs quality for follow-up reasoning. |

### Available model IDs (Anthropic, as of 2026-05-21)

| Model | ID | Tier | Notes |
|---|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5-20251001` | small | Fast, cheap. Use for classify. |
| Sonnet 4.6 | `claude-sonnet-4-6` | medium | Default for review / follow-up. |
| Opus 4.7 | `claude-opus-4-7` | large | Default for fix agent. Use Opus 4.7 (1M context) variant when long-context needed. |
| Opus 4.7 (1M) | `claude-opus-4-7[1m]` | large + extended ctx | 1M token context window; same pricing per-token. Use when fix-agent needs the full repo. |

The UI's model dropdown is generated from this list. To add a new model:

1. Edit this file.
2. Update `packages/alertforge-core/src/models.ts` constants array.
3. Run `bun test` — model-validation tests check both files stay in sync.

## Cost cheat-sheet (per-call, average prompt sizes)

| Step | Input tokens (typical) | Output tokens (typical) | Model | $ per call |
|---|---|---|---|---|
| classify | 2,000 | 200 | Haiku 4.5 | ~$0.001 |
| fix-agent | 5,000 initial + tool calls ~50,000 | ~20,000 | Opus 4.7 | ~$1.00–$1.50 |
| review-pr | 3,000 | 500 | Sonnet 4.6 | ~$0.05 |
| follow-up | 5,000 + tool calls | ~10,000 | Sonnet 4.6 | ~$0.10–$0.30 |

Numbers shift over time; Alertforge usage page shows actual rolled-up costs per trigger.

## Multi-provider (V2 sketch — not implemented in V1)

`ModelProvider` interface lives in `packages/alertforge-core/src/llm-step.ts`. V2 PRs add:

- `OpenAIProvider` — wraps `openai` SDK; supports `gpt-5o`, `o4`, etc. fix-agent step would need an OpenAI agent harness (subprocess or SDK loop with tools).
- `GeminiProvider` — wraps `@google/generative-ai`.
- Local provider — supports vLLM/ollama for self-hosted classify/review where cost matters.

The trigger config schema's `models` field is structured as `{ provider: 'anthropic', model: 'claude-opus-4-7' }` (anthropic implicit in V1 for backward compat); V2 schema extends with `provider` discriminator.

## Cost guards (V1, see ADR-0005)

- Per-trigger daily cost cap (`triggers.config.budget.dailyCostCents`) enforced before each LLM step. If exceeded, switch to `triage_only` mode for the remainder of the day; notify operator via channels.
- UI surfaces cost trajectory vs cap on `/usage` and on each trigger detail page.
- "Cost guard" refuses preset upgrade to `auto_fix_review` if current burn × projected multiplier > cap.
