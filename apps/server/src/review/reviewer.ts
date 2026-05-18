import { renderClaudeHome } from "../agent/render-claude-home";
import { spawnClaudeAgent } from "../agent/spawn";

export type ReviewVerdict = "blocker" | "nit" | "approve" | "unknown";

export type ReviewResult = {
  verdict: ReviewVerdict;
  /** Raw <review> body, suitable for posting as a PR comment. */
  body: string;
  /** Exit code of the reviewer claude process. */
  exitCode: number;
  durationMs: number;
};

export type ReviewInput = {
  cwd: string;
  repo: string;
  baseBranch: string;
  alertTitle: string;
  agentSummary: string;
};

/**
 * Run a second claude pass over the diff produced by the author claude
 * (Phase A — code review at PR open). Uses a deliberately adversarial
 * persona prompt to push back on self-review bias: same model as the
 * author but with an explicit "find at least one issue" instruction so
 * trivial approvals are penalised.
 *
 * Returns a verdict + the full review body. The caller decides whether
 * to post it as a comment, flip the PR to draft, or both — see
 * worker/agent-job.ts.
 */
export async function runReviewer(input: ReviewInput): Promise<ReviewResult> {
  const diff = await collectDiff(input.cwd, input.baseBranch);
  // Empty diff means nothing to review — caller already gates on
  // `hasChanges`, but defend in depth.
  if (!diff.trim()) {
    return {
      verdict: "approve",
      body: "No diff to review.",
      exitCode: 0,
      durationMs: 0,
    };
  }
  const prompt = renderReviewerPrompt({
    alertTitle: input.alertTitle,
    agentSummary: input.agentSummary,
    diff,
  });
  const { mcpConfigPath } = await renderClaudeHome({ repo: input.repo, runDir: input.cwd });
  const res = await spawnClaudeAgent({ cwd: input.cwd, prompt, mcpConfigPath });
  const parsed = parseReview(res.stdout);
  return {
    verdict: parsed.verdict,
    body: parsed.body,
    exitCode: res.exitCode,
    durationMs: res.durationMs,
  };
}

async function collectDiff(cwd: string, baseBranch: string): Promise<string> {
  const proc = Bun.spawn(["git", "diff", `origin/${baseBranch}...HEAD`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // Cap the diff so the reviewer prompt stays under context: claude
  // sonnet handles ~200k tokens, but a 50k-line megadiff drowns out the
  // review instructions. 60k chars ≈ 15k tokens.
  return out.slice(0, 60_000);
}

function renderReviewerPrompt(input: {
  alertTitle: string;
  agentSummary: string;
  diff: string;
}): string {
  return `You are a strict senior software engineer reviewing a PR another agent
just opened to fix a production Sentry alert. Your job is NOT to approve
quickly — your job is to find real problems.

Review against these criteria, in order of severity:

1. **Correctness** — does the fix actually address the root cause, or
   just suppress the symptom? Are there cases where the new code still
   breaks?
2. **Security** — credentials in code, injection vectors, unsafe
   deserialization, missing authz, secrets in logs.
3. **Regressions** — does the change touch behavior outside the bug it
   was meant to fix? Are tests adequate?
4. **Style / maintainability** — naming, dead code, magic numbers,
   inconsistent with existing patterns in the repo.

You MUST find at least one issue or genuine concern; if you cannot,
re-read the diff and look harder for edge cases the author missed.

Emit your output in this EXACT shape (no prose outside the envelope):

<review>
<verdict>blocker | nit | approve</verdict>
<summary>One-sentence verdict.</summary>
<issues>
- **[blocker|nit]** path/to/file.ts:LINE — what is wrong; why it
  matters; what the author should change. One bullet per issue.
</issues>
</review>

Rules for verdict:
- "blocker" — at least one correctness or security issue. PR must NOT
  merge until addressed.
- "nit"     — style or minor maintainability findings only. PR can
  merge as-is; comments are advisory.
- "approve" — the fix is correct, tested, and you found no issues
  (rare; default to "nit" if uncertain).

ORIGINAL ALERT: ${input.alertTitle}

AUTHOR AGENT'S OWN SUMMARY (for context — do NOT take its word for it):
${input.agentSummary}

DIFF UNDER REVIEW:
\`\`\`diff
${input.diff}
\`\`\`
`;
}

function parseReview(stdout: string): { verdict: ReviewVerdict; body: string } {
  const m = stdout.match(/<review>([\s\S]*?)<\/review>/i);
  if (!m || m[1] === undefined) {
    // No envelope — return the raw stdout as a "unknown" verdict so the
    // operator can still see what the reviewer said. agent-job will
    // treat unknown as a non-blocking comment.
    return { verdict: "unknown", body: stdout.trim().slice(0, 4_000) };
  }
  const body = m[1].trim();
  const v = body.match(/<verdict>\s*([a-z]+)\s*<\/verdict>/i)?.[1]?.toLowerCase() ?? "";
  const verdict: ReviewVerdict = v === "blocker" || v === "nit" || v === "approve" ? v : "unknown";
  return { verdict, body };
}
