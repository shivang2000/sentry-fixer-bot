import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts, prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { renderClaudeHome } from "../agent/render-claude-home";
import { spawnClaudeAgent } from "../agent/spawn";
import { bindStreamToRunLogs } from "../agent/stream-parser";
import { attachWorkspace } from "../agent/workspace";
import { resolveTestCommand } from "../gate/detect-test-command";
import { ensureDeps } from "../gate/ensure-deps";
import { runRepoTests } from "../gate/run-tests";
import { resolveGithubToken } from "../github/auth";
import { commentOnPr, getPrState, markPrReady } from "../github/pr-ops";
import { log } from "../log";
import type { PrFollowupJob } from "../queue/jobs";
import { appendRunLog } from "../runs/log";

const MAX_FOLLOWUP_ATTEMPTS = 3;

/**
 * Process a `/sfb <instruction>` comment on a PR the bot opened.
 *
 * High-level flow:
 *   1. Resolve PR row, repo config, original alert title.
 *   2. Set humanReviewState = in_progress (guards against double-firing
 *      if the webhook and cron both deliver the same comment).
 *   3. Re-attach a worktree to the PR's existing branch.
 *   4. Build a follow-up prompt feeding claude: original alert + the
 *      reviewer's /sfb instruction. Spawn claude in the worktree.
 *   5. Commit + push if there are changes; reply on the PR; flip to
 *      ready if reviewer is satisfied.
 *   6. Advance lastReviewedCommentAt + reset humanReviewState.
 */
export async function processPrFollowupJob(job: PrFollowupJob): Promise<void> {
  const db = createDb();

  const pr = (await db.select().from(prs).where(eq(prs.id, job.prId)).limit(1))[0];
  if (!pr) {
    log.warn({ prId: job.prId }, "[pr-followup] pr row missing");
    return;
  }

  // From here on, mirror every meaningful state transition into
  // run_logs (keyed off the ORIGINAL agent run's id) so the operator
  // can watch follow-up activity inline at /runs/<id> alongside the
  // initial agent run. Single timeline per PR — no separate UI needed.
  await appendRunLog({
    runId: pr.runId,
    level: "info",
    source: "pr-followup",
    message: `Picked up /sfb comment from @${job.commentAuthor} on PR #${pr.number}: ${job.commentBody.slice(0, 200)}`,
  });

  // Idempotency guard. The same comment can arrive via webhook AND via
  // the cron fallback within the same minute; only one should run.
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

  // Hard guardrail: if the human reviewer closed (or someone merged)
  // the PR between job dispatch and pickup, no action is appropriate.
  // Pushing more commits to a closed PR is invisible to the reviewer
  // and wastes claude tokens. Advance the watermark so the same
  // comment doesn't re-fire on the next cron tick.
  const state = await getPrState({ repo: pr.repo, prNumber: pr.number });
  if (state === "closed" || state === "merged") {
    log.info(
      { prId: pr.id, prNumber: pr.number, state },
      "[pr-followup] pr is closed/merged — skipping",
    );
    await appendRunLog({
      runId: pr.runId,
      level: "warn",
      source: "pr-followup",
      message: `PR is ${state} — no action taken. Watermark advanced so this comment isn't re-tried.`,
    });
    await advanceWatermark(pr.id, job.commentCreatedAt, "none");
    return;
  }

  const cfg = (
    await db.select().from(reposConfig).where(eq(reposConfig.github, pr.repo)).limit(1)
  )[0];
  if (!cfg) {
    log.warn({ repo: pr.repo }, "[pr-followup] repo config missing");
    return;
  }

  const alert = (
    await db.select({ title: alerts.title }).from(alerts).where(eq(alerts.id, pr.alertId)).limit(1)
  )[0];

  await db.update(prs).set({ humanReviewState: "in_progress" }).where(eq(prs.id, pr.id));
  await appendRunLog({
    runId: pr.runId,
    level: "info",
    source: "pr-followup",
    message: "humanReviewState=in_progress; attaching worktree…",
  });

  const ws = await attachWorkspace({
    followupId: job.commentId,
    repo: pr.repo,
    // The branch was set at createWorkspace time as `sfb/<originalRunId>`
    // and stored on the run row, but we kept the same name on the PR
    // record via openPr's --head input. Re-fetch by querying the runs
    // table indirectly through the runId. Cheaper to read it back here
    // than to denormalize again.
    branch: await branchForPr(pr.runId),
  });
  await appendRunLog({
    runId: pr.runId,
    level: "info",
    source: "pr-followup",
    message: `Worktree re-attached at ${ws.dir} (branch ${ws.branch}).`,
  });

  try {
    const instruction = stripSfbPrefix(job.commentBody);
    const resolvedTest = await resolveTestCommand({
      cwd: ws.dir,
      override: cfg.testCommand ?? null,
    });
    await appendRunLog({
      runId: pr.runId,
      level: "info",
      source: "pr-followup",
      message: resolvedTest
        ? `Test command (${resolvedTest.source}): ${resolvedTest.command}`
        : "No test command detected — gate will be skipped.",
    });

    // Install deps before the gate runs. Followup worktrees are fresh
    // re-attaches off the cached repo and have no node_modules. Same
    // rationale as the primary agent path: one install per worktree,
    // not per attempt; gate failures are real failures.
    if (resolvedTest) {
      const dep = await ensureDeps({ cwd: ws.dir });
      await appendRunLog({
        runId: pr.runId,
        level: dep.ran && dep.exitCode !== 0 ? "warn" : "info",
        source: "pr-followup",
        message: dep.ran
          ? `${dep.command} → exit ${dep.exitCode} in ${(dep.durationMs / 1000).toFixed(1)}s`
          : "No recognised lockfile/manifest; skipping dependency install.",
      });
    }

    const basePrompt = renderFollowupPrompt({
      alertTitle: alert?.title ?? "(unknown)",
      reviewer: job.commentAuthor,
      instruction,
      testCommand: resolvedTest?.command ?? null,
    });

    const { mcpConfigPath } = await renderClaudeHome({ repo: pr.repo, runDir: ws.dir });

    // Same retry loop as the primary agent path. /sfb-driven changes
    // are still gated on the test command — pushing broken tests would
    // be worse than the original blocker the reviewer was trying to
    // fix. Up to MAX_FOLLOWUP_ATTEMPTS attempts; on each retry the
    // failing test output is appended to the prompt so claude can
    // diagnose.
    let agentExit = 0;
    let lastTestStdout = "";
    let lastTestStderr = "";
    let testPassed: boolean | null = null;

    for (let attempt = 1; attempt <= MAX_FOLLOWUP_ATTEMPTS; attempt++) {
      const promptForAttempt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\n---\n\n<previous-attempt>\nYour previous attempt to apply the reviewer's instruction has been\nwritten to the worktree, but \`${resolvedTest?.command}\` is still\nfailing. This is attempt ${attempt}/${MAX_FOLLOWUP_ATTEMPTS}; if you\ncannot make the tests pass, the changes will NOT be pushed.\n\nDiagnose from the output below and apply the smallest fix that turns\nthe suite green. Do not revert your earlier diff unless it was the\ncause.\n\nTEST STDOUT (tail):\n${lastTestStdout.slice(-3000) || "(empty)"}\n\nTEST STDERR (tail):\n${lastTestStderr.slice(-3000) || "(empty)"}\n</previous-attempt>\n`;

      await appendRunLog({
        runId: pr.runId,
        level: "info",
        source: "pr-followup",
        message:
          attempt === 1
            ? `Attempt ${attempt}/${MAX_FOLLOWUP_ATTEMPTS}: spawning claude with reviewer's instruction…`
            : `Attempt ${attempt}/${MAX_FOLLOWUP_ATTEMPTS}: re-spawning claude with failing-test context…`,
      });
      const res = await spawnClaudeAgent({
        cwd: ws.dir,
        prompt: promptForAttempt,
        mcpConfigPath,
        // Stream into the ORIGINAL run's timeline so the operator
        // sees one continuous story per PR — initial fix + every
        // /sfb follow-up — at /runs/<id>.
        onLine: bindStreamToRunLogs(pr.runId, "followup-stream"),
      });
      agentExit = res.exitCode;
      log.info(
        { exit: res.exitCode, ms: res.durationMs, prId: pr.id, attempt },
        "[pr-followup] claude attempt",
      );
      await appendRunLog({
        runId: pr.runId,
        level: res.exitCode === 0 ? "info" : "error",
        source: "pr-followup",
        message: `claude exit ${res.exitCode} in ${(res.durationMs / 1000).toFixed(1)}s (attempt ${attempt})`,
      });

      if (res.exitCode !== 0) break;

      if (!resolvedTest) {
        // No test gate configured for this repo → push whatever
        // claude produced.
        testPassed = null;
        break;
      }

      const testRes = await runRepoTests({ cwd: ws.dir, testCommand: resolvedTest.command });
      testPassed = testRes.passed;
      lastTestStdout = testRes.stdout;
      lastTestStderr = testRes.stderr;
      await appendRunLog({
        runId: pr.runId,
        level: testRes.passed ? "info" : "warn",
        source: "pr-followup",
        message: testRes.passed
          ? `Tests passed on attempt ${attempt}.`
          : attempt < MAX_FOLLOWUP_ATTEMPTS
            ? `Tests failed on attempt ${attempt}. Will retry.`
            : `Tests failed on attempt ${attempt} (final). Not pushing.`,
      });
      if (testRes.passed) break;
    }

    if (agentExit !== 0) {
      await appendRunLog({
        runId: pr.runId,
        level: "error",
        source: "pr-followup",
        message: `Aborting: claude exited ${agentExit}. PR left waiting for human action.`,
      });
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🤖 sentry-fixer-bot: tried to apply \`${instruction.slice(0, 120)}\` but the agent exited ${agentExit}. Comment again with a refined \`/sfb\` instruction or push fixes manually.`,
      });
      await advanceWatermark(pr.id, job.commentCreatedAt, "waiting_human");
      return;
    }

    if (resolvedTest && testPassed === false) {
      await appendRunLog({
        runId: pr.runId,
        level: "error",
        source: "pr-followup",
        message: `Aborting after ${MAX_FOLLOWUP_ATTEMPTS} attempts: tests still failing. PR left waiting for human action.`,
      });
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🛑 sentry-fixer-bot: ran your \`/sfb\` instruction and tried ${MAX_FOLLOWUP_ATTEMPTS} attempts to make \`${resolvedTest.command}\` pass, but tests are still failing. Not pushing. Tail of stderr:\n\n\`\`\`\n${lastTestStderr.slice(-1500)}\n\`\`\``,
      });
      await advanceWatermark(pr.id, job.commentCreatedAt, "waiting_human");
      return;
    }

    const changed = await commitAndPushIfChanged({
      cwd: ws.dir,
      branch: ws.branch,
      reviewer: job.commentAuthor,
      instruction,
    });

    if (changed) {
      // Reviewer is happy enough to give a /sfb instruction → assume
      // their blocker has been addressed. Flip to ready for review so
      // humans get pinged again. If they want it draft, they can flip
      // it themselves.
      if (pr.isDraft) {
        const r = await markPrReady({ repo: pr.repo, prNumber: pr.number });
        if (r === 0) {
          await db.update(prs).set({ isDraft: false }).where(eq(prs.id, pr.id));
        }
      }
      await appendRunLog({
        runId: pr.runId,
        level: "info",
        source: "pr-followup",
        message: `Pushed new commit to ${ws.branch} per @${job.commentAuthor}. PR flipped to ready for re-review.`,
      });
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `✅ sentry-fixer-bot: applied \`${instruction.slice(0, 160)}\` per @${job.commentAuthor}. New commit pushed; re-review or send another \`/sfb\` instruction.`,
      });
      await advanceWatermark(pr.id, job.commentCreatedAt, "none");
    } else {
      await appendRunLog({
        runId: pr.runId,
        level: "warn",
        source: "pr-followup",
        message:
          "Claude produced no diff for this instruction. PR left waiting for a more specific /sfb.",
      });
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🤖 sentry-fixer-bot: ran your \`/sfb\` instruction but the agent didn't produce any diff. Try a more specific instruction (e.g. \`/sfb add a null check in src/foo.ts before line 42\`).`,
      });
      await advanceWatermark(pr.id, job.commentCreatedAt, "waiting_human");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, prId: pr.id }, "[pr-followup] failed");
    await appendRunLog({
      runId: pr.runId,
      level: "error",
      source: "pr-followup",
      message: `Follow-up errored: ${msg}`,
    });
    await commentOnPr({
      repo: pr.repo,
      prNumber: pr.number,
      body: `🛑 sentry-fixer-bot: follow-up errored: \`${msg.slice(0, 200)}\``,
    });
    await advanceWatermark(pr.id, job.commentCreatedAt, "waiting_human");
  } finally {
    await ws.cleanup();
  }
}

async function branchForPr(runId: string): Promise<string> {
  // PR branches are deterministic: createWorkspace names them
  // `sfb/<runId>`. Cheaper to reconstruct than to store on prs.
  return `sfb/${runId}`;
}

function stripSfbPrefix(body: string): string {
  return body
    .trim()
    .replace(/^\/sfb\s*/i, "")
    .trim();
}

function renderFollowupPrompt(input: {
  alertTitle: string;
  reviewer: string;
  instruction: string;
  testCommand: string | null;
}): string {
  // Do NOT ask claude to run the test suite. Its Bash tool has a ~2
  // min per-call timeout while real test suites take 4-10 min, so the
  // call gets SIGKILL'd (Exit 137) and wastes the agent budget. The
  // worker runs `${input.testCommand}` externally after claude exits
  // and uses the result as the push gate.
  const testStep = input.testCommand
    ? `- Do NOT run tests yourself. After you finish, the worker will run \`${input.testCommand}\` and refuse to push if it fails. Just write the change.`
    : "- No automated test command was detected in this repo; verify your change manually against the reviewer's intent.";
  return `/sentry-cli

You are a software engineer responding to a human reviewer's feedback
on a PR you previously opened. Your earlier review was found to have
issues; the reviewer (@${input.reviewer}) has left an instruction via
the \`/sfb\` command. Apply that instruction faithfully.

ORIGINAL ALERT (for context): ${input.alertTitle}

REVIEWER INSTRUCTION:
${input.instruction || "(empty — apply your earlier review's suggestions exactly)"}

Constraints:
- Only change what the reviewer asked for. Do not rewrite unrelated code.
${testStep}
- Add or update tests if the instruction implies new behaviour.
- Do not commit secrets.
- Keep the diff small and focused.

When done, emit a one-line summary on stdout describing the diff so the
follow-up worker can include it in the PR reply.
`;
}

async function commitAndPushIfChanged(input: {
  cwd: string;
  branch: string;
  reviewer: string;
  instruction: string;
}): Promise<boolean> {
  const status = Bun.spawn(["git", "status", "--porcelain"], {
    cwd: input.cwd,
    stdout: "pipe",
  });
  const dirty = (await new Response(status.stdout).text()).trim();
  await status.exited;
  if (!dirty) return false;

  const token = await resolveGithubToken();
  await runStrict(input.cwd, ["git", "add", "-A"]);
  await runStrict(input.cwd, [
    "git",
    "-c",
    "user.email=sentry-fixer-bot@users.noreply.github.com",
    "-c",
    "user.name=sentry-fixer-bot",
    "commit",
    "-m",
    `sfb followup: ${input.instruction.slice(0, 80)}\n\nApplied per @${input.reviewer}.`,
  ]);
  await runStrict(input.cwd, ["git", "push", "origin", input.branch], {
    GITHUB_TOKEN: token,
  });
  return true;
}

async function runStrict(
  cwd: string,
  argv: string[],
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exit !== 0) throw new Error(`${argv[0]} failed (${exit}): ${stderr}`);
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
