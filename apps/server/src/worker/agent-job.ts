import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { parseAgentOutput } from "../agent/parse-output";
import { renderAgentPrompt } from "../agent/prompt";
import { type SecretFinding, scanText } from "../agent/secret-scan";
import { spawnClaudeAgent } from "../agent/spawn";
import { createWorkspace } from "../agent/workspace";
import { findAlertById } from "../alerts/persist";
import { checkRepoBudget, recordUsage } from "../budget/enforce";
import { runRepoTests } from "../gate/run-tests";
import { openPr } from "../github/pr";
import { log } from "../log";
import type { AgentJob } from "../queue/jobs";
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

  const ws = await createWorkspace({
    runId: payload.runId,
    repo: payload.repo,
    baseBranch: cfg.defaultBranch,
  });

  try {
    const prompt = renderAgentPrompt({
      title: alert.title,
      stackTrace: run.stackTrace ?? "",
      suspectedFiles: run.suspectedFiles ?? [],
      testCommand: cfg.testCommand,
    });

    const agentRes = await spawnClaudeAgent({ cwd: ws.dir, prompt });
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

    // If agent didn't produce any change, no PR
    if (!(await hasChanges(ws.dir))) {
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
      summary: outcome.summary,
      confidence: outcome.confidence,
      risk: outcome.risk,
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

    await db.insert(prs).values({
      alertId: alert.id,
      runId: payload.runId,
      repo: payload.repo,
      number: pr.number,
      url: pr.url,
      isDraft,
      needsHuman,
    });

    await postIssueComment(alert.sentryIssueId, `sentry-fixer-bot: opened PR ${pr.url}`);
    await updateRun(payload.runId, {
      status: testRes.passed ? "pr_opened" : "pr_opened_needs_human",
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
    log.error({ err: err instanceof Error ? err.message : err }, "agent job failed");
    await updateRun(payload.runId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
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

function renderPrBody(input: {
  alert: string;
  summary: string;
  confidence: string;
  risk: string;
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
  lines.push("**Agent summary:**");
  lines.push("");
  lines.push(input.summary);
  return lines.join("\n");
}
