import type { LlmStep, ModelProvider, PipelineStep, ResolvedConfig } from "./types";

/**
 * Wrap an LlmStep into a PipelineStep. The wrapper enforces the
 * ctx-projection boundary: `selectInput(ctx)` is the only function in
 * the step that touches the CtxStore; `buildPrompt(input)` sees only
 * the explicitly-projected input. A CI lint rule
 * (lint/no-ctx-in-buildprompt.ts) enforces that `buildPrompt`
 * implementations cannot reach CtxStore.
 */
export function wrapLlmStep<TInput, TOutput>(s: LlmStep<TInput, TOutput>): PipelineStep {
  return {
    name: s.name,
    description: s.description,
    ...(s.skipIf ? { skipIf: s.skipIf } : {}),
    async run(ctx, cfg, deps) {
      const input = await s.selectInput(ctx);
      const prompt = s.buildPrompt(input);
      const modelId = cfg.models[s.modelKey];
      const raw = await deps.modelProvider.complete({ model: modelId, ...prompt });
      const out = s.parseOutput(raw);
      await s.applyToCtx(ctx, out);
    },
  };
}

/**
 * NullModelProvider — useful for tests that don't actually want to hit an LLM.
 * Returns a fixed response. Real providers (e.g. AnthropicModelProvider) live
 * outside this package; @alertforge/core deliberately does not depend on any
 * vendor SDK.
 */
export class NullModelProvider implements ModelProvider {
  readonly name = "null";
  constructor(private readonly fixedResponse: string = "{}") {}
  async complete(_args: { model: string }): Promise<string> {
    return this.fixedResponse;
  }
}

export function modelForStep(
  cfg: ResolvedConfig,
  modelKey: keyof ResolvedConfig["models"],
): string {
  return cfg.models[modelKey];
}
