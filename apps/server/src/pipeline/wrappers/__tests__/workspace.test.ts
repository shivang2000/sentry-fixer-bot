/**
 * Unit tests for workspace wrapper. Verifies:
 *   - skipIf returns true when cfg.stopAfter='budget'.
 *   - run() invokes createWorkspaceFn, captures cleanup into handle,
 *     writes ctx.workspace { dir, branch, baseBranch }.
 *   - throws when deps.resolveToken is missing.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, silentLogger } from "../../__tests__/fixtures";
import { runWorkspaceStep, skipWorkspaceIf, wrapWorkspaceStep } from "../workspace";

function makeDeps(overrides: Partial<StepDeps> = {}): StepDeps {
  return {
    modelProvider: {
      name: "noop",
      async complete() {
        return "{}";
      },
    },
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels: new Map<string, ChannelAdapter>(),
    resolveToken: async () => "tok",
    ...overrides,
  };
}

describe("workspace wrapper", () => {
  it("skipIf returns true when cfg.stopAfter='budget' (triage_only)", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipWorkspaceIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
    expect(await skipWorkspaceIf(ctx, makeCfg())).toBe(false);
  });

  it("invokes createWorkspaceFn and writes ctx.workspace", async () => {
    const ctx = new MemoryCtxStore("run-2");
    let captured: { runId: string; repo: string; baseBranch: string } | null = null;
    const handle: { cleanup?: () => Promise<void> } = {};
    const cleanupSpy = async () => {};
    await runWorkspaceStep(
      ctx,
      makeCfg(),
      makeDeps(),
      {
        runId: "run-2",
        repo: "acme/api",
        baseBranch: "main",
        createWorkspaceFn: async (input) => {
          captured = { runId: input.runId, repo: input.repo, baseBranch: input.baseBranch };
          return { dir: "/work/run-2", branch: "sfb/run-2", cleanup: cleanupSpy };
        },
      },
      handle,
    );
    expect(captured as object | null).not.toBeNull();
    expect(captured as object | null).toEqual({
      runId: "run-2",
      repo: "acme/api",
      baseBranch: "main",
    });
    const ws = await ctx.read<{ dir: string; branch: string; baseBranch: string }>("workspace");
    expect(ws).toEqual({ dir: "/work/run-2", branch: "sfb/run-2", baseBranch: "main" });
    expect(handle.cleanup).toBe(cleanupSpy);
  });

  it("throws when deps.resolveToken is missing", async () => {
    const ctx = new MemoryCtxStore("run-3");
    const deps = makeDeps();
    delete deps.resolveToken;
    await expect(
      runWorkspaceStep(
        ctx,
        makeCfg(),
        deps,
        {
          runId: "run-3",
          repo: "acme/api",
          baseBranch: "main",
          createWorkspaceFn: async () => ({ dir: "/x", branch: "y", cleanup: async () => {} }),
        },
        {},
      ),
    ).rejects.toThrow(/resolveToken/);
  });

  it("wrapWorkspaceStep returns the correct PipelineStep", () => {
    const step = wrapWorkspaceStep({ runId: "run-x", repo: "a/b", baseBranch: "main" });
    expect(step.name).toBe("workspace");
    expect(step.skipIf).toBeDefined();
  });
});
