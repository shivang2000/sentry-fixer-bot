/**
 * Unit tests for the classify wrapper. Verifies:
 *   - selectInput projects ONLY {alertTitle, stackTrace}, never ctx fields
 *     unrelated to the prompt.
 *   - buildPrompt receives the projected input (and the lint rule
 *     enforces it can't see CtxStore — see no-ctx-in-buildprompt).
 *   - parseOutput delegates to parseTriageJson (existing tested logic).
 *   - applyToCtx writes ctx.triage with the parsed shape.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import { MemoryCtxStore } from "../../__tests__/fixtures";
import {
  applyClassifyToCtx,
  buildClassifyPrompt,
  selectClassifyInput,
  wrapClassifyStep,
} from "../classify";

describe("classify wrapper", () => {
  it("selectInput projects only alertTitle + stackTrace", async () => {
    const ctx = new MemoryCtxStore("run-1");
    await ctx.write("alert", { title: "Null pointer in cart" });
    await ctx.write("event_detail", { stackTrace: "at cart.ts:5", title: "x" });
    // An unrelated field that must NOT show up in selectInput's output.
    await ctx.write("agent_transcript", "tons of noisy text\n");

    const input = await selectClassifyInput(ctx);
    expect(Object.keys(input).sort()).toEqual(["alertTitle", "stackTrace"]);
    expect(input.alertTitle).toBe("Null pointer in cart");
    expect(input.stackTrace).toBe("at cart.ts:5");
  });

  it("selectInput tolerates missing event_detail (no enrichment yet)", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await ctx.write("alert", { title: "ok" });
    const input = await selectClassifyInput(ctx);
    expect(input.alertTitle).toBe("ok");
    expect(input.stackTrace).toBe("");
  });

  it("buildPrompt produces system + user messages without referencing CtxStore", () => {
    const prompt = buildClassifyPrompt({
      alertTitle: "boom",
      stackTrace: "stack",
    });
    expect(prompt.system).toContain("triage");
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.content).toContain("TITLE:\nboom");
    expect(prompt.messages[0]?.content).toContain("STACK:\nstack");
  });

  it("applyToCtx writes ctx.triage with the parsed TriageResult", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await applyClassifyToCtx(ctx, {
      severity: "high",
      summary: "Null deref",
      suspectedFiles: ["src/cart.ts"],
    });
    const triage = await ctx.read("triage");
    expect(triage).toEqual({
      severity: "high",
      summary: "Null deref",
      suspectedFiles: ["src/cart.ts"],
    });
  });

  it("wrapClassifyStep returns a PipelineStep named 'classify' with no skipIf", () => {
    const step = wrapClassifyStep();
    expect(step.name).toBe("classify");
    expect(step.skipIf).toBeUndefined();
  });
});
