/**
 * PipelineStep wrapper around @alertforge/step-open-pr.
 *
 * Decides draft state, renders the PR body, and invokes the bundled
 * `openPr` (commit + push + gh pr create) via deps.resolveToken.
 * Writes ctx.pr with the resulting URL + number.
 *
 * Skip rules:
 *   - cfg.stopAfter='budget' (triage_only): no PR at all.
 *   - agent exit code != 0: agent bailed; the diff might be partial
 *     and worse than no PR. Mirrors legacy behavior.
 *   - secret_scan.blocked = true (strict mode found a secret): never
 *     ship credentials. Aligns with spec scenario #6.
 *   - workspace missing: nothing to open.
 *
 * Reads:  ctx.workspace, ctx.alert, ctx.agent_output, ctx.test_result,
 *         ctx.secret_scan, ctx.trigger (for reviewers list)
 * Writes: ctx.pr
 */

import type {
  CtxStore,
  NormalizedAlert,
  PipelineStep,
  ResolvedConfig,
  ResolveToken,
  StepDeps,
} from "@alertforge/core";
import type { SecretFinding } from "@alertforge/step-secret-scan";
import type { AgentOutput } from "./fix-agent";
import type { SecretScanCtxValue } from "./secret-scan";
import type { TestResultCtxValue } from "./test-gate";
import type { WorkspaceCtxValue } from "./workspace";

export interface PrCtxValue {
  number: number;
  url: string;
  isDraft: boolean;
  needsHuman: boolean;
}

export type OpenPrFn = (input: {
  cwd: string;
  repo: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  isDraft: boolean;
  reviewers: string[];
  resolveToken: ResolveToken;
}) => Promise<{ number: number; url: string }>;

export interface WrapOpenPrOpts {
  /** Override for tests. */
  openPrFn?: OpenPrFn;
  /** owner/name from the AgentJob payload. */
  repo: string;
  /** From repos_config.prReviewers, threaded through by deps-factory. */
  reviewers?: string[];
}

export async function runOpenPrStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapOpenPrOpts,
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) return;
  const alert = await ctx.read<NormalizedAlert>("alert");
  const agentOutput = await ctx.read<AgentOutput>("agent_output");
  const testResult = await ctx.read<TestResultCtxValue>("test_result");
  const secretScan = await ctx.read<SecretScanCtxValue>("secret_scan");
  if (!alert || !agentOutput) return;

  // Hard blocks. See module-level comment for rationale.
  if (agentOutput && (agentOutput as { exitCode?: number }).exitCode !== 0) return;
  if (secretScan?.blocked) {
    await deps.appendLog?.({
      level: "error",
      source: "open-pr",
      message: `Secret scan blocked PR: ${secretScan.findings.length} finding(s).`,
    });
    return;
  }

  const isDraft = (secretScan && secretScan.findings.length > 0) || testResult?.passed === false;
  const needsHuman = secretScan ? secretScan.findings.length > 0 : false;

  const title = `sfb: ${alert.title.slice(0, 100)}`;
  const body = renderPrBody({
    alert: alert.title,
    problem: agentOutput.problem,
    hypotheses: agentOutput.hypotheses,
    fix: agentOutput.fix,
    summary: agentOutput.summary,
    confidence: agentOutput.confidence,
    risk: agentOutput.risk,
    severity: agentOutput.severity,
    testPassed: testResult?.passed ?? null,
    findings: secretScan?.findings ?? [],
  });

  const resolveToken = deps.resolveToken;
  if (!resolveToken) throw new Error("open-pr: deps.resolveToken missing");

  const openPr = opts.openPrFn ?? (await loadOpenPrReal());
  const pr = await openPr({
    cwd: workspace.dir,
    repo: opts.repo,
    branch: workspace.branch,
    baseBranch: workspace.baseBranch,
    title,
    body,
    isDraft,
    reviewers: opts.reviewers ?? [],
    resolveToken,
  });

  const value: PrCtxValue = {
    number: pr.number,
    url: pr.url,
    isDraft,
    needsHuman,
  };
  await ctx.write("pr", value);

  await deps.appendLog?.({
    level: "info",
    source: "open-pr",
    message: `PR opened: ${pr.url}${isDraft ? " (draft)" : ""}`,
  });
}

export async function skipOpenPrIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  return cfg.stopAfter === "budget";
}

export function wrapOpenPrStep(opts: WrapOpenPrOpts): PipelineStep {
  return {
    name: "open-pr",
    description: "Commit + push + gh pr create (bundled openPr fn)",
    skipIf: skipOpenPrIf,
    async run(ctx, cfg, deps) {
      await runOpenPrStep(ctx, cfg, deps, opts);
    },
  };
}

// ---------- helpers ----------

async function loadOpenPrReal(): Promise<OpenPrFn> {
  const m = await import("@alertforge/step-open-pr");
  return m.openPr;
}

export function renderPrBody(input: {
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
  lines.push("**Alertforge** drafted this fix for a Sentry alert.");
  lines.push("");
  lines.push(`> ${input.alert}`);
  lines.push("");
  lines.push(`- Confidence: \`${input.confidence}\``);
  lines.push(`- Risk: \`${input.risk}\``);
  lines.push(`- Severity: \`${input.severity}\``);
  lines.push(
    `- Tests: ${
      input.testPassed === true
        ? "pass"
        : input.testPassed === false
          ? "fail"
          : "no test command detected — verify manually"
    }`,
  );
  if (input.findings.length > 0) {
    lines.push(`- Secret-scan findings: ${input.findings.length}`);
    for (const f of input.findings) {
      lines.push(`  - ${f.file}:${f.line} (${f.pattern})`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
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
