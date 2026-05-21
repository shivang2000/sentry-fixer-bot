/**
 * Canonical DEFAULT_STEPS composition for the agent-job pipeline.
 *
 * Each step is built by its `wrap*Step` factory which receives:
 *   - Run-scoped data (runId, repo, baseBranch) from the AgentJob payload.
 *   - Override hooks for tests (createWorkspaceFn, spawnAgentFn,
 *     openPrFn, …). In production these default to the real legacy
 *     step-package functions.
 *
 * The factory function is exported (instead of a constant array) so
 * different worker entry points can pass different scoped inputs (e.g.
 * pr-followup-job.ts in P3c.3 will compose a SUBSET of these steps
 * with different runId / branch semantics).
 *
 * Order matches the spec table in
 * docs/alertforge/plans/2026-05-21-phase-3c-worker-flip.md §"DEFAULT_STEPS
 * composition" — do not re-order without updating the spec.
 */

import type { PipelineStep } from "@alertforge/core";
import type { RunCommandFn } from "./spawn";
import { type CheckBudgetFn, type RecordUsageFn, wrapBudgetStep } from "./wrappers/budget";
import { wrapClassifyStep } from "./wrappers/classify";
import { wrapCommitPushStep } from "./wrappers/commit-push";
import { type ListChannelConfigsFn, wrapFanOutChannelsStep } from "./wrappers/fan-out-channels";
import { wrapFetchEventStep } from "./wrappers/fetch-event";
import {
  type EnsureDepsFn,
  type ResolveTestCommandFn,
  type RunRepoTestsFn,
  type SpawnAgentFn,
  type TestRecorder,
  wrapFixAgentStep,
} from "./wrappers/fix-agent";
import { wrapFollowUpStep } from "./wrappers/follow-up";
import { type OpenPrFn, wrapOpenPrStep } from "./wrappers/open-pr";
import { type RunReviewerFn, wrapReviewPrStep } from "./wrappers/review-pr";
import { wrapSecretScanStep } from "./wrappers/secret-scan";
import { wrapTestGateStep } from "./wrappers/test-gate";
import {
  type CreateWorkspaceFn,
  type WorkspaceHandle,
  wrapWorkspaceStep,
} from "./wrappers/workspace";

/**
 * Inputs the worker hands to the step composer.
 *
 * - `runId`, `repo`, `baseBranch` are per-run scope.
 * - `*Fn` overrides are exclusively for tests. Production code from
 *   apps/server/src/worker/agent-job.ts omits them entirely so the
 *   factories default to the real legacy step-package functions.
 * - `testRecorder` + `workspaceHandle` are mutable side-channels shared
 *   between paired wrappers (fix-agent ↔ test-gate, workspace ↔ the
 *   finally cleanup block).
 */
export interface BuildDefaultStepsInput {
  runId: string;
  repo: string;
  baseBranch: string;
  reviewers?: string[];
  testCommandOverride?: string | null;
  mcpConfigPath?: string;
  maxAgentAttempts?: number;
  // Test overrides ------------------------------------------------
  createWorkspaceFn?: CreateWorkspaceFn;
  spawnAgentFn?: SpawnAgentFn;
  resolveTestCommandFn?: ResolveTestCommandFn;
  ensureDepsFn?: EnsureDepsFn;
  runRepoTestsFn?: RunRepoTestsFn;
  openPrFn?: OpenPrFn;
  runReviewerFn?: RunReviewerFn;
  runScriptedCommand?: RunCommandFn;
  readChangedFile?: (path: string) => Promise<string>;
  listChannelConfigsFn?: ListChannelConfigsFn;
  checkBudgetFn?: CheckBudgetFn;
  recordUsageFn?: RecordUsageFn;
  /** Test hook: capture the PR comment the worker would post (no-op in prod). */
  capturePrComment?: (input: { repo: string; prNumber: number; body: string }) => Promise<void>;
}

/**
 * Build the canonical pipeline. Returns a mutable PipelineStep[] so the
 * worker can swap in alternates for ad-hoc runs (e.g. integration tests).
 *
 * Re-uses `testRecorder` between fix-agent and test-gate as a
 * non-ctx side-channel — see those wrappers for the contract.
 */
export function buildDefaultSteps(input: BuildDefaultStepsInput): PipelineStep[] {
  const testRecorder: TestRecorder = {
    command: null,
    passed: null,
    stdoutTail: "",
    stderrTail: "",
    attempts: 0,
  };
  const workspaceHandle: WorkspaceHandle = {};

  const fixAgentOpts: Parameters<typeof wrapFixAgentStep>[0] = {
    runId: input.runId,
    testRecorder,
    testCommandOverride: input.testCommandOverride ?? null,
  };
  if (input.mcpConfigPath !== undefined) fixAgentOpts.mcpConfigPath = input.mcpConfigPath;
  if (input.maxAgentAttempts !== undefined) fixAgentOpts.maxAttempts = input.maxAgentAttempts;
  if (input.spawnAgentFn) fixAgentOpts.spawnAgentFn = input.spawnAgentFn;
  if (input.resolveTestCommandFn) fixAgentOpts.resolveTestCommandFn = input.resolveTestCommandFn;
  if (input.ensureDepsFn) fixAgentOpts.ensureDepsFn = input.ensureDepsFn;
  if (input.runRepoTestsFn) fixAgentOpts.runRepoTestsFn = input.runRepoTestsFn;

  const workspaceOpts: Parameters<typeof wrapWorkspaceStep>[0] = {
    runId: input.runId,
    repo: input.repo,
    baseBranch: input.baseBranch,
  };
  if (input.createWorkspaceFn) workspaceOpts.createWorkspaceFn = input.createWorkspaceFn;

  const secretScanOpts: Parameters<typeof wrapSecretScanStep>[0] = {};
  if (input.runScriptedCommand) secretScanOpts.runScriptedCommand = input.runScriptedCommand;
  if (input.readChangedFile) secretScanOpts.readChangedFile = input.readChangedFile;

  const commitPushOpts: Parameters<typeof wrapCommitPushStep>[0] = {};
  if (input.runScriptedCommand) commitPushOpts.runScriptedCommand = input.runScriptedCommand;

  const openPrOpts: Parameters<typeof wrapOpenPrStep>[0] = {
    repo: input.repo,
  };
  if (input.reviewers) openPrOpts.reviewers = input.reviewers;
  if (input.openPrFn) openPrOpts.openPrFn = input.openPrFn;

  const reviewPrOpts: Parameters<typeof wrapReviewPrStep>[0] = {
    repo: input.repo,
    runId: input.runId,
  };
  if (input.runReviewerFn) reviewPrOpts.runReviewerFn = input.runReviewerFn;

  const budgetOpts: Parameters<typeof wrapBudgetStep>[0] = {
    repo: input.repo,
  };
  if (input.checkBudgetFn) budgetOpts.checkBudgetFn = input.checkBudgetFn;
  if (input.recordUsageFn) budgetOpts.recordUsageFn = input.recordUsageFn;

  const fanOutOpts: Parameters<typeof wrapFanOutChannelsStep>[0] = {
    runId: input.runId,
  };
  if (input.listChannelConfigsFn) fanOutOpts.listChannelConfigsFn = input.listChannelConfigsFn;

  void input.capturePrComment; // worker uses this post-step (out of pipeline scope)

  return [
    wrapClassifyStep(),
    wrapFetchEventStep(),
    wrapBudgetStep(budgetOpts),
    wrapWorkspaceStep(workspaceOpts, workspaceHandle),
    wrapFixAgentStep(fixAgentOpts),
    wrapSecretScanStep(secretScanOpts),
    wrapTestGateStep({ testRecorder }),
    wrapCommitPushStep(commitPushOpts),
    wrapOpenPrStep(openPrOpts),
    wrapReviewPrStep(reviewPrOpts),
    wrapFollowUpStep(),
    wrapFanOutChannelsStep(fanOutOpts),
  ];
}

/**
 * Re-export the workspace cleanup handle the worker uses in its
 * finally block. `buildDefaultSteps` writes `handle.cleanup` after the
 * workspace step succeeds; the worker calls it in finally to remove
 * the worktree even if a downstream step throws.
 */
export type { TestRecorder, WorkspaceHandle };
