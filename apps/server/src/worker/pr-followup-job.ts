import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts, prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { renderClaudeHome } from "../agent/render-claude-home";
import { spawnClaudeAgent } from "../agent/spawn";
import { attachWorkspace } from "../agent/workspace";
import { resolveGithubToken } from "../github/auth";
import { commentOnPr, markPrReady } from "../github/pr-ops";
import { log } from "../log";
import type { PrFollowupJob } from "../queue/jobs";

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

  // Idempotency guard. The same comment can arrive via webhook AND via
  // the cron fallback within the same minute; only one should run.
  if (pr.lastReviewedCommentAt && new Date(job.commentCreatedAt) <= pr.lastReviewedCommentAt) {
    log.info({ prId: job.prId, commentId: job.commentId }, "[pr-followup] older than watermark");
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

  try {
    const instruction = stripSfbPrefix(job.commentBody);
    const prompt = renderFollowupPrompt({
      alertTitle: alert?.title ?? "(unknown)",
      reviewer: job.commentAuthor,
      instruction,
      testCommand: cfg.testCommand,
    });

    const { mcpConfigPath } = await renderClaudeHome({ repo: pr.repo, runDir: ws.dir });
    const res = await spawnClaudeAgent({ cwd: ws.dir, prompt, mcpConfigPath });
    log.info(
      { exit: res.exitCode, ms: res.durationMs, prId: pr.id },
      "[pr-followup] claude returned",
    );

    if (res.exitCode !== 0) {
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🤖 sentry-fixer-bot: tried to apply \`${instruction.slice(0, 120)}\` but the agent exited ${res.exitCode}. Comment again with a refined \`/sfb\` instruction or push fixes manually.`,
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
      await commentOnPr({
        repo: pr.repo,
        prNumber: pr.number,
        body: `✅ sentry-fixer-bot: applied \`${instruction.slice(0, 160)}\` per @${job.commentAuthor}. New commit pushed; re-review or send another \`/sfb\` instruction.`,
      });
      await advanceWatermark(pr.id, job.commentCreatedAt, "none");
    } else {
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
  testCommand: string;
}): string {
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
- Run \`${input.testCommand}\` and make sure it still passes.
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
