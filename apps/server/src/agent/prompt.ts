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
 *   /brainstorming — Forces the structured root-cause
 *                                analysis flow before the agent writes
 *                                code. Reduces shotgun fixes.
 *
 * Both are installed in the auto-bootstrapped superpowers skills
 * bundle. If a skill is removed by an operator, claude no-ops on the
 * invocation rather than erroring.
 */
// Skills live as flat directory names under ~/.claude/skills/. Claude's
// slash-command resolver doesn't understand a `bundle:skill` namespace
// — it looks up the exact dir name. The superpowers bundle ships
// subskills as `skills/brainstorming/SKILL.md` etc., which we symlink
// flat into the claude skills dir on bootstrap (see bootstrap-defaults).
const SKILL_PREFIX = ["/sentry-cli", "/brainstorming"].join("\n");

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
   /brainstorming flow before writing any fix — list 2-3
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
 * The step-4 instruction. Critically: claude is told NOT to run the
 * test suite itself. Reasons:
 *
 *   1. Claude's Bash tool has a ~2 min per-call timeout. Real-world
 *      `npm run test:coverage` / `mvn verify` / `pytest --cov` jobs
 *      routinely take 4-10 min. Mid-call SIGKILL with Exit 137 ends
 *      up burning the whole agent timeout for no value.
 *
 *   2. The worker runs the test gate externally (`runRepoTests`) with
 *      no claude-side limit anyway. Whatever claude would run, the
 *      gate also runs — duplicating it just doubles the wait.
 *
 *   3. On failure, the retry prompt feeds back stdout/stderr from the
 *      worker's run so claude can diagnose on the next attempt.
 *
 * When no test command is detected, the gate is skipped and claude
 * gets the same "verify manually" hint we always gave.
 */
function testStep(testCommand: string | null): string {
  if (testCommand) {
    return `Do NOT run tests yourself. The worker will execute
   \`${testCommand}\` automatically after you finish and use the
   result as a hard merge gate. Running tests inside your own Bash
   tool would hit its 2-minute timeout long before this repo's test
   suite finishes, and would only duplicate what the worker is going
   to do anyway. If a previous attempt's test output is supplied in a
   <previous-attempt> block, use it to diagnose; otherwise write the
   fix, write any tests it implies, and stop.`;
  }
  return `No automated test command was detected in this repo (no
   package.json/pyproject.toml/pom.xml/build.gradle/go.mod/Cargo.toml/
   Gemfile/composer.json/Makefile with a test target). Verify your
   fix manually against the stack trace and any related code paths.
   The PR will still be opened but no gate will run.`;
}
