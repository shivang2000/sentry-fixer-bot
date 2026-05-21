import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCtxStore } from "./ctx-store";
import { NullModelProvider, wrapLlmStep } from "./llm-step";
import type {
  ChannelAdapter,
  CtxStore,
  LlmStep,
  Logger,
  ResolvedConfig,
  SourceAdapter,
  StepDeps,
} from "./types";

interface TestInput {
  alertTitle: string;
}

interface TestOutput {
  severity: "low" | "medium" | "high";
}

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function makeDeps(modelResponse: string): StepDeps {
  return {
    modelProvider: new NullModelProvider(modelResponse),
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels: new Map<string, ChannelAdapter>(),
  };
}

function makeCfg(overrides?: Partial<ResolvedConfig>): ResolvedConfig {
  return {
    toggles: { autoReview: false, followUpLoop: false, secretScanStrict: "block" },
    models: {
      classify: "claude-haiku-4-5-test",
      fix: "claude-opus-4-7",
      review: "claude-sonnet-4-6",
      followUp: "claude-sonnet-4-6",
    },
    budget: { dailyTokens: 1, dailyCostCents: 1 },
    sourceConfig: {},
    ...overrides,
  };
}

function makeClassifyStep(args: {
  capturedInput?: { value?: TestInput };
  capturedModelId?: { value?: string };
}): LlmStep<TestInput, TestOutput> {
  return {
    name: "classify",
    description: "Test classify",
    modelKey: "classify",
    async selectInput(ctx: CtxStore): Promise<TestInput> {
      const alert = await ctx.read<{ title: string }>("alert");
      return { alertTitle: alert?.title ?? "untitled" };
    },
    buildPrompt(input: TestInput) {
      // CRITICAL: this function takes only TestInput, not CtxStore.
      // The CI lint rule (no-ctx-in-buildprompt) enforces this at PR time.
      if (args.capturedInput) args.capturedInput.value = input;
      return {
        system: "You are a classifier.",
        messages: [{ role: "user", content: `Classify: ${input.alertTitle}` }],
      };
    },
    parseOutput(raw: string): TestOutput {
      return JSON.parse(raw) as TestOutput;
    },
    async applyToCtx(ctx: CtxStore, out: TestOutput): Promise<void> {
      await ctx.write("triage", out);
    },
  };
}

describe("wrapLlmStep", () => {
  let runsRoot: string;
  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "alertforge-llm-"));
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("invokes selectInput → buildPrompt → modelProvider → parseOutput → applyToCtx in order", async () => {
    const ctx = await DiskCtxStore.create("run-1", runsRoot);
    await ctx.write("alert", { title: "TypeError in checkout" });

    const captured: { value?: TestInput } = {};
    const step = makeClassifyStep({ capturedInput: captured });
    const wrapped = wrapLlmStep(step);

    await wrapped.run(ctx, makeCfg(), makeDeps('{"severity":"high"}'));

    expect(captured.value).toEqual({ alertTitle: "TypeError in checkout" });
    const triage = await ctx.read<TestOutput>("triage");
    expect(triage).toEqual({ severity: "high" });
  });

  it("buildPrompt receives the selectInput projection, not the ctx", async () => {
    const ctx = await DiskCtxStore.create("run-2", runsRoot);
    await ctx.write("alert", { title: "boom" });
    await ctx.write("agent_transcript", "this should NOT reach the prompt");

    const captured: { value?: TestInput } = {};
    const wrapped = wrapLlmStep(makeClassifyStep({ capturedInput: captured }));
    await wrapped.run(ctx, makeCfg(), makeDeps('{"severity":"low"}'));

    // Captured input is exactly the projection — no ctx leakage.
    expect(captured.value).toEqual({ alertTitle: "boom" });
    expect(Object.keys(captured.value ?? {})).toEqual(["alertTitle"]);
  });

  it("uses the model ID from cfg.models[modelKey]", async () => {
    const ctx = await DiskCtxStore.create("run-3", runsRoot);
    await ctx.write("alert", { title: "ok" });

    // Custom provider that captures the model id.
    let capturedModel = "";
    const provider = {
      name: "test",
      async complete(args: { model: string }) {
        capturedModel = args.model;
        return '{"severity":"medium"}';
      },
    };
    const deps: StepDeps = {
      modelProvider: provider,
      log: silentLogger,
      sources: new Map(),
      channels: new Map(),
    };

    const wrapped = wrapLlmStep(makeClassifyStep({}));
    await wrapped.run(
      ctx,
      makeCfg({ models: { ...makeCfg().models, classify: "haiku-override-id" } }),
      deps,
    );

    expect(capturedModel).toBe("haiku-override-id");
  });

  it("preserves skipIf from the LlmStep", async () => {
    const step: LlmStep<TestInput, TestOutput> = {
      ...makeClassifyStep({}),
      skipIf: async () => true,
    };
    const wrapped = wrapLlmStep(step);
    expect(wrapped.skipIf).toBeDefined();
  });
});
