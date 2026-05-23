import { verifyHmacSha256 } from "@alertforge/core";
import { createDb } from "@alertforge/db";
import { repos } from "@alertforge/db/schema/admin";
import { prs } from "@alertforge/db/schema/domain";
import { env } from "@alertforge/env/server";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getPrState } from "../github/pr-ops";
import { log } from "../log";
import { publishJob } from "../queue/boss";
import { JOB_PR_FOLLOWUP } from "../queue/jobs";

export const githubWebhook = new Hono();

/**
 * Magic prefix the bot listens for. Anything else from human reviewers
 * is treated as ordinary conversation and ignored — same pattern as
 * Dependabot/Renovate (`@dependabot rebase`).
 *
 * The legacy `/sfb` alias was dropped in alertforge-2.1.0 (P9); only
 * `/alertforge` matches now.
 */
export const ALERTFORGE_COMMAND_PREFIX = "/alertforge";
const COMMAND_PREFIX_RE = /^\/alertforge\b/i;

export function isAlertforgeCommand(body: string): boolean {
  return COMMAND_PREFIX_RE.test(body.trim());
}

type IssueCommentEvent = {
  action: "created" | "edited" | "deleted";
  issue: {
    number: number;
    pull_request?: { url: string }; // present iff comment is on a PR
  };
  comment: {
    id: number;
    body: string;
    user: { login: string };
    created_at: string;
  };
  repository: {
    full_name: string; // "owner/name"
  };
  sender: { login: string };
};

/**
 * GitHub App webhook. Subscribe the App to `issue_comment` events on
 * the installed repos; GitHub also fires this event for comments on
 * PRs (PRs are issues in GitHub's data model) which is what we want.
 *
 * Flow:
 *   1. Verify X-Hub-Signature-256 against GITHUB_WEBHOOK_SECRET.
 *   2. Filter to `action === "created"` on a PR comment.
 *   3. Require `/alertforge` prefix on body.
 *   4. Require sender to be in `repos.prReviewers` for the repo.
 *   5. Look up the prs row by (repo, number); require it to exist
 *      (i.e. PR was opened by alertforge) and be in `waiting_human` state.
 *   6. Enqueue a JOB_PR_FOLLOWUP with the comment payload.
 *
 * Every rejection path returns 202 (not 4xx) so GitHub doesn't retry
 * a payload we already saw and chose to drop. Real errors (invalid
 * signature, missing secret) keep their 4xx/5xx codes so the App
 * dashboard surfaces them.
 */
githubWebhook.post("/webhooks/github", async (c) => {
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return c.json({ error: "webhook_secret_not_configured" }, 503);
  }
  const eventType = c.req.header("x-github-event");
  // Ping is what GitHub sends on App install to validate the URL.
  if (eventType === "ping") return c.json({ ok: true });
  if (eventType !== "issue_comment") {
    return c.json({ ignored: "event_type", eventType }, 202);
  }

  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256") ?? null;
  if (!verifyHmacSha256({ secret: env.GITHUB_WEBHOOK_SECRET, body: raw, headerValue: sig })) {
    return c.json({ error: "invalid_signature" }, 401);
  }

  let payload: IssueCommentEvent;
  try {
    payload = JSON.parse(raw) as IssueCommentEvent;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  if (payload.action !== "created") {
    return c.json({ ignored: "action", action: payload.action }, 202);
  }
  if (!payload.issue.pull_request) {
    return c.json({ ignored: "not_a_pr_comment" }, 202);
  }
  if (!isAlertforgeCommand(payload.comment.body)) {
    return c.json({ ignored: "no_command_prefix" }, 202);
  }

  const enqueued = await dispatchPrComment({
    repo: payload.repository.full_name,
    prNumber: payload.issue.number,
    comment: {
      id: String(payload.comment.id),
      body: payload.comment.body,
      author: payload.comment.user.login,
      createdAt: payload.comment.created_at,
    },
  });
  return c.json(enqueued, 202);
});

/**
 * Shared dispatch path used by both the webhook above and the cron
 * fallback. Returns a status object the caller can include in its
 * response or log.
 */
export async function dispatchPrComment(input: {
  repo: string;
  prNumber: number;
  comment: {
    id: string;
    body: string;
    author: string;
    createdAt: string;
  };
}): Promise<{ ignored?: string; queued?: true; prId?: string }> {
  if (!isAlertforgeCommand(input.comment.body)) return { ignored: "no_command_prefix" };

  const db = createDb();
  const cfgRows = await db
    .select({ prReviewers: repos.prReviewers })
    .from(repos)
    .where(eq(repos.github, input.repo))
    .limit(1);
  const cfg = cfgRows[0];
  if (!cfg) return { ignored: "no_repo_config" };

  // Empty allow-list = "no allow-list" → anyone can drive /alertforge.
  // This is the right default for solo operators who don't want to
  // maintain a list. As soon as the operator adds even one entry to
  // repos.prReviewers, the gate becomes strict: only listed GitHub
  // usernames can issue /alertforge commands.
  if (cfg.prReviewers.length > 0 && !cfg.prReviewers.includes(input.comment.author)) {
    log.info(
      { repo: input.repo, author: input.comment.author },
      "[gh-webhook] sender not in allow list",
    );
    return { ignored: "sender_not_allowed" };
  }

  const prRow = (
    await db
      .select()
      .from(prs)
      .where(and(eq(prs.repo, input.repo), eq(prs.number, input.prNumber)))
      .limit(1)
  )[0];
  if (!prRow) return { ignored: "pr_not_opened_by_alertforge" };

  // Idempotency: skip comments older than (or equal to) the watermark.
  if (
    prRow.lastReviewedCommentAt &&
    new Date(input.comment.createdAt) <= prRow.lastReviewedCommentAt
  ) {
    return { ignored: "older_than_watermark" };
  }

  // Hard guardrail: a closed or merged PR is a terminal state for the
  // bot. The reviewer has resolved the conversation by closing — any
  // further commits on the bot's branch would be wasted work the
  // reviewer can no longer see. `unknown` fails open (transient API
  // error shouldn't block legitimate work).
  const prState = await getPrState({ repo: input.repo, prNumber: input.prNumber });
  if (prState === "closed" || prState === "merged") {
    log.info(
      { repo: input.repo, prNumber: input.prNumber, state: prState },
      "[gh-webhook] skipping followup — pr is closed/merged",
    );
    return { ignored: `pr_${prState}` };
  }

  await publishJob(JOB_PR_FOLLOWUP, {
    prId: prRow.id,
    commentId: input.comment.id,
    commentBody: input.comment.body,
    commentAuthor: input.comment.author,
    commentCreatedAt: input.comment.createdAt,
  });
  return { queued: true, prId: prRow.id };
}
