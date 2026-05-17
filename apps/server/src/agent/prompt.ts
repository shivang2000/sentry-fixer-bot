export type PromptInput = {
  title: string;
  stackTrace: string;
  suspectedFiles: string[];
  testCommand: string;
  sentryIssueId?: string;
  sentryProject?: string;
  sentryOrgSlug?: string;
  sentryLevel?: string;
};

/**
 * Two skill invocations prefixed at the top of every agent prompt:
 *
 *   /sentry-cli                — gives claude direct access to the
 *                                sentry CLI for fetching extra event
 *                                metadata (breadcrumbs, replays,
 *                                org-wide context) beyond what the
 *                                webhook payload includes.
 *   /superpowers:brainstorming — Forces the structured root-cause
 *                                analysis flow before the agent writes
 *                                code. Reduces shotgun fixes.
 *
 * Both are installed in the auto-bootstrapped superpowers skills
 * bundle. If a skill is removed by an operator, claude no-ops on the
 * invocation rather than erroring.
 */
const SKILL_PREFIX = ["/sentry-cli", "/superpowers:brainstorming"].join("\n");

export function renderAgentPrompt(input: PromptInput): string {
  const filesHint =
    input.suspectedFiles.length > 0
      ? `Suspected files: ${input.suspectedFiles.join(", ")}.`
      : "No suspected files; locate from the stack trace.";

  const sentryRef =
    input.sentryIssueId && input.sentryOrgSlug
      ? `\nSENTRY ISSUE: https://${input.sentryOrgSlug}.sentry.io/issues/${input.sentryIssueId}/\nUse \`sentry issues view ${input.sentryIssueId}\` from /sentry-cli for the full event context.`
      : "";

  const severityHint = input.sentryLevel ? `\nSEVERITY: ${input.sentryLevel}` : "";

  return `${SKILL_PREFIX}

You are a software engineer triaging a production exception.

Your job:
1. Read the stack trace and identify the root cause. Use the
   /superpowers:brainstorming flow before writing any fix — list 2-3
   competing hypotheses, then pick one with evidence.
2. Make the minimal code change that fixes the issue.
3. Add a test that fails before the fix and passes after.
4. Run \`${input.testCommand}\` and ensure it passes.
5. When done, write a short summary in <summary>...</summary> tags
   including:
   - "confidence": low | medium | high
   - "risk": low | medium | high
   - "severity": low | medium | high | critical
   - what you changed and why.

Constraints:
- Touch only files relevant to this fix.
- Do not change package.json dependencies.
- Do not commit secrets.
- Keep the diff small.

ALERT TITLE: ${input.title}${severityHint}${sentryRef}

STACK TRACE:
${input.stackTrace}

${filesHint}`;
}
