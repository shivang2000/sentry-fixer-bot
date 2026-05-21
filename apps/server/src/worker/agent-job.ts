import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findAlertById, postIssueComment } from "@alertforge/source-sentry";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { parseAgentOutput } from "../agent/parse-output";
import { renderAgentPrompt } from "../agent/prompt";
import { renderClaudeHome } from "../agent/render-claude-home";
import { type SecretFinding, scanText } from "../agent/secret-scan";
import { spawnClaudeAgent } from "../agent/spawn";
import { bindStreamToRunLogs } from "../agent/stream-parser";
import { createWorkspace } from "../agent/workspace";
import { checkRepoBudget, recordUsage } from "../budget/enforce";
import { resolveTestCommand } from "../gate/detect-test-command";
import { ensureDeps } from "../gate/ensure-deps";
import { runRepoTests } from "../gate/run-tests";
import { openPr } from "../github/pr";
import { commentOnPr, convertPrToDraft } from "../github/pr-ops";
import { log } from "../log";
import type { AgentJob } from "../queue/jobs";
import { runReviewer } from "../review/reviewer";
import { appendRunLog } from "../runs/log";
import { findRunById, updateRun } from "../runs/persist";

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

  // ws is created inside the try so any workspace-creation failure
  // (stale worktree, git fetch 401, disk full) flows through the
  // catch and sets status=error instead of leaving the run stuck on
  // "running" forever. The finally guards against ws being undefined
  // when cleanup runs.
  let ws: Awaited<ReturnType<typeof createWorkspace>> | undefined;
  try {
    await appendRunLog({
      runId: payload.runId,
      level: "info",
      source: "agent",
      message: `Cloning ${payload.repo}@${cfg.defaultBranch} into work dir…`,
    });
    ws = await createWorkspace({
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
    // Resolve test command up-front so the agent's prompt can include
    // the exact command we'll gate on later. `cfg.testCommand` is an
    // override; otherwise we inspect the worktree's package.json. If
    // neither yields a command, the gate is skipped and the prompt
    // tells the agent there are no tests to run.
    const resolvedTest = await resolveTestCommand({
      cwd: ws.dir,
      override: cfg.testCommand ?? null,
    });
    await appendRunLog({
      runId: payload.runId,
      level: "info",
      source: "tests",
      message: resolvedTest
        ? `Test command (${resolvedTest.source}): ${resolvedTest.command}`
        : "No test command found (no override + no test:coverage/test script). Skipping test gate.",
    });

    // Install project dependencies BEFORE the agent runs. Reason: the
    // gate later invokes `${resolvedTest.command}` which usually
    // requires node_modules (or poetry env, etc.). A clean worktree
    // has none. We can't ask claude to install — its Bash tool would
    // either hit its 2-min timeout or fight with the gate. Running it
    // here means: (1) one install per worktree, not per attempt; (2)
    // gate failures will be real test failures, not "command not
    // found". Best-effort: non-zero exit logged but doesn't abort —
    // some repos warn but still produce a usable node_modules.
    if (resolvedTest) {
      await appendRunLog({
        runId: payload.runId,
        level: "info",
        source: "deps",
        message: "Detecting + installing project dependencies for test gate…",
      });
      const dep = await ensureDeps({ cwd: ws.dir });
      if (dep.ran) {
        await appendRunLog({
          runId: payload.runId,
          level: dep.exitCode === 0 ? "info" : "warn",
          source: "deps",
          message: `${dep.command} → exit ${dep.exitCode} in ${(dep.durationMs / 1000).toFixed(1)}s`,
        });
        if (dep.stderr && dep.exitCode !== 0) {
          await appendRunLog({
            runId: payload.runId,
            level: "warn",
            source: "deps",
            message: dep.stderr.slice(-2000),
          });
        }
      } else {
        await appendRunLog({
          runId: payload.runId,
          level: "debug",
          source: "deps",
          message: "No recognised lockfile/manifest; skipping dependency install.",
        });
      }
    }

    const prompt = renderAgentPrompt({
      title: alert.title,
      stackTrace: run.stackTrace ?? "",
      suspectedFiles: run.suspectedFiles ?? [],
      testCommand: resolvedTest?.command ?? null,
      sentryIssueId: alert.sentryIssueId,
      sentryProject: alert.sentryProject,
      sentryOrgSlug: process.env.SENTRY_ORG_SLUG,
      sentryLevel: alert.level,
    });

    const { mcpConfigPath } = await renderClaudeHome({ repo: payload.repo, runDir: ws.dir });

    // Self-heal loop: spawn the agent, run the test gate, and if the
    // gate fails (and there's a gate to fail), re-spawn the agent with
    // the failure output appended so it can iterate. Bounded to keep
    // runaway runs from chewing token budget — three attempts has been
    // the empirical sweet spot in other agentic systems for "fix what
    // you broke" without turning into an infinite loop on genuinely
    // hard test failures.
    const MAX_AGENT_ATTEMPTS = 3;
    let agentRes = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
    let testPassed: boolean | null = null;
    let lastTestStdout = "";
    let lastTestStderr = "";

    for (let attempt = 1; attempt <= MAX_AGENT_ATTEMPTS; attempt++) {
      const isRetry = attempt > 1;
      const attemptPrompt = isRetry
        ? renderRetryPrompt({
            originalPrompt: prompt,
            testCommand: resolvedTest?.command ?? "",
            testStdoutTail: lastTestStdout.slice(-3000),
            testStderrTail: lastTestStderr.slice(-3000),
            attempt,
            maxAttempts: MAX_AGENT_ATTEMPTS,
          })
        : prompt;

      await appendRunLog({
        runId: payload.runId,
        level: "info",
        source: "agent",
        message: isRetry
          ? `Retry attempt ${attempt}/${MAX_AGENT_ATTEMPTS}: re-spawning claude with failing-test context…`
          : `Spawning claude (model=sonnet, effort=high) in ${ws.dir}…`,
      });
      agentRes = await spawnClaudeAgent({
        cwd: ws.dir,
        prompt: attemptPrompt,
        mcpConfigPath,
        // Stream each claude event (tool call / assistant text /
        // result) into run_logs so /runs/<id> shows live progress
        // instead of a single line + a long silent wait.
        onLine: bindStreamToRunLogs(payload.runId, "agent-stream"),
      });
      await appendRunLog({
        runId: payload.runId,
        level: agentRes.exitCode === 0 ? "info" : "error",
        source: "agent",
        message: `claude exit ${agentRes.exitCode} in ${(agentRes.durationMs / 1000).toFixed(1)}s (attempt ${attempt})`,
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

      // Hard fail on the agent itself — no point retrying a broken
      // tool. Operator must re-trigger after fixing claude.
      if (agentRes.exitCode !== 0) break;

      // No test gate configured for this repo → nothing to verify;
      // succeed and move on.
      if (!resolvedTest) {
        testPassed = null;
        break;
      }

      await appendRunLog({
        runId: payload.runId,
        level: "info",
        source: "tests",
        message: `Running \`${resolvedTest.command}\` (${resolvedTest.source}${resolvedTest.ecosystem ? ` / ${resolvedTest.ecosystem}` : ""}), attempt ${attempt}…`,
      });
      const testRes = await runRepoTests({ cwd: ws.dir, testCommand: resolvedTest.command });
      testPassed = testRes.passed;
      lastTestStdout = testRes.stdout;
      lastTestStderr = testRes.stderr;
      await appendRunLog({
        runId: payload.runId,
        level: testRes.passed ? "info" : "warn",
        source: "tests",
        message: testRes.passed
          ? `Tests passed on attempt ${attempt}.`
          : attempt < MAX_AGENT_ATTEMPTS
            ? `Tests failed on attempt ${attempt}. Will retry.`
            : `Tests failed on attempt ${attempt} (final). PR will not be opened.`,
      });
      if (testRes.stdout) {
        await appendRunLog({
          runId: payload.runId,
          level: "debug",
          source: "tests-stdout",
          message: testRes.stdout.slice(-4000),
        });
      }
      if (testRes.stderr) {
        await appendRunLog({
          runId: payload.runId,
          level: testRes.passed ? "debug" : "error",
          source: "tests-stderr",
          message: testRes.stderr.slice(-4000),
        });
      }

      if (testRes.passed) break;
      // else: loop tail → next iteration will build a retry prompt
      // from the just-captured stdout/stderr.
    }

    const outcome = parseAgentOutput(agentRes.stdout);

    // Secret scan of the diff (after the loop — only the final state
    // matters; intermediate scans would be noise).
    const findings = await scanWorkspace(ws.dir);

    const needsHuman = findings.length > 0;
    const isDraft = findings.length > 0;

    await updateRun(payload.runId, {
      agentSummary: outcome.summary,
      agentConfidence: outcome.confidence,
      agentRisk: outcome.risk,
      testPassed,
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

    // Tests must pass when we have a command to run them. Repos without
    // any detected test setup skip this entirely — see the comment on
    // the gate above for the rationale.
    if (resolvedTest && testPassed === false) {
      await postIssueComment(
        alert.sentryIssueId,
        `sentry-fixer-bot: agent produced a fix but \`${resolvedTest.command}\` failed. No PR opened. See /runs/${payload.runId} for the test output.`,
      );
      await updateRun(payload.runId, { status: "test_failed", endedAt: new Date() });
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
      testPassed,
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
      runId: payload.runId,
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
    // testPassed is either true (gate ran + passed) or null (no tests
    // detected and gate skipped). The `false` case returned earlier in
    // the test-failed branch, so we don't need to handle it here.
    await updateRun(payload.runId, {
      status: review.verdict === "blocker" ? "pr_opened_needs_human" : "pr_opened",
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
    if (ws) await ws.cleanup();
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
 * Build the prompt for a retry attempt after the test gate failed.
 *
 * The original prompt is included verbatim (so the agent still has the
 * stack trace + structured-summary requirements + skill prefix) plus a
 * `<previous-attempt>` block carrying the failing stdout/stderr tail.
 * The agent is told explicitly to fix what it just shipped, not start
 * over from scratch — the worktree already has its previous diff
 * applied, so a fresh re-analysis would be wasteful and could revert
 * useful work.
 */
function renderRetryPrompt(input: {
  originalPrompt: string;
  testCommand: string;
  testStdoutTail: string;
  testStderrTail: string;
  attempt: number;
  maxAttempts: number;
}): string {
  return `${input.originalPrompt}

---

<previous-attempt>
Your previous fix attempt has already been applied to the working
copy, but the test gate (\`${input.testCommand}\`) is still failing.
This is attempt ${input.attempt}/${input.maxAttempts}; if you cannot
make the tests pass on this attempt, the PR will NOT be opened.

Diagnose the failure from the output below, then apply the smallest
change that turns the suite green. Do not revert your earlier diff
unless it was clearly the cause — prefer fixing forward. Do NOT run
the test command yourself — the worker will re-run it after you
finish. Your Bash tool has a 2-minute per-call timeout that this
repo's suite usually exceeds, so a self-run would just get killed.

TEST STDOUT (tail):
${input.testStdoutTail || "(empty)"}

TEST STDERR (tail):
${input.testStderrTail || "(empty)"}
</previous-attempt>
`;
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
  testPassed: boolean | null;
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
  lines.push(
    `- Tests: ${
      input.testPassed === true
        ? "✅ pass"
        : input.testPassed === false
          ? "❌ fail"
          : "⚪ no test command detected — verify manually"
    }`,
  );
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
