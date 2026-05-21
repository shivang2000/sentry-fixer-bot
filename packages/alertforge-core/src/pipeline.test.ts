import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCtxStore } from "./ctx-store";
import { NullModelProvider } from "./llm-step";
import { runPipeline } from "./pipeline";
import type {
  ChannelAdapter,
  Logger,
  PipelineStep,
  ResolvedConfig,
  SourceAdapter,
  StepDeps,
} from "./types";

function makeStep(name: string, opts: { skip?: boolean; throws?: boolean } = {}): PipelineStep {
  return {
    name,
    description: `step ${name}`,
    ...(opts.skip ? { skipIf: async () => true } : {}),
    async run() {
      if (opts.throws) throw new Error(`fail-${name}`);
    },
  };
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

function makeDeps(): StepDeps {
  return {
    modelProvider: new NullModelProvider(),
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels: new Map<string, ChannelAdapter>(),
  };
}

function makeCfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    toggles: { autoReview: false, followUpLoop: false, secretScanStrict: "block" },
    models: {
      classify: "m-classify",
      fix: "m-fix",
      review: "m-review",
      followUp: "m-followUp",
    },
    budget: { dailyTokens: 1_000_000, dailyCostCents: 2500 },
    sourceConfig: {},
    ...overrides,
  };
}

describe("runPipeline", () => {
  let runsRoot: string;
  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "alertforge-pipe-"));
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("runs every non-skipped step in order and records onStepEnd for each", async () => {
    const ctx = await DiskCtxStore.create("run-a", runsRoot);
    const order: string[] = [];
    const steps = ["classify", "fix-agent", "fan-out-channels"].map((n) => ({
      ...makeStep(n),
      async run() {
        order.push(n);
      },
    }));

    const ended: string[] = [];
    await runPipeline(ctx, makeCfg(), steps, makeDeps(), {
      onStepEnd: (name) => {
        ended.push(name);
      },
    });

    expect(order).toEqual(["classify", "fix-agent", "fan-out-channels"]);
    expect(ended).toEqual(["classify", "fix-agent", "fan-out-channels"]);
  });

  it("skipIf=true causes onStepSkip and skips run", async () => {
    const ctx = await DiskCtxStore.create("run-b", runsRoot);
    const order: string[] = [];
    const steps: PipelineStep[] = [
      {
        ...makeStep("classify"),
        async run() {
          order.push("classify");
        },
      },
      {
        ...makeStep("review-pr"),
        skipIf: async () => true,
        async run() {
          order.push("review-pr"); // should never execute
        },
      },
      {
        ...makeStep("fan-out-channels"),
        async run() {
          order.push("fan-out-channels");
        },
      },
    ];

    const skipped: string[] = [];
    await runPipeline(ctx, makeCfg(), steps, makeDeps(), {
      onStepSkip: (name) => {
        skipped.push(name);
      },
    });

    expect(order).toEqual(["classify", "fan-out-channels"]);
    expect(skipped).toEqual(["review-pr"]);
  });

  it("stopAfter='budget' short-circuits to fan-out-channels and skips intermediate steps", async () => {
    const ctx = await DiskCtxStore.create("run-c", runsRoot);
    const order: string[] = [];
    const mk = (n: string): PipelineStep => ({
      ...makeStep(n),
      async run() {
        order.push(n);
      },
    });
    const steps = [
      mk("classify"),
      mk("budget"),
      mk("workspace"), // should be skipped
      mk("fix-agent"), // should be skipped
      mk("open-pr"), // should be skipped
      mk("fan-out-channels"),
    ];
    await runPipeline(ctx, makeCfg({ stopAfter: "budget" }), steps, makeDeps());
    expect(order).toEqual(["classify", "budget", "fan-out-channels"]);
  });

  it("propagates errors from a step and invokes onStepError", async () => {
    const ctx = await DiskCtxStore.create("run-d", runsRoot);
    const steps = [
      makeStep("classify"),
      makeStep("fix-agent", { throws: true }),
      makeStep("fan-out-channels"),
    ];
    const errors: string[] = [];
    await expect(
      runPipeline(ctx, makeCfg(), steps, makeDeps(), {
        onStepError: (name) => {
          errors.push(name);
        },
      }),
    ).rejects.toThrow("fail-fix-agent");
    expect(errors).toEqual(["fix-agent"]);
  });

  it("when stopAfter is set but fan-out-channels is missing, returns silently after the stop step", async () => {
    const ctx = await DiskCtxStore.create("run-e", runsRoot);
    const order: string[] = [];
    const steps = ["classify", "budget", "workspace"].map((n) => ({
      ...makeStep(n),
      async run() {
        order.push(n);
      },
    }));
    await runPipeline(ctx, makeCfg({ stopAfter: "budget" }), steps, makeDeps());
    expect(order).toEqual(["classify", "budget"]);
  });
});
