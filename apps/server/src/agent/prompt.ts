export type PromptInput = {
  title: string;
  stackTrace: string;
  suspectedFiles: string[];
  /**
   * The test command the gate will run after the agent finishes. May
   * be null when the workspace has no detectable test setup (no
   * package.json/pyproject.toml/pom.xml/etc); in that case the prompt
   * still asks the agent to verify the fix manually but no hard gate
   * runs.
   */
  testCommand: string | null;
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
4. ${testStep(input.testCommand)}
5. When done, emit a structured summary in this EXACT shape so the PR
   description renders cleanly. Every tag is required — leave the body
   empty if a section truly does not apply:

<summary>
<problem>
One paragraph: what the exception is, where it fires, what user
behavior triggers it. Quote the failing line if useful.
</problem>
<hypotheses>
- H1: <hypothesis> — rejected because <evidence>
- H2: <hypothesis> — rejected because <evidence>
- H3: <hypothesis> — CHOSEN because <evidence>
At least two entries; mark exactly one as CHOSEN.
</hypotheses>
<fix>
What you actually changed and why this addresses the chosen
hypothesis. List the files touched.
</fix>
<confidence>low | medium | high</confidence>
<risk>low | medium | high</risk>
<severity>low | medium | high | critical</severity>
</summary>

Constraints:
- Touch only files relevant to this fix.
- Do not bump dependency versions or change lockfiles (package.json,
  pyproject.toml, pom.xml, go.mod, Cargo.toml, Gemfile, composer.json,
  etc.). Surface dependency issues in <fix> instead so a human can
  decide.
- Do not commit secrets.
- Keep the diff small.

ALERT TITLE: ${input.title}${severityHint}${sentryRef}

STACK TRACE:
${input.stackTrace}

${filesHint}`;
}

/**
 * The step-4 line of the prompt depends on whether a test command was
 * detected. If yes, the gate will hard-block the PR on test failure,
 * so the agent must run + pass it. If no, the agent should still
 * sanity-check its fix but the worker won't enforce anything.
 */
function testStep(testCommand: string | null): string {
  if (testCommand) {
    return `**MANDATORY**: Run \`${testCommand}\` and confirm it exits 0
   before you finish. If dependencies are missing, install them first
   using the repo's package manager (npm/pnpm/yarn/poetry/pip/maven/
   gradle/cargo/go mod/etc — pick the one matching the lockfile in
   this repo). If the command fails, FIX it before stopping. The
   CI/CD pipeline runs this exact command on merge; if it fails here,
   the PR will not be opened.`;
  }
  return `No automated test command was detected in this repo (no
   package.json/pyproject.toml/pom.xml/build.gradle/go.mod/Cargo.toml/
   Gemfile/composer.json/Makefile with a test target). Verify your
   fix manually against the stack trace and any related code paths.
   The PR will still be opened but no gate will run.`;
}
