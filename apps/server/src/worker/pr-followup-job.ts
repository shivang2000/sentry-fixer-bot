/**
 * Pr-followup-job worker. P3c.3 flip: drives `runPipeline` against
 * FOLLOWUP_STEPS instead of orchestrating each step inline.
 *
 * Worker boundary concerns kept here (NOT in steps):
 *   - Idempotency watermark check + advance (lastReviewedCommentAt).
 *     The same /sfb comment can arrive via webhook AND cron within
 *     the same minute; watermark advances in the `finally` so even on
 *     failure the comment isn't re-tried.
 *   - humanReviewState UI flip (`in_progress` before pipeline, then
 *     `none` or `waiting_human` after based on outcome).
 *   - The mcpConfigPath render (renderClaudeHome reads installed MCPs
 *     from DB; happens at worker boundary so the wrapper can stay
 *     test-driveable).
 *
 * The actual work (PR-state check, worktree attach, agent spawn, test
 * gate, commit/push, PR comment, channel fan-out) lives in the
 * FOLLOWUP_STEPS pipeline — see apps/server/src/pipeline/followup-steps.ts.
 */

import { type CtxStore, DiskCtxStore, runPipeline } from "@alertforge/core";
import { renderClaudeHome } from "@alertforge/step-fix-agent";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts, prs, runs } from "@sentry-fixer-bot/db/schema/domain";
import { env } from "@sentry-fixer-bot/env/server";
import { eq } from "drizzle-orm";
import { log } from "../log";
import { archiveCtxToS3, cleanupCtxDir } from "../pipeline/ctx-archive";
import { buildPipelineDeps } from "../pipeline/deps-factory";
import { buildFollowupSteps } from "../pipeline/followup-steps";
import { resolveTriggerForRun } from "../pipeline/trigger-resolver";
import type { PrGuardHandle } from "../pipeline/wrappers/pr-guard";
import type { WorkspaceHandle } from "../pipeline/wrappers/workspace";
import type { PrFollowupJob } from "../queue/jobs";
import { appendRunLog } from "../runs/log";

const MAX_FOLLOWUP_ATTEMPTS = 3;

/**
 * Process a `/sfb <instruction>` comment on a PR the bot opened.
 *
 * Worker structure (P3c.3 flip):
 *   1. Load PR row. Bail on missing.
 *   2. Idempotency watermark: skip if comment is older than the
 *      already-processed watermark.
 *   3. Resolve trigger + cfg.
 *   4. Bootstrap ctx (trigger, alert, pr target, instruction).
 *   5. Flip humanReviewState=in_progress so UI reflects activity.
 *   6. Run pipeline (pr-guard → attach → agent → tests → commit/push
 *      → comment → fan-out).
 *   7. In finally: advance watermark, set humanReviewState based on
 *      outcome, archive ctx, cleanup worktree.
 */
export async function processPrFollowupJob(job: PrFollowupJob): Promise<void> {
  const db = createDb();

  const pr = (await db.select().from(prs).where(eq(prs.id, job.prId)).limit(1))[0];
  if (!pr) {
    log.warn({ prId: job.prId }, "[pr-followup] pr row missing");
    return;
  }

  // Idempotency guard — STAYS in the worker (not in a step).
  // Same /sfb comment can arrive via webhook AND cron within the same
  // minute; only one should run. Skip before any expensive ops.
  if (pr.lastReviewedCommentAt && new Date(job.commentCreatedAt) <= pr.lastReviewedCommentAt) {
    log.info({ prId: job.prId, commentId: job.commentId }, "[pr-followup] older than watermark");
    await appendRunLog({
      runId: pr.runId,
      level: "debug",
      source: "pr-followup",
      message: "Comment older than watermark — already processed; skipping.",
    });
    return;
  }

  await appendRunLog({
    runId: pr.runId,
    level: "info",
    source: "pr-followup",
    message: `Picked up /sfb comment from @${job.commentAuthor} on PR #${pr.number}: ${job.commentBody.slice(0, 200)}`,
  });

  // Load alert title (for the followup prompt) + repos_config (for
  // test command override + the trigger lookup fallback). Both
  // optional — the wrappers tolerate missing alert, and the trigger
  // resolver falls back to a synthetic trigger when none exists.
  const alert = (
    await db.select({ title: alerts.title }).from(alerts).where(eq(alerts.id, pr.alertId)).limit(1)
  )[0];
  const cfgRow = (
    await db.select().from(reposConfig).where(eq(reposConfig.github, pr.repo)).limit(1)
  )[0];
  if (!cfgRow) {
    log.warn({ repo: pr.repo }, "[pr-followup] repo config missing");
    return;
  }

  // Resolve trigger / preset config. The original primary-path
  // pipeline takes the trigger from resolveTriggerForRun; we reuse
  // that resolver so the followup pipeline gets the same channel +
  // toggles + budget shape as the original PR.
  const sourceProject = await loadOriginalSourceProject(pr.alertId);
  const resolved = await resolveTriggerForRun({
    repo: pr.repo,
    sourceProject,
  });
  if (!resolved) {
    log.warn({ repo: pr.repo }, "[pr-followup] could not resolve trigger");
    return;
  }
  const { trigger } = resolved;

  // Bootstrap ctx. Worker writes the inputs the followup pipeline
  // needs (trigger, alert, pr target, instruction); the pipeline's
  // first step (pr-guard) consumes them.
  const ctx = await DiskCtxStore.create(`followup-${job.commentId}`, env.WORK_DIR);
  await ctx.write("trigger", trigger);
  if (alert) {
    // The wrappers only need .title from alert for the prompt;
    // synthesize the rest with safe defaults to satisfy the
    // NormalizedAlert shape.
    await ctx.write("alert", {
      sourceType: trigger.sourceType,
      sourceProject: trigger.sourceProject,
      externalId: "",
      fingerprint: "",
      title: alert.title,
      level: "error",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawPayloadS3Key: "",
    });
  }

  const branch = `sfb/${pr.runId}`;
  await ctx.write("pr", {
    repo: pr.repo,
    number: pr.number,
    branch,
    url: pr.url,
    isDraft: pr.isDraft,
    needsHuman: pr.needsHuman,
  });
  await ctx.write("instruction", {
    body: job.commentBody,
    author: job.commentAuthor,
    commentId: job.commentId,
    createdAt: job.commentCreatedAt,
  });

  // Flip humanReviewState BEFORE the pipeline so the UI reflects
  // activity. The finally block flips it back to the outcome-based
  // state (none on success, waiting_human on failure).
  await db.update(prs).set({ humanReviewState: "in_progress" }).where(eq(prs.id, pr.id));
  await appendRunLog({
    runId: pr.runId,
    level: "info",
    source: "pr-followup",
    message: "humanReviewState=in_progress; running followup pipeline…",
  });

  // Pre-render claude home (MCP config + skills symlinks) at the
  // worker boundary. The followup-fix-agent wrapper consumes the
  // resulting mcpConfigPath via opts.
  const workRunDir = `${env.WORK_DIR}/followup-${job.commentId}`;
  let mcpConfigPath: string | undefined;
  try {
    const home = await renderClaudeHome({ repo: pr.repo, runDir: workRunDir });
    mcpConfigPath = home.mcpConfigPath;
  } catch (err) {
    // Failures here mean no MCPs / skills are available to the
    // followup agent; not fatal — the pipeline still proceeds.
    log.warn(
      { prId: pr.id, err: err instanceof Error ? err.message : err },
      "[pr-followup] renderClaudeHome failed; proceeding without MCP config",
    );
  }

  const deps = buildPipelineDeps({ runId: pr.runId });
  const prGuardHandle: PrGuardHandle = { terminated: false };
  const workspaceHandle: WorkspaceHandle = {};

  const stepsInput: Parameters<typeof buildFollowupSteps>[0] = {
    followupId: job.commentId,
    runId: pr.runId,
    repo: pr.repo,
    prNumber: pr.number,
    prBranch: branch,
    prGuardHandle,
    workspaceHandle,
    maxAgentAttempts: MAX_FOLLOWUP_ATTEMPTS,
    testCommandOverride: cfgRow.testCommand ?? null,
  };
  if (mcpConfigPath !== undefined) stepsInput.mcpConfigPath = mcpConfigPath;
  const steps = buildFollowupSteps(stepsInput);

  // Track outcome for the watermark advance — derived from the PR
  // state after the pipeline runs.
  let pipelineErr: unknown = null;
  try {
    await runPipeline(ctx, trigger.config as never, steps, deps, {
      onStepError: async (name, err) => {
        await appendRunLog({
          runId: pr.runId,
          level: "error",
          source: "pr-followup",
          message: `step ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      },
    });
  } catch (err) {
    pipelineErr = err;
    log.error(
      { prId: pr.id, err: err instanceof Error ? err.message : err },
      "[pr-followup] pipeline failed",
    );
  } finally {
    // Decide the outcome state based on what the pipeline produced.
    // Success heuristic: the comment step posted an applied comment
    // when commit-push-only.outcome.pushed=true. We don't have direct
    // access to the handle here (pipeline scoped); inspect ctx
    // instead — diff present + no test failure = success.
    const outcomeState = await deriveOutcomeState(ctx, prGuardHandle);
    await advanceWatermark(pr.id, job.commentCreatedAt, outcomeState);

    if (deps.s3) {
      const archiveKey = await archiveCtxToS3({
        ctx,
        s3: deps.s3,
        log: (level, message) =>
          appendRunLog({ runId: pr.runId, level, source: "archive", message }),
      });
      if (archiveKey) {
        await createDb()
          .update(runs)
          .set({ ctxArchiveS3: archiveKey })
          .where(eq(runs.id, pr.runId));
      }
    }
    await cleanupCtxDir(ctx);

    // Best-effort worktree cleanup. attach-workspace stamped its
    // cleanup() callback into the shared workspaceHandle when the
    // step ran; if the pipeline halted before attach (e.g. pr-guard
    // terminated) the handle is empty and the noop branch fires.
    try {
      await workspaceHandle.cleanup?.();
    } catch (err) {
      log.warn(
        { prId: pr.id, err: err instanceof Error ? err.message : err },
        "[pr-followup] worktree cleanup failed",
      );
    }
    void pipelineErr;
  }
}

/**
 * Inspect post-pipeline ctx to decide whether the followup landed
 * cleanly (humanReviewState='none') or needs human action
 * (humanReviewState='waiting_human').
 *
 * Lives at the worker boundary because (a) the prs row update is a
 * worker concern and (b) the decision is derived from ctx fields the
 * pipeline already wrote — no new step needed.
 */
async function deriveOutcomeState(
  ctx: CtxStore,
  guard: PrGuardHandle,
): Promise<"none" | "waiting_human"> {
  // pr-guard terminated the run (PR closed/merged) — no need to wait
  // for further human action; the watermark just advances.
  if (guard.terminated) return "none";

  // Tests failed or never passed → waiting_human.
  const testResult = await ctx.read<{ passed: boolean | null }>("test_result");
  if (testResult && testResult.passed === false) return "waiting_human";

  // Secret-scan blocked → waiting_human.
  const ss = await ctx.read<{ blocked: boolean }>("secret_scan");
  if (ss?.blocked) return "waiting_human";

  // Agent failed → waiting_human.
  const agent = await ctx.read<{ exitCode: number }>("agent_output");
  if (agent && agent.exitCode !== 0) return "waiting_human";

  // Diff produced + tests didn't fail → ready/none.
  const diff = await ctx.exists("diff");
  if (diff) return "none";

  // No diff but no other failure — claude didn't produce changes for
  // this instruction. Legacy parity: waiting_human (operator must
  // refine the /sfb).
  return "waiting_human";
}

async function advanceWatermark(
  prId: string,
  commentCreatedAt: string,
  state: "none" | "waiting_human",
): Promise<void> {
  const db = createDb();
  await db
    .update(prs)
    .set({
      lastReviewedCommentAt: new Date(commentCreatedAt),
      humanReviewState: state,
    })
    .where(eq(prs.id, prId));
}

/**
 * Look up the sourceProject for the original alert. resolveTriggerForRun
 * is keyed on (repo, sourceProject); we recover it from the alerts row.
 */
async function loadOriginalSourceProject(alertId: string): Promise<string> {
  const db = createDb();
  const row = (
    await db
      .select({ sourceProject: alerts.sentryProject })
      .from(alerts)
      .where(eq(alerts.id, alertId))
      .limit(1)
  )[0];
  return row?.sourceProject ?? "";
}
