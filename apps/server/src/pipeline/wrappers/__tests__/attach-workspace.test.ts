/**
 * Unit tests for attach-workspace wrapper. Verifies:
 *   - skipIf true when cfg.stopAfter='budget'.
 *   - skipIf true when prGuardHandle.terminated.
 *   - run() invokes attachWorkspaceFn with branch+repo from ctx.pr.
 *   - Writes ctx.workspace with the right shape.
 *   - Throws when deps.resolveToken missing.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, silentLogger } from "../../__tests__/fixtures";
import {
  runAttachWorkspaceStep,
  skipAttachWorkspaceIfFactory,
  wrapAttachWorkspaceStep,
} from "../attach-workspace";
import type { PrGuardHandle } from "../pr-guard";

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

describe("attach-workspace wrapper", () => {
  it("skipIf returns true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("r1");
    const skip = skipAttachWorkspaceIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("skipIf returns true when prGuardHandle.terminated", async () => {
    const ctx = new MemoryCtxStore("r2");
    const handle: PrGuardHandle = { terminated: true };
    const skip = skipAttachWorkspaceIfFactory(handle);
    expect(await skip(ctx, makeCfg())).toBe(true);
  });

  it("skipIf returns false otherwise", async () => {
    const ctx = new MemoryCtxStore("r3");
    const skip = skipAttachWorkspaceIfFactory({ terminated: false });
    expect(await skip(ctx, makeCfg())).toBe(false);
  });

  it("invokes attachWorkspaceFn with ctx.pr's repo+branch and writes ctx.workspace", async () => {
    const ctx = new MemoryCtxStore("r4");
    await ctx.write("pr", {
      repo: "acme/api",
      number: 7,
      branch: "sfb/run-orig",
      url: "u",
      isDraft: true,
      needsHuman: false,
    });
    let captured: { followupId: string; repo: string; branch: string } | null = null;
    const handle: PrGuardHandle = { terminated: false };
    await runAttachWorkspaceStep(
      ctx,
      makeCfg(),
      makeDeps(),
      {
        followupId: "c-1",
        repo: "fallback/repo",
        branch: "fallback-br",
        prGuardHandle: handle,
        attachWorkspaceFn: async (input) => {
          captured = {
            followupId: input.followupId,
            repo: input.repo,
            branch: input.branch,
          };
          return { dir: "/work/followup-c-1", branch: input.branch, cleanup: async () => {} };
        },
      },
      {},
    );
    expect(captured as object | null).not.toBeNull();
    expect(captured as object | null).toEqual({
      followupId: "c-1",
      repo: "acme/api",
      branch: "sfb/run-orig",
    });
    const ws = await ctx.read<{ dir: string; branch: string; baseBranch: string }>("workspace");
    expect(ws).toEqual({ dir: "/work/followup-c-1", branch: "sfb/run-orig", baseBranch: "" });
  });

  it("falls back to opts.repo/opts.branch when ctx.pr missing", async () => {
    const ctx = new MemoryCtxStore("r5");
    let captured: { repo: string; branch: string } | null = null;
    await runAttachWorkspaceStep(
      ctx,
      makeCfg(),
      makeDeps(),
      {
        followupId: "c-2",
        repo: "fallback/repo",
        branch: "fallback-br",
        prGuardHandle: { terminated: false },
        attachWorkspaceFn: async (input) => {
          captured = { repo: input.repo, branch: input.branch };
          return { dir: "/x", branch: input.branch, cleanup: async () => {} };
        },
      },
      {},
    );
    expect(captured as object | null).toEqual({ repo: "fallback/repo", branch: "fallback-br" });
  });

  it("captures cleanup() into the WorkspaceHandle", async () => {
    const ctx = new MemoryCtxStore("r6");
    await ctx.write("pr", {
      repo: "a/b",
      number: 1,
      branch: "br",
      url: "u",
      isDraft: false,
      needsHuman: false,
    });
    const cleanupFn = async () => {};
    const handle: { cleanup?: () => Promise<void> } = {};
    await runAttachWorkspaceStep(
      ctx,
      makeCfg(),
      makeDeps(),
      {
        followupId: "c-3",
        repo: "a/b",
        branch: "br",
        prGuardHandle: { terminated: false },
        attachWorkspaceFn: async () => ({ dir: "/x", branch: "br", cleanup: cleanupFn }),
      },
      handle,
    );
    expect(handle.cleanup).toBe(cleanupFn);
  });

  it("throws when deps.resolveToken is missing", async () => {
    const ctx = new MemoryCtxStore("r7");
    const deps = makeDeps();
    delete deps.resolveToken;
    await expect(
      runAttachWorkspaceStep(
        ctx,
        makeCfg(),
        deps,
        {
          followupId: "c-4",
          repo: "a/b",
          branch: "br",
          prGuardHandle: { terminated: false },
          attachWorkspaceFn: async () => ({ dir: "/x", branch: "br", cleanup: async () => {} }),
        },
        {},
      ),
    ).rejects.toThrow(/resolveToken/);
  });

  it("wrapAttachWorkspaceStep returns the right PipelineStep", () => {
    const step = wrapAttachWorkspaceStep({
      followupId: "c-5",
      repo: "a/b",
      branch: "br",
      prGuardHandle: { terminated: false },
    });
    expect(step.name).toBe("attach-workspace");
    expect(step.skipIf).toBeDefined();
  });
});
