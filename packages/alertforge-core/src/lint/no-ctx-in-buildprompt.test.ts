import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNoCtxInBuildprompt } from "./no-ctx-in-buildprompt";

const CLEAN_STEP = `
import type { LlmStep } from "@alertforge/core";

interface Input { title: string }
interface Output { severity: string }

export const step: LlmStep<Input, Output> = {
  name: "clean",
  description: "ok",
  modelKey: "classify",
  async selectInput(ctx) {
    const alert = await ctx.read("alert");
    return { title: (alert as { title: string }).title };
  },
  buildPrompt(input: Input) {
    return {
      messages: [{ role: "user", content: \`Classify: \${input.title}\` }],
    };
  },
  parseOutput(raw) { return JSON.parse(raw) as Output; },
  async applyToCtx(ctx, out) { await ctx.write("triage", out); },
};
`;

const LEAKY_STEP_CTXSTORE = `
import type { LlmStep, CtxStore } from "@alertforge/core";

interface Input { title: string }
interface Output { severity: string }

export const step: LlmStep<Input, Output> = {
  name: "leaky-via-type",
  description: "bad",
  modelKey: "classify",
  async selectInput(ctx) { return { title: "x" }; },
  buildPrompt(input: Input, ctx: CtxStore) {
    return { messages: [{ role: "user", content: "x" }] };
  },
  parseOutput(raw) { return JSON.parse(raw) as Output; },
  async applyToCtx(ctx, out) { await ctx.write("triage", out); },
};
`;

const LEAKY_STEP_CTXREAD = `
import type { LlmStep } from "@alertforge/core";

interface Input { title: string }
interface Output { severity: string }

export const step: LlmStep<Input, Output> = {
  name: "leaky-via-call",
  description: "bad",
  modelKey: "classify",
  async selectInput(ctx) { return { title: "x" }; },
  buildPrompt(input: Input) {
    // imagine someone smuggled a ctx alias in here through a closure:
    const extra = ctx.read("alert");
    return { messages: [{ role: "user", content: "x" }] };
  },
  parseOutput(raw) { return JSON.parse(raw) as Output; },
  async applyToCtx(ctx, out) { await ctx.write("triage", out); },
};
`;

describe("checkNoCtxInBuildprompt", () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "alertforge-lint-"));
    await mkdir(join(scratch, "packages/steps/example/src"), { recursive: true });
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it("returns no violations for a clean LlmStep", async () => {
    await writeFile(join(scratch, "packages/steps/example/src/step.ts"), CLEAN_STEP);
    const out = await checkNoCtxInBuildprompt([join(scratch, "packages/steps")]);
    expect(out).toEqual([]);
  });

  it("flags a buildPrompt that references CtxStore in its type signature", async () => {
    await writeFile(join(scratch, "packages/steps/example/src/step.ts"), LEAKY_STEP_CTXSTORE);
    const out = await checkNoCtxInBuildprompt([join(scratch, "packages/steps")]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((v) => v.snippet.includes("CtxStore"))).toBe(true);
  });

  it("flags a buildPrompt that calls ctx.read()", async () => {
    await writeFile(join(scratch, "packages/steps/example/src/step.ts"), LEAKY_STEP_CTXREAD);
    const out = await checkNoCtxInBuildprompt([join(scratch, "packages/steps")]);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((v) => v.snippet.includes("ctx.read"))).toBe(true);
  });

  it("returns no violations when packages/steps does not yet exist", async () => {
    const out = await checkNoCtxInBuildprompt([join(scratch, "packages/this-does-not-exist")]);
    expect(out).toEqual([]);
  });

  it("skips files under __tests__/", async () => {
    await mkdir(join(scratch, "packages/steps/example/src/__tests__"), { recursive: true });
    await writeFile(
      join(scratch, "packages/steps/example/src/__tests__/leak.test.ts"),
      LEAKY_STEP_CTXSTORE,
    );
    const out = await checkNoCtxInBuildprompt([join(scratch, "packages/steps")]);
    expect(out).toEqual([]);
  });
});
