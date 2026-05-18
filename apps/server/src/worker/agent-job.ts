import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { parseAgentOutput } from "../agent/parse-output";
import { renderAgentPrompt } from "../agent/prompt";
import { renderClaudeHome } from "../agent/render-claude-home";
import { type SecretFinding, scanText } from "../agent/secret-scan";
import { spawnClaudeAgent } from "../agent/spawn";
import { createWorkspace } from "../agent/workspace";
import { findAlertById } from "../alerts/persist";
import { checkRepoBudget, recordUsage } from "../budget/enforce";
import { runRepoTests } from "../gate/run-tests";
import { openPr } from "../github/pr";
import { commentOnPr, convertPrToDraft } from "../github/pr-ops";
import { log } from "../log";
import type { AgentJob } from "../queue/jobs";
import { runReviewer } from "../review/reviewer";
import { appendRunLog } from "../runs/log";
import { findRunById, updateRun } from "../runs/persist";
import { postIssueComment } from "../sentry/comment";

export async function processAgentJob(payload: AgentJob): Promise<void> {
  const run = await findRunById(payload.runId);
  if (!run) return;
  const alert = await findAlertById(payload.alertId);
  if (!alert) return;

  const db = createDb();
  const cfgRows = await db
    .select()
    .from(reposConfig)
    .where(eq(reposConfig.github, payload.repo))
    .limit(1);
  const cfg = cfgRows[0];
  if (!cfg) {
    await updateRun(payload.runId, { status: "no_repo_match", endedAt: new Date() });
    return;
  }

  // Budget check
  const budget = await checkRepoBudget(payload.repo);
  if (!budget.allowed) {
    await postIssueComment(
      alert.sentryIssueId,
      `sentry-fixer-bot: budget exhausted (${budget.reason}); not attempting a fix today.`,
    );
    await updateRun(payload.runId, { status: "budget_exhausted", endedAt: new Date() });
    return;
  }

  await appendRunLog({
    runId: payload.runId,
    level: "info",
    source: "agent",
    message: `Cloning ${payload.repo}@${cfg.defaultBranch} into work dir…`,
  });
  const ws = await createWorkspace({
    runId: payload.runId,
    repo: payload.repo,
    baseBranch: cfg.defaultBranch,
  });
  await appendRunLog({
    runId: payload.runId,
    level: "info",
    source: "agent",
    message: `Workspace ready: ${ws.dir} (branch ${ws.branch})`,
  });

  try {
    const prompt = renderAgentPrompt({
      title: alert.title,
      stackTrace: run.stackTrace ?? "",
      suspectedFiles: run.suspectedFiles ?? [],
      testCommand: cfg.testCommand,
      sentryIssueId: alert.sentryIssueId,
      sentryProject: alert.sentryProject,
      sentryOrgSlug: process.env.SENTRY_ORG_SLUG,
      sentryLevel: alert.level,
    });

    const { mcpConfigPath } = await renderClaudeHome({ repo: payload.repo, runDir: ws.dir });
    await appendRunLog({
      runId: payload.runId,
      level: "info",
      source: "agent",
      message: `Spawning claude (model=sonnet, effort=high) in ${ws.dir}…`,
    });
    // Intentionally no `home` override — claude reads creds from
    // /sfb/state/home/.claude/.credentials.json (set by `claude auth
    // login` in the wizard). Per-run claude-home directory is empty;
    // pointing HOME there guarantees an exit-1 "not authenticated".
    // MCP config still flows via --mcp-config to the absolute path.
    const agentRes = await spawnClaudeAgent({ cwd: ws.dir, prompt, mcpConfigPath });
    await appendRunLog({
      runId: payload.runId,
      level: agentRes.exitCode === 0 ? "info" : "error",
      source: "agent",
      message: `claude exit ${agentRes.exitCode} in ${(agentRes.durationMs / 1000).toFixed(1)}s`,
    });
    if (agentRes.stdout) {
      await appendRunLog({
        runId: payload.runId,
        level: "debug",
        source: "agent",
        message: agentRes.stdout.slice(-4000),
      });
    }
    if (agentRes.stderr) {
      await appendRunLog({
        runId: payload.runId,
        level: agentRes.exitCode === 0 ? "debug" : "error",
        source: "claude-stderr",
        message: agentRes.stderr.slice(-4000),
      });
    }
    const outcome = parseAgentOutput(agentRes.stdout);

    // Secret scan of the diff
    const findings = await scanWorkspace(ws.dir);

    // Run repo tests
    const testRes = await runRepoTests({ cwd: ws.dir, testCommand: cfg.testCommand });
    const isDraft = !testRes.passed || findings.length > 0;
    const needsHuman = isDraft;

    await updateRun(payload.runId, {
      agentSummary: outcome.summary,
      agentConfidence: outcome.confidence,
      agentRisk: outcome.risk,
      testPassed: testRes.passed,
    });

    // claude bailed mid-flight (auth, transient API, hit token cap).
    // The workspace may still have a partial diff that's worse than no
    // PR — skip and record no_change. Operator sees the agent log line
    // with exit code and can re-trigger.
    if (agentRes.exitCode !== 0) {
      await appendRunLog({
        runId: payload.runId,
        level: "error",
        source: "agent",
        message: "claude exited non-zero; skipping PR open.",
      });
      await updateRun(payload.runId, { status: "agent_error", endedAt: new Date() });
      return;
    }

    // If agent didn't produce any change, no PR
    if (!(await hasChanges(ws.dir))) {
      await appendRunLog({
        runId: payload.runId,
        level: "warn",
        source: "agent",
        message: "claude produced no diff. Skipping PR. Summary recorded as triage-only.",
      });
      await updateRun(payload.runId, { status: "no_change", endedAt: new Date() });
      await postIssueComment(
        alert.sentryIssueId,
        `sentry-fixer-bot: agent ran but produced no code change. Triage: ${outcome.summary.slice(0, 500)}`,
      );
      return;
    }

    const title = `sfb: ${alert.title.slice(0, 100)}`;
    const body = renderPrBody({
      alert: alert.title,
      problem: outcome.problem,
      hypotheses: outcome.hypotheses,
      fix: outcome.fix,
      summary: outcome.summary,
      confidence: outcome.confidence,
      risk: outcome.risk,
      severity: outcome.severity,
      testPassed: testRes.passed,
      findings,
    });

    const pr = await openPr({
      cwd: ws.dir,
      repo: payload.repo,
      branch: ws.branch,
      baseBranch: cfg.defaultBranch,
      title,
      body,
      isDraft,
      reviewers: cfg.prReviewers,
    });

    // Phase A — automated code-review pass. A second claude reviews the
    // diff with an adversarial reviewer persona, posts findings as a PR
    // comment, and flips the PR to draft when it finds a `blocker` so
    // the bot doesn't pretend the work is ready when it isn't.
    //
    // Failure-mode: reviewer crashes or returns unknown verdict —
    // treated as advisory; PR stays in whatever draft state the test
    // gate decided. We never want the reviewer to be a blocking
    // dependency on opening the PR (the PR already exists at this
    // point).
    await appendRunLog({
      runId: payload.runId,
      level: "info",
      source: "reviewer",
      message: "Running automated code review pass…",
    });
    const review = await runReviewer({
      cwd: ws.dir,
      repo: payload.repo,
      baseBranch: cfg.defaultBranch,
      alertTitle: alert.title,
      agentSummary: outcome.summary,
    });
    await appendRunLog({
      runId: payload.runId,
      level: review.verdict === "blocker" ? "warn" : "info",
      source: "reviewer",
      message: `Review verdict=${review.verdict} (exit ${review.exitCode}, ${(review.durationMs / 1000).toFixed(1)}s)`,
    });

    let finalIsDraft = isDraft;
    let humanReviewState: "none" | "waiting_human" = "none";
    if (review.verdict === "blocker") {
      humanReviewState = "waiting_human";
      if (!isDraft) {
        const dExit = await convertPrToDraft({ repo: payload.repo, prNumber: pr.number });
        finalIsDraft = dExit === 0;
        await appendRunLog({
          runId: payload.runId,
          level: dExit === 0 ? "info" : "warn",
          source: "reviewer",
          message:
            dExit === 0
              ? "Reviewer found blocker — PR converted to draft."
              : `Failed to convert PR to draft (gh exit ${dExit}); leaving as-is.`,
        });
      } else {
        await appendRunLog({
          runId: payload.runId,
          level: "info",
          source: "reviewer",
          message: "Reviewer found blocker — PR already draft.",
        });
      }
    }

    // Post the review as a PR comment regardless of verdict, so the
    // human reviewer can see why the bot did (or didn't) flip to draft.
    // Adds a /sfb help footer so reviewers know how to reply.
    const reviewComment = renderReviewComment(review.verdict, review.body);
    await commentOnPr({ repo: payload.repo, prNumber: pr.number, body: reviewComment });

    await db.insert(prs).values({
      alertId: alert.id,
      runId: payload.runId,
      repo: payload.repo,
      number: pr.number,
      url: pr.url,
      isDraft: finalIsDraft,
      needsHuman: needsHuman || review.verdict === "blocker",
      humanReviewState,
    });

    await appendRunLog({
      runId: payload.runId,
      level: "info",
      source: "agent",
      message: `PR opened: ${pr.url}${finalIsDraft ? " (draft)" : ""}`,
    });
    await postIssueComment(alert.sentryIssueId, `sentry-fixer-bot: opened PR ${pr.url}`);
    await updateRun(payload.runId, {
      status:
        review.verdict === "blocker"
          ? "pr_opened_needs_human"
          : testRes.passed
            ? "pr_opened"
            : "pr_opened_needs_human",
      endedAt: new Date(),
    });

    // Record budget (token/cost numbers are stubbed; spawn doesn't return them in headless mode)
    await recordUsage({
      repo: payload.repo,
      tokens: 0,
      costCents: 0,
      capTokens: cfg.dailyTokenCap,
      capCostCents: cfg.dailyCostCapCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "agent job failed");
    await appendRunLog({ runId: payload.runId, level: "error", source: "agent", message: msg });
    await updateRun(payload.runId, {
      status: "error",
      error: msg,
      endedAt: new Date(),
    });
  } finally {
    await ws.cleanup();
  }
}

async function hasChanges(cwd: string): Promise<boolean> {
  const proc = Bun.spawn(["git", "status", "--porcelain"], { cwd, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().length > 0;
}

async function scanWorkspace(dir: string): Promise<SecretFinding[]> {
  // Scan only files git considers modified to limit the surface
  const proc = Bun.spawn(["git", "diff", "--name-only", "HEAD"], { cwd: dir, stdout: "pipe" });
  const names = (await new Response(proc.stdout).text())
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  await proc.exited;

  const findings: SecretFinding[] = [];
  for (const name of names) {
    try {
      const content = await readFile(join(dir, name), "utf8");
      findings.push(...scanText(name, content));
    } catch {
      // file deleted or unreadable; skip
    }
  }
  return findings;
}

/**
 * Wrap the reviewer's raw output in a comment shell that:
 *  - badges the verdict at the top so humans can scan a list of PRs
 *    and tell blocker-comments apart from nit-comments,
 *  - documents the /sfb commands the human reviewer can use to talk
 *    back to the bot (Phase B follow-up loop).
 */
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
    "- `/sfb apply` — apply the suggested fixes and push back to this branch.",
    "- `/sfb <free-form instruction>` — e.g. `/sfb only fix the security issue, ignore the style nit`.",
    "_Comments without the `/sfb` prefix are treated as human-to-human chatter and ignored by the bot._",
  ].join("\n");

  return `${badge}\n\n${body}${helpFooter}`;
}

function renderPrBody(input: {
  alert: string;
  problem: string;
  hypotheses: string;
  fix: string;
  summary: string;
  confidence: string;
  risk: string;
  severity: string;
  testPassed: boolean;
  findings: SecretFinding[];
}): string {
  const lines: string[] = [];
  lines.push("**sentry-fixer-bot** drafted this fix for a Sentry alert.");
  lines.push("");
  lines.push(`> ${input.alert}`);
  lines.push("");
  lines.push(`- Confidence: \`${input.confidence}\``);
  lines.push(`- Risk: \`${input.risk}\``);
  lines.push(`- Severity: \`${input.severity}\``);
  lines.push(`- Tests: ${input.testPassed ? "✅ pass" : "❌ fail (draft)"}`);
  if (input.findings.length > 0) {
    lines.push(`- ⚠️ Secret-scan findings: ${input.findings.length}`);
    lines.push("");
    for (const f of input.findings) {
      lines.push(`  - ${f.file}:${f.line} (${f.pattern})`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Structured sections when the agent emitted them. Falls back to the
  // raw summary blob when the envelope was malformed so we never lose
  // the agent's output entirely.
  const hasStructured = input.problem || input.hypotheses || input.fix;
  if (hasStructured) {
    if (input.problem) {
      lines.push("## Problem");
      lines.push("");
      lines.push(input.problem);
      lines.push("");
    }
    if (input.hypotheses) {
      lines.push("## Alternatives considered");
      lines.push("");
      lines.push(input.hypotheses);
      lines.push("");
    }
    if (input.fix) {
      lines.push("## Fix");
      lines.push("");
      lines.push(input.fix);
      lines.push("");
    }
  } else {
    lines.push("**Agent summary:**");
    lines.push("");
    lines.push(input.summary);
  }
  return lines.join("\n");
}
