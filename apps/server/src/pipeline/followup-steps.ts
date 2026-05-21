/**
 * Canonical FOLLOWUP_STEPS composition for the pr-followup-job pipeline.
 *
 * Follows the same pattern as `default-steps.ts` (primary path): each
 * step is built by a `wrap*Step` factory that receives run-scoped data
 * + optional test overrides. The factory is exported as a function
 * (not a constant) so the worker can pass per-job inputs (prId,
 * prNumber, branch, repo) without re-declaring the step list each call.
 *
 * Order:
 *   1. pr-guard            check live GitHub state; halt if closed/merged
 *   2. attach-workspace    re-attach worktree to PR's existing branch
 *   3. followup-fix-agent  spawn claude with reviewer instruction + retry
 *   4. secret-scan         scan diff (reused from DEFAULT_STEPS)
 *   5. test-gate           confirm final test outcome (reused)
 *   6. commit-push-only    git add + commit + push to existing branch
 *   7. pr-followup-comment reply on PR + flip draft/ready
 *   8. fan-out-channels    notify channels of followup completion (reused)
 *
 * The watermark advance + humanReviewState transition stay in the
 * worker (idempotency / boundary concerns) — see worker/pr-followup-job.ts.
 */

import type { PipelineStep } from "@alertforge/core";
import type { RunCommandFn } from "./spawn";
import { type AttachWorkspaceFn, wrapAttachWorkspaceStep } from "./wrappers/attach-workspace";
import { type CommitPushOnlyHandle, wrapCommitPushOnlyStep } from "./wrappers/commit-push-only";
import { type ListChannelConfigsFn, wrapFanOutChannelsStep } from "./wrappers/fan-out-channels";
import type {
  EnsureDepsFn,
  ResolveTestCommandFn,
  RunRepoTestsFn,
  SpawnAgentFn,
  TestRecorder,
} from "./wrappers/fix-agent";
import { wrapFollowupFixAgentStep } from "./wrappers/followup-fix-agent";
import {
  type CommentOnPrFn,
  type ConvertPrToDraftFn,
  type MarkPrReadyFn,
  wrapPrFollowupCommentStep,
} from "./wrappers/pr-followup-comment";
import { type GetPrStateFn, type PrGuardHandle, wrapPrGuardStep } from "./wrappers/pr-guard";
import { wrapSecretScanStep } from "./wrappers/secret-scan";
import { wrapTestGateStep } from "./wrappers/test-gate";
import type { WorkspaceHandle } from "./wrappers/workspace";

export interface BuildFollowupStepsInput {
  /** Comment id; used as the worktree's followup id. */
  followupId: string;
  /** Original agent run id (stream tags + log routing). */
  runId: string;
  /** owner/name repo. */
  repo: string;
  /** PR number on GitHub. */
  prNumber: number;
  /** Existing PR branch (sfb/<originalRunId>). */
  prBranch: string;
  /** Side-channel the wrappers share; the worker passes one in so the
   *  `finally` block can read final state if needed. */
  prGuardHandle: PrGuardHandle;
  /** Optional WorkspaceHandle the worker passes so its finally-block
   *  can call workspace.cleanup(). Defaults to an internal handle when
   *  omitted (integration test path). */
  workspaceHandle?: WorkspaceHandle;
  mcpConfigPath?: string;
  maxAgentAttempts?: number;
  testCommandOverride?: string | null;
  // Test overrides ------------------------------------------------
  attachWorkspaceFn?: AttachWorkspaceFn;
  spawnAgentFn?: SpawnAgentFn;
  resolveTestCommandFn?: ResolveTestCommandFn;
  ensureDepsFn?: EnsureDepsFn;
  runRepoTestsFn?: RunRepoTestsFn;
  runScriptedCommand?: RunCommandFn;
  readChangedFile?: (path: string) => Promise<string>;
  listChannelConfigsFn?: ListChannelConfigsFn;
  getPrStateFn?: GetPrStateFn;
  commentOnPrFn?: CommentOnPrFn;
  markPrReadyFn?: MarkPrReadyFn;
  convertPrToDraftFn?: ConvertPrToDraftFn;
}

/**
 * Build the canonical followup pipeline. Returns a mutable
 * PipelineStep[] so the worker (or integration tests) can swap in
 * alternates if needed.
 *
 * Shares `testRecorder` between followup-fix-agent and test-gate
 * (same handoff pattern as the primary path). Workspace cleanup
 * handle is exposed back to the worker via `prGuardHandle` is not the
 * right place — workspace cleanup uses its own handle returned from
 * attach-workspace (the worker manages cleanup in finally).
 */
export function buildFollowupSteps(input: BuildFollowupStepsInput): PipelineStep[] {
  const testRecorder: TestRecorder = {
    command: null,
    passed: null,
    stdoutTail: "",
    stderrTail: "",
    attempts: 0,
  };
  const workspaceHandle: WorkspaceHandle = input.workspaceHandle ?? {};
  const commitPushHandle: CommitPushOnlyHandle = {};

  // Default getPrStateFn — production lazy-loads the real one to keep
  // the alertforge-core import graph free of github/pr-ops at module
  // load time. Tests pass their own.
  const getPrStateFn: GetPrStateFn =
    input.getPrStateFn ??
    (async (i) => {
      const { getPrState } = await import("../github/pr-ops");
      return getPrState(i);
    });
  const commentOnPrFn: CommentOnPrFn =
    input.commentOnPrFn ??
    (async (i) => {
      const { commentOnPr } = await import("../github/pr-ops");
      return commentOnPr(i);
    });
  const markPrReadyFn: MarkPrReadyFn =
    input.markPrReadyFn ??
    (async (i) => {
      const { markPrReady } = await import("../github/pr-ops");
      return markPrReady(i);
    });
  const convertPrToDraftFn: ConvertPrToDraftFn =
    input.convertPrToDraftFn ??
    (async (i) => {
      const { convertPrToDraft } = await import("../github/pr-ops");
      return convertPrToDraft(i);
    });

  const prGuardOpts: Parameters<typeof wrapPrGuardStep>[0] = {
    handle: input.prGuardHandle,
    getPrStateFn,
  };

  const attachOpts: Parameters<typeof wrapAttachWorkspaceStep>[0] = {
    followupId: input.followupId,
    repo: input.repo,
    branch: input.prBranch,
    prGuardHandle: input.prGuardHandle,
  };
  if (input.attachWorkspaceFn) attachOpts.attachWorkspaceFn = input.attachWorkspaceFn;

  const fixAgentOpts: Parameters<typeof wrapFollowupFixAgentStep>[0] = {
    runId: input.runId,
    testRecorder,
    testCommandOverride: input.testCommandOverride ?? null,
    prGuardHandle: input.prGuardHandle,
  };
  if (input.mcpConfigPath !== undefined) fixAgentOpts.mcpConfigPath = input.mcpConfigPath;
  if (input.maxAgentAttempts !== undefined) fixAgentOpts.maxAttempts = input.maxAgentAttempts;
  if (input.spawnAgentFn) fixAgentOpts.spawnAgentFn = input.spawnAgentFn;
  if (input.resolveTestCommandFn) fixAgentOpts.resolveTestCommandFn = input.resolveTestCommandFn;
  if (input.ensureDepsFn) fixAgentOpts.ensureDepsFn = input.ensureDepsFn;
  if (input.runRepoTestsFn) fixAgentOpts.runRepoTestsFn = input.runRepoTestsFn;

  const secretScanOpts: Parameters<typeof wrapSecretScanStep>[0] = {};
  if (input.runScriptedCommand) secretScanOpts.runScriptedCommand = input.runScriptedCommand;
  if (input.readChangedFile) secretScanOpts.readChangedFile = input.readChangedFile;

  const commitPushOpts: Parameters<typeof wrapCommitPushOnlyStep>[0] = {
    prGuardHandle: input.prGuardHandle,
    outcomeHandle: commitPushHandle,
  };
  if (input.runScriptedCommand) commitPushOpts.runScriptedCommand = input.runScriptedCommand;

  const commentOpts: Parameters<typeof wrapPrFollowupCommentStep>[0] = {
    prGuardHandle: input.prGuardHandle,
    outcomeHandle: commitPushHandle,
    commentOnPrFn,
    markPrReadyFn,
    convertPrToDraftFn,
  };
  if (input.maxAgentAttempts !== undefined) commentOpts.maxAttempts = input.maxAgentAttempts;

  const fanOutOpts: Parameters<typeof wrapFanOutChannelsStep>[0] = {
    runId: input.runId,
  };
  if (input.listChannelConfigsFn) fanOutOpts.listChannelConfigsFn = input.listChannelConfigsFn;

  // Compose the steps. Wrap secret-scan, test-gate, and fan-out with a
  // pr-guard-aware skipIf so the entire downstream pipeline halts when
  // the PR is closed/merged. The new-from-scratch followup wrappers
  // (attach-workspace, followup-fix-agent, commit-push-only,
  // pr-followup-comment) already do this internally; this layer keeps
  // us from having to modify the shared primary-path wrappers.
  const guard = input.prGuardHandle;
  const guardWrap = (step: PipelineStep): PipelineStep => {
    const innerSkip = step.skipIf;
    return {
      name: step.name,
      description: step.description,
      skipIf: async (ctx, cfg) => {
        if (guard.terminated) return true;
        if (innerSkip) return innerSkip(ctx, cfg);
        return false;
      },
      run: step.run,
    };
  };

  return [
    wrapPrGuardStep(prGuardOpts),
    wrapAttachWorkspaceStep(attachOpts, workspaceHandle),
    wrapFollowupFixAgentStep(fixAgentOpts),
    guardWrap(wrapSecretScanStep(secretScanOpts)),
    guardWrap(wrapTestGateStep({ testRecorder })),
    wrapCommitPushOnlyStep(commitPushOpts),
    wrapPrFollowupCommentStep(commentOpts),
    guardWrap(wrapFanOutChannelsStep(fanOutOpts)),
  ];
}

/**
 * Re-export the workspace cleanup handle so worker code can call it
 * in its finally block (same pattern as default-steps).
 */
export type { WorkspaceHandle };
