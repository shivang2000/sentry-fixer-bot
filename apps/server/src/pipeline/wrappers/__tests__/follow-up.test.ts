/**
 * Unit tests for follow-up wrapper. Verifies:
 *   - skipIf true when cfg.toggles.followUpLoop is false (every default preset).
 *   - selectInput projects {prNumber, prUrl, alertTitle}.
 *   - buildPrompt is a no-op (V1 follow-up logic lives in pr-followup-job).
 *   - applyToCtx writes ctx.follow_up with awaitingHuman=true.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import { MemoryCtxStore, makeCfg } from "../../__tests__/fixtures";
import {
  applyFollowUpToCtx,
  buildFollowUpPrompt,
  parseFollowUpOutput,
  selectFollowUpInput,
  wrapFollowUpStep,
} from "../follow-up";

describe("follow-up wrapper", () => {
  it("skipIf true when followUpLoop=false (default)", async () => {
    const step = wrapFollowUpStep();
    expect(step.skipIf).toBeDefined();
    if (!step.skipIf) throw new Error("skipIf missing");
    const ctx = new MemoryCtxStore("run-1");
    expect(await step.skipIf(ctx, makeCfg())).toBe(true);
  });

  it("skipIf false when followUpLoop=true", async () => {
    const step = wrapFollowUpStep();
    if (!step.skipIf) throw new Error("skipIf missing");
    const ctx = new MemoryCtxStore("run-2");
    expect(
      await step.skipIf(
        ctx,
        makeCfg({
          toggles: { autoReview: false, followUpLoop: true, secretScanStrict: "block" },
        }),
      ),
    ).toBe(false);
  });

  it("selectInput projects only the three documented fields", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("alert", { title: "boom" });
    await ctx.write("pr", { number: 42, url: "https://x/42", isDraft: false });
    const input = await selectFollowUpInput(ctx);
    expect(Object.keys(input).sort()).toEqual(["alertTitle", "prNumber", "prUrl"]);
    expect(input.prNumber).toBe(42);
    expect(input.prUrl).toBe("https://x/42");
    expect(input.alertTitle).toBe("boom");
  });

  it("buildPrompt returns an empty messages array (V1 placeholder)", () => {
    const out = buildFollowUpPrompt({ prNumber: 1, prUrl: "x", alertTitle: "a" });
    expect(out.messages).toEqual([]);
  });

  it("parseFollowUpOutput is a deterministic placeholder", () => {
    const out = parseFollowUpOutput("ignored");
    expect(out.enabled).toBe(true);
  });

  it("applyToCtx writes ctx.follow_up", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("pr", { number: 5, url: "https://x/5", isDraft: true });
    await applyFollowUpToCtx(ctx, { enabled: true, prNumber: 0, prUrl: "" });
    const out = (await ctx.read("follow_up")) as { prNumber: number; awaitingHuman: boolean };
    expect(out.prNumber).toBe(5);
    expect(out.awaitingHuman).toBe(true);
  });
});
