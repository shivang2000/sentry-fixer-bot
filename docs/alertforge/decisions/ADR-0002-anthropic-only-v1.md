---
adr: 0002
title: Anthropic-only LLM provider in V1, plugin slot for others
status: accepted
date: 2026-05-21
---

## Context

The pluggable pipeline has four LLM-bearing steps: classify, fix-agent, review-pr, follow-up. Each picks a model per-trigger config. Question: do we ship V1 with a `ModelProvider` abstraction that already supports OpenAI and Gemini, or only Anthropic?

Constraints:
- The `fix-agent` step uses the Claude Code CLI (`claude --print --dangerously-skip-permissions`), which is Anthropic-specific. Swapping to OpenAI / Gemini requires an entirely different agent harness, not just a different SDK call.
- Today's `triage`, `review`, and `follow-up` steps use the Anthropic SDK directly. Those *could* be swapped to other providers without huge rewrites.
- Users have asked for "model choice"; nobody has explicitly asked for non-Anthropic providers yet.

## Decision

V1 ships **Anthropic-only**. A `ModelProvider` interface is defined and used internally so the four LLM steps don't hard-code the SDK call, but the registry only contains an `AnthropicProvider`. Future PRs add `OpenAIProvider`, `GeminiProvider`, etc.

Per-trigger model picker UI only shows Anthropic model IDs (Haiku 4.5 / Sonnet 4.6 / Opus 4.7) in V1. The picker is structured as `{ provider: 'anthropic', model: '...' }` so the schema doesn't need migration when more providers land.

## Consequences

**Positive:**
- V1 ships faster — no agent-harness rewrite, no doubled testing surface.
- The abstraction is real (interface, registry, picker shape), so V2 adds providers without schema migration.
- Provider-specific quirks (cache-control headers, tool-format differences, JSON-mode vs free-text) get figured out one provider at a time.

**Negative:**
- Users who want to use their existing OpenAI API key in V1 cannot.
- Pressure to ship multi-provider may come early; we'll need to be disciplined about saying "V2".

## Alternatives rejected

- **Multi-provider V1**: rejected. Doubles testing surface, requires building an OpenAI/Gemini agent harness from scratch, and there's no concrete request for it. Better to nail the abstraction first.
- **Anthropic-only, no plugin slot**: rejected as it blocks future expansion. The `ModelProvider` interface cost is small and pays off when the first non-Anthropic PR lands.

## Related

- Spec: `specs/2026-05-21-pluggable-pipeline-design.md` (§5 LLM step contract)
- Future PR target: V2.x adds first non-Anthropic provider
