/**
 * Agent-job worker. P3c.2 flip: drives runPipeline against
 * DEFAULT_STEPS instead of orchestrating each step inline.
 *
 * Body is intentionally thin — every pipeline step is composed via a
 * `wrap*Step` factory in `apps/server/src/pipeline/default-steps.ts`,
 * and the resulting `PipelineStep[]` is executed by the framework's
 * `runPipeline` driver. Side effects that aren't part of the pure
 * pipeline (Sentry comments, GitHub PR ops, prs-table writes, run
 * status transitions) live in this file: the worker inspects the
 * final ctx after the pipeline completes and fires whatever extra
 * actions the legacy behavior requires.
 *
 * Stays compatible with the legacy run-status state machine:
 *   - no_repo_match    repos_config row missing
 *   - budget_exhausted budget step writes allowed=false
 *   - agent_error      agent exited non-zero
 *   - test_failed      test gate ran + failed
 *   - no_change        agent produced no diff
 *   - pr_opened        all systems go
 *   - pr_opened_needs_human  reviewer flagged blocker
 *   - error            unhandled exception in the worker
 */

import { rm } from "node:fs/promises";
import { type CtxStore, DiskCtxStore, runPipeline } from "@alertforge/core";
import { createDb } from "@alertforge/db";
import { prs, runs } from "@alertforge/db/schema/domain";
import { env } from "@alertforge/env/server";
import { findAlertById, postIssueComment } from "@alertforge/source-sentry";
import { recordUsage } from "@alertforge/step-budget";
import { eq } from "drizzle-orm";
import { commentOnPr, convertPrToDraft } from "../github/pr-ops";
import { log } from "../log";
import { archiveCtxToS3, cleanupCtxDir } from "../pipeline/ctx-archive";
import { buildDefaultSteps } from "../pipeline/default-steps";
import { buildPipelineDeps } from "../pipeline/deps-factory";
import { resolveTriggerForRun } from "../pipeline/trigger-resolver";
import type { AgentJob } from "../queue/jobs";
import { appendRunLog } from "../runs/log";
import { findRunById, updateRun } from "../runs/persist";

interface PrCtx {
  number: number;
  url: string;
  isDraft: boolean;
  needsHuman: boolean;
}

interface ReviewCtx {
  verdict: "blocker" | "nit" | "approve" | "unknown";
  body: string;
}

interface AgentOutputCtx {
  exitCode: number;
  summary: string;
  confidence: string;
  risk: string;
  severity: string;
  attempts: number;
}

interface TestResultCtx {
  passed: boolean | null;
  command: string | null;
  attempts: number;
}

interface BudgetCtx {
  allowed: boolean;
  reason?: string;
}

interface SecretScanCtx {
  findings: Array<{ file: string; line: number; pattern: string }>;
  blocked: boolean;
}

export async function processAgentJob(payload: AgentJob): Promise<void> {
  const run = await findRunById(payload.runId);
  if (!run) return;
  const alert = await findAlertById(payload.alertId);
  if (!alert) return;

  // Resolve the trigger config. When the repo is unknown, mark the run
  // no_repo_match and bail — same as legacy.
  const resolved = await resolveTriggerForRun({
    repo: payload.repo,
    sourceProject: alert.sentryProject,
  });
  if (!resolved) {
    await updateRun(payload.runId, { status: "no_repo_match", endedAt: new Date() });
    return;
  }
  const {
    trigger,
    defaultBranch,
    testCommandOverride,
    reviewers,
    dailyTokenCap,
    dailyCostCapCents,
  } = resolved;

  // Per-run ctx store. WORK_DIR is the same volume the legacy worker
  // cloned into; ctx/ sits next to workspace/ under {WORK_DIR}/{runId}.
  const ctx = await DiskCtxStore.create(payload.runId, env.WORK_DIR);
  await ctx.write("trigger", trigger);
  await ctx.write("alert", alert);

  // Record ctxDir + triggerId on the runs row so the UI can resolve
  // forensic files and the cron orphan-prune knows which dirs to keep.
  await createDb()
    .update(runs)
    .set({ ctxDir: ctx.dir, triggerId: trigger.id })
    .where(eq(runs.id, payload.runId));

  const stepsCompleted: string[] = [];
  const deps = buildPipelineDeps({ runId: payload.runId });

  const builtSteps = buildDefaultSteps({
    runId: payload.runId,
    repo: payload.repo,
    baseBranch: defaultBranch,
    reviewers,
    testCommandOverride,
  });

  // Run the pipeline. onStepEnd records the canonical step list so the
  // UI can render a per-run timeline; onStepError surfaces failures to
  // the run log without aborting the worker (the wrapper itself decides
  // whether the failure is fatal).
  let pipelineErr: unknown = null;
  try {
    await runPipeline(ctx, trigger.config as never, builtSteps, deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
      onStepError: async (name, err) => {
        await appendRunLog({
          runId: payload.runId,
          level: "error",
          source: "pipeline",
          message: `step ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    });
  } catch (err) {
    pipelineErr = err;
  }

  // Read final ctx state and drive the side-effect waterfall.
  const finalStatus = await applyPostPipelineSideEffects({
    ctx,
    payload,
    alertSentryIssueId: alert.sentryIssueId,
    alertTitle: alert.title,
    repo: payload.repo,
    dailyTokenCap,
    dailyCostCapCents,
    stepsCompleted,
    pipelineErr,
  });
  await updateRun(payload.runId, {
    status: finalStatus,
    stepsCompleted,
    endedAt: new Date(),
  });

  // Archive ctx files to S3 + persist the key. The archive runs even
  // on the failure path so an operator can pull the partial timeline
  // for forensic analysis.
  if (deps.s3) {
    const archiveKey = await archiveCtxToS3({
      ctx,
      s3: deps.s3,
      log: (level, message) =>
        appendRunLog({ runId: payload.runId, level, source: "archive", message }),
    });
    if (archiveKey) {
      await createDb()
        .update(runs)
        .set({ ctxArchiveS3: archiveKey })
        .where(eq(runs.id, payload.runId));
    }
  }
  await cleanupCtxDir(ctx);

  // Best-effort cleanup of any per-run workspace dir that lingered.
  // The wrapWorkspaceStep stashes a cleanup() in a closure-local handle
  // that runs inside the pipeline; but if the pipeline threw before
  // workspace finished, we still want the dir gone.
  await rm(`${env.WORK_DIR}/${payload.runId}`, { recursive: true, force: true }).catch(() => {});
}

/**
 * Inspect the post-pipeline ctx and fire whatever Sentry / GitHub /
 * DB side effects the run requires. Returns the run status to persist.
 *
 * This function is THE source of truth for legacy parity: any post-run
 * action that used to happen inline in the 500-LOC worker now happens
 * here, driven by ctx fields.
 */
async function applyPostPipelineSideEffects(input: {
  ctx: CtxStore;
  payload: AgentJob;
  alertSentryIssueId: string;
  alertTitle: string;
  repo: string;
  dailyTokenCap: number;
  dailyCostCapCents: number;
  stepsCompleted: string[];
  pipelineErr: unknown;
}): Promise<string> {
  // Pipeline itself blew up → record error and stop.
  if (input.pipelineErr) {
    const msg =
      input.pipelineErr instanceof Error ? input.pipelineErr.message : String(input.pipelineErr);
    log.error({ err: msg }, "agent pipeline failed");
    await appendRunLog({
      runId: input.payload.runId,
      level: "error",
      source: "pipeline",
      message: msg,
    });
    await updateRun(input.payload.runId, { error: msg });
    return "error";
  }

  // Budget exhausted: legacy posted a Sentry comment + status=budget_exhausted.
  const budget = await input.ctx.read<BudgetCtx>("budget");
  if (budget && !budget.allowed) {
    await postIssueComment(
      input.alertSentryIssueId,
      `alertforge: budget exhausted (${budget.reason ?? "unknown"}); not attempting a fix today.`,
    );
    return "budget_exhausted";
  }

  const agentOutput = await input.ctx.read<AgentOutputCtx>("agent_output");
  const testResult = await input.ctx.read<TestResultCtx>("test_result");
  const secretScan = await input.ctx.read<SecretScanCtx>("secret_scan");
  const pr = await input.ctx.read<PrCtx>("pr");
  const review = await input.ctx.read<ReviewCtx>("review");

  // Persist the parsed agent fields on the run row so the UI list view
  // can show confidence/risk/severity without re-parsing.
  if (agentOutput) {
    await updateRun(input.payload.runId, {
      agentSummary: agentOutput.summary,
      agentConfidence: agentOutput.confidence,
      agentRisk: agentOutput.risk,
      testPassed: testResult?.passed ?? null,
    });
  }

  // Agent crashed mid-run. Workspace might have a partial diff but
  // it's worse than no PR; legacy returned agent_error here.
  if (agentOutput && agentOutput.exitCode !== 0) {
    await appendRunLog({
      runId: input.payload.runId,
      level: "error",
      source: "agent",
      message: "claude exited non-zero; skipping PR open.",
    });
    return "agent_error";
  }

  // Strict-mode secret scan blocked PR open. PR was not opened.
  if (secretScan?.blocked) {
    await postIssueComment(
      input.alertSentryIssueId,
      `alertforge: agent ran but the diff contains ${secretScan.findings.length} secret-shaped finding(s). No PR opened — see /runs/${input.payload.runId}.`,
    );
    return "error";
  }

  // Tests ran + failed. Legacy posted a comment + returned test_failed.
  // open-pr wrapper would have opened a draft PR in this case; we still
  // want to surface the failure in Sentry.
  if (testResult && testResult.passed === false && !pr) {
    await postIssueComment(
      input.alertSentryIssueId,
      `alertforge: agent produced a fix but \`${testResult.command ?? "tests"}\` failed. No PR opened. See /runs/${input.payload.runId} for the test output.`,
    );
    return "test_failed";
  }

  // No PR opened (no diff, no workspace, or skip-path).
  if (!pr) {
    // If the agent ran but produced no diff, legacy treated it as a
    // triage-only outcome.
    if (agentOutput) {
      await postIssueComment(
        input.alertSentryIssueId,
        `alertforge: agent ran but produced no code change. Triage: ${agentOutput.summary.slice(0, 500)}`,
      );
      return "no_change";
    }
    // Otherwise the run terminated early before fix-agent (rare); status
    // depends on which step short-circuited.
    if (input.stepsCompleted.includes("budget") && !budget?.allowed) return "budget_exhausted";
    return "no_change";
  }

  // PR is open. Handle reviewer feedback + insert the prs row.
  let finalIsDraft = pr.isDraft;
  let humanReviewState: "none" | "waiting_human" = "none";

  if (review) {
    if (review.verdict === "blocker") {
      humanReviewState = "waiting_human";
      if (!pr.isDraft) {
        // Try to flip the live PR back to draft. Best-effort.
        const dExit = await convertPrToDraft({ repo: input.repo, prNumber: pr.number });
        finalIsDraft = dExit === 0;
      }
    }
    // Post the reviewer's body as a PR comment regardless of verdict.
    await commentOnPr({
      repo: input.repo,
      prNumber: pr.number,
      body: renderReviewComment(review.verdict, review.body),
    });
  }

  await createDb()
    .insert(prs)
    .values({
      alertId: input.payload.alertId,
      runId: input.payload.runId,
      repo: input.repo,
      number: pr.number,
      url: pr.url,
      isDraft: finalIsDraft,
      needsHuman: pr.needsHuman || review?.verdict === "blocker",
      humanReviewState,
    });

  await appendRunLog({
    runId: input.payload.runId,
    level: "info",
    source: "agent",
    message: `PR opened: ${pr.url}${finalIsDraft ? " (draft)" : ""}`,
  });
  await postIssueComment(input.alertSentryIssueId, `alertforge: opened PR ${pr.url}`);

  // Record token/cost usage. The wrapper doesn't track usage today so
  // we still call the legacy recordUsage with zeros; budget enforcement
  // is still hard-gated by repos_config caps via the budget wrapper.
  await recordUsage({
    repo: input.repo,
    tokens: 0,
    costCents: 0,
    capTokens: input.dailyTokenCap,
    capCostCents: input.dailyCostCapCents,
  });

  return review?.verdict === "blocker" ? "pr_opened_needs_human" : "pr_opened";
}

function renderReviewComment(verdict: string, body: string): string {
  const badge =
    verdict === "blocker"
      ? "🛑 **Automated review: BLOCKER**"
      : verdict === "nit"
        ? "💬 **Automated review: nits**"
        : verdict === "approve"
          ? "✅ **Automated review: approved**"
          : "ℹ️ **Automated review**";
  const helpFooter = [
    "",
    "---",
    "",
    "_To respond to this review, comment with one of:_",
    "- `/alertforge apply` — apply the suggested fixes and push back to this branch.",
    "- `/alertforge <free-form instruction>` — e.g. `/alertforge only fix the security issue, ignore the style nit`.",
    "_(Legacy `/sfb` prefix still accepted during alertforge-2.0.x.) Comments without the `/alertforge` prefix are treated as human-to-human chatter and ignored by the bot._",
  ].join("\n");
  return `${badge}\n\n${body}${helpFooter}`;
}
