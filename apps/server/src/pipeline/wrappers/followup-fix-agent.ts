/**
 * PipelineStep wrapper for the followup-specific fix-agent loop.
 *
 * Differs from `wrapFixAgentStep` (primary path) in three ways:
 *   1. Prompt content — the primary path renders a fresh agent prompt
 *      from the alert + stack trace; the followup path renders a
 *      reviewer-instruction prompt (alert title + the reviewer's
 *      `/alertforge` or legacy `/sfb` body). Legacy `renderFollowupPrompt`
 *      in pr-followup-job.ts is the source of truth; we preserve it
 *      verbatim here.
 *   2. Stream source tag — `followup-stream` instead of `agent-stream`
 *      so /runs/<id> can distinguish the followup pass from the
 *      original agent run.
 *   3. Reads `ctx.instruction` (reviewer's comment payload) rather
 *      than reaching for ctx.event_detail / ctx.triage.
 *
 * Reuses the same retry-loop SHAPE as wrapFixAgentStep:
 *   - up to MAX_ATTEMPTS spawns (legacy MAX_FOLLOWUP_ATTEMPTS = 3),
 *   - on each retry, the failing test stdout/stderr tails are appended,
 *   - non-zero agent exit breaks the loop early.
 *
 * Writes the same ctx fields the primary fix-agent does
 * (`agent_output`, `agent_transcript`) plus stamps the test recorder
 * side-channel for the downstream test-gate step to consume.
 *
 * Reads:  ctx.alert (for title), ctx.instruction (for body+author),
 *         ctx.workspace
 * Writes: ctx.agent_output, ctx.agent_transcript
 *         + opts.testRecorder side-channel
 */

import type {
  CtxStore,
  NormalizedAlert,
  PipelineStep,
  ResolvedConfig,
  StepDeps,
} from "@alertforge/core";
import type { AppendRunLog, bindStreamToRunLogs as BindStreamFn } from "@alertforge/step-fix-agent";
import {
  bindStreamToRunLogs,
  parseAgentOutput,
  spawnClaudeAgent,
} from "@alertforge/step-fix-agent";
import type {
  EnsureDepsFn,
  ResolveTestCommandFn,
  RunRepoTestsFn,
  SpawnAgentFn,
  TestRecorder,
} from "./fix-agent";
import type { PrGuardHandle } from "./pr-guard";
import type { WorkspaceCtxValue } from "./workspace";

export interface InstructionCtxValue {
  body: string;
  author: string;
  commentId: string;
  createdAt: string;
}

export interface WrapFollowupFixAgentOpts {
  /** Override for tests; production uses real spawnClaudeAgent. */
  spawnAgentFn?: SpawnAgentFn;
  resolveTestCommandFn?: ResolveTestCommandFn;
  ensureDepsFn?: EnsureDepsFn;
  runRepoTestsFn?: RunRepoTestsFn;
  /** Side-channel for test-gate to read the final test attempt result. */
  testRecorder: TestRecorder;
  /** Test command override from repos_config; legacy parity. */
  testCommandOverride?: string | null;
  /** Pre-rendered claude home + mcp config. None in tests. */
  mcpConfigPath?: string;
  /** runId for log routing (matches the ORIGINAL agent run's id). */
  runId: string;
  /** Max retry attempts. Legacy MAX_FOLLOWUP_ATTEMPTS: 3. */
  maxAttempts?: number;
  /** PR-guard handle so we skip when terminated. */
  prGuardHandle: PrGuardHandle;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runFollowupFixAgentStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapFollowupFixAgentOpts,
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) {
    throw new Error(
      "followup-fix-agent: ctx.workspace missing — attach-workspace step must run first",
    );
  }
  const alert = await ctx.read<NormalizedAlert>("alert");
  const instruction = await ctx.read<InstructionCtxValue>("instruction");
  if (!instruction) {
    throw new Error("followup-fix-agent: ctx.instruction missing");
  }

  const resolveTest = opts.resolveTestCommandFn ?? resolveTestCommandReal;
  const ensureDeps = opts.ensureDepsFn ?? ensureDepsReal;
  const runRepoTests = opts.runRepoTestsFn ?? runRepoTestsReal;
  const spawnAgent = opts.spawnAgentFn ?? spawnClaudeAgent;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Resolve test command up-front so the prompt can mention it.
  const resolvedTest = await resolveTest({
    cwd: workspace.dir,
    override: opts.testCommandOverride ?? null,
  });
  await deps.appendLog?.({
    level: "info",
    source: "followup",
    message: resolvedTest
      ? `Test command (${resolvedTest.source}): ${resolvedTest.command}`
      : "No test command detected — gate will be skipped.",
  });

  // Install deps for the worktree before the agent runs. Followup
  // worktrees are fresh re-attaches off the cached repo and have no
  // node_modules. Same rationale as the primary agent path: one
  // install per worktree, not per attempt.
  if (resolvedTest) {
    const dep = await ensureDeps({ cwd: workspace.dir });
    await deps.appendLog?.({
      level: dep.ran && dep.exitCode !== 0 ? "warn" : "info",
      source: "followup",
      message: dep.ran
        ? `${dep.command} → exit ${dep.exitCode} in ${(dep.durationMs / 1000).toFixed(1)}s`
        : "No recognised lockfile/manifest; skipping dependency install.",
    });
  }

  const basePrompt = renderFollowupPrompt({
    alertTitle: alert?.title ?? "(unknown)",
    reviewer: instruction.author,
    instruction: stripSfbPrefix(instruction.body),
    testCommand: resolvedTest?.command ?? null,
  });

  // Retry loop. Shape mirrors wrapFixAgentStep — see its module-level
  // comment for why retries live in the wrapper rather than test-gate.
  let agentRes = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  let testPassed: boolean | null = null;
  let lastTestStdout = "";
  let lastTestStderr = "";
  let attempts = 0;

  const onLineCallback = deps.appendLog
    ? makeStreamRecorder(ctx, bindStreamToRunLogs, deps.appendLog, opts.runId, "followup-stream")
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const isRetry = attempt > 1;
    const attemptPrompt = isRetry
      ? buildRetryPrompt({
          basePrompt,
          testCommand: resolvedTest?.command ?? "",
          testStdoutTail: lastTestStdout.slice(-3000),
          testStderrTail: lastTestStderr.slice(-3000),
          attempt,
          maxAttempts,
        })
      : basePrompt;

    await deps.appendLog?.({
      level: "info",
      source: "followup",
      message: isRetry
        ? `Attempt ${attempt}/${maxAttempts}: re-spawning claude with failing-test context…`
        : `Attempt ${attempt}/${maxAttempts}: spawning claude with reviewer's instruction…`,
    });
    const spawnOpts: Parameters<SpawnAgentFn>[0] = {
      cwd: workspace.dir,
      prompt: attemptPrompt,
    };
    if (opts.mcpConfigPath) spawnOpts.mcpConfigPath = opts.mcpConfigPath;
    if (onLineCallback) spawnOpts.onLine = onLineCallback;
    agentRes = await spawnAgent(spawnOpts);
    await deps.appendLog?.({
      level: agentRes.exitCode === 0 ? "info" : "error",
      source: "followup",
      message: `claude exit ${agentRes.exitCode} (attempt ${attempt})`,
    });

    if (agentRes.exitCode !== 0) break;

    if (!resolvedTest) {
      testPassed = null;
      break;
    }

    const testRes = await runRepoTests({
      cwd: workspace.dir,
      testCommand: resolvedTest.command,
    });
    testPassed = testRes.passed;
    lastTestStdout = testRes.stdout;
    lastTestStderr = testRes.stderr;
    await deps.appendLog?.({
      level: testRes.passed ? "info" : "warn",
      source: "followup",
      message: testRes.passed
        ? `Tests passed on attempt ${attempt}.`
        : attempt < maxAttempts
          ? `Tests failed on attempt ${attempt}. Will retry.`
          : `Tests failed on attempt ${attempt} (final). Not pushing.`,
    });
    if (testRes.passed) break;
  }

  // Persist parsed envelope + transcript tail (matches primary path).
  const outcome = parseAgentOutput(agentRes.stdout);
  await ctx.write("agent_output", {
    summary: outcome.summary,
    problem: outcome.problem,
    hypotheses: outcome.hypotheses,
    fix: outcome.fix,
    confidence: outcome.confidence,
    risk: outcome.risk,
    severity: outcome.severity,
    exitCode: agentRes.exitCode,
    attempts,
  });
  if (agentRes.stdout) {
    await ctx.append("agent_transcript", agentRes.stdout);
  }

  // Side-channel for test-gate.
  opts.testRecorder.command = resolvedTest?.command ?? null;
  opts.testRecorder.passed = testPassed;
  opts.testRecorder.stdoutTail = lastTestStdout;
  opts.testRecorder.stderrTail = lastTestStderr;
  opts.testRecorder.attempts = attempts;
}

export function skipFollowupFixAgentIfFactory(handle: PrGuardHandle) {
  return async (_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> => {
    if (cfg.stopAfter === "budget") return true;
    if (handle.terminated) return true;
    return false;
  };
}

export function wrapFollowupFixAgentStep(opts: WrapFollowupFixAgentOpts): PipelineStep {
  return {
    name: "followup-fix-agent",
    description: "Spawn claude with reviewer's /alertforge instruction + retry loop",
    skipIf: skipFollowupFixAgentIfFactory(opts.prGuardHandle),
    async run(ctx, cfg, deps) {
      await runFollowupFixAgentStep(ctx, cfg, deps, opts);
    },
  };
}

// ---------- helpers ----------

/**
 * Strip the leading `/alertforge` or legacy `/sfb` so claude doesn't
 * see its own dispatch prefix. Recognises both prefixes during the
 * 2.0.x back-compat window; P9 drops the legacy arm.
 *
 * Exported as `stripSfbPrefix` for back-compat (callers across the
 * codebase use that name); new code should prefer the alias
 * `stripCommandPrefix` defined below.
 */
export function stripSfbPrefix(body: string): string {
  return body
    .trim()
    .replace(/^\/(?:sfb|alertforge)\s*/i, "")
    .trim();
}

/** Forward-looking name for stripSfbPrefix. */
export const stripCommandPrefix = stripSfbPrefix;

/**
 * Preserved verbatim from legacy `renderFollowupPrompt` in
 * pr-followup-job.ts. Same wording + ordering — the bot's prompt
 * surface is part of its contract with users.
 */
export function renderFollowupPrompt(input: {
  alertTitle: string;
  reviewer: string;
  instruction: string;
  testCommand: string | null;
}): string {
  // Do NOT ask claude to run the test suite. Its Bash tool has a ~2
  // min per-call timeout while real test suites take 4-10 min, so the
  // call gets SIGKILL'd (Exit 137) and wastes the agent budget. The
  // worker runs `${input.testCommand}` externally after claude exits
  // and uses the result as the push gate.
  const testStep = input.testCommand
    ? `- Do NOT run tests yourself. After you finish, the worker will run \`${input.testCommand}\` and refuse to push if it fails. Just write the change.`
    : "- No automated test command was detected in this repo; verify your change manually against the reviewer's intent.";
  return `/sentry-cli

You are a software engineer responding to a human reviewer's feedback
on a PR you previously opened. Your earlier review was found to have
issues; the reviewer (@${input.reviewer}) has left an instruction via
the \`/alertforge\` command. Apply that instruction faithfully.

ORIGINAL ALERT (for context): ${input.alertTitle}

REVIEWER INSTRUCTION:
${input.instruction || "(empty — apply your earlier review's suggestions exactly)"}

Constraints:
- Only change what the reviewer asked for. Do not rewrite unrelated code.
${testStep}
- Add or update tests if the instruction implies new behaviour.
- Do not commit secrets.
- Keep the diff small and focused.

When done, emit a one-line summary on stdout describing the diff so the
follow-up worker can include it in the PR reply.
`;
}

function buildRetryPrompt(input: {
  basePrompt: string;
  testCommand: string;
  testStdoutTail: string;
  testStderrTail: string;
  attempt: number;
  maxAttempts: number;
}): string {
  return `${input.basePrompt}

---

<previous-attempt>
Your previous attempt to apply the reviewer's instruction has been
written to the worktree, but \`${input.testCommand}\` is still
failing. This is attempt ${input.attempt}/${input.maxAttempts}; if you
cannot make the tests pass, the changes will NOT be pushed.

Diagnose from the output below and apply the smallest fix that turns
the suite green. Do not revert your earlier diff unless it was the
cause.

TEST STDOUT (tail):
${input.testStdoutTail || "(empty)"}

TEST STDERR (tail):
${input.testStderrTail || "(empty)"}
</previous-attempt>
`;
}

function makeStreamRecorder(
  ctx: CtxStore,
  binder: typeof BindStreamFn,
  appendLog: NonNullable<StepDeps["appendLog"]>,
  runId: string,
  source: string,
): (line: string) => Promise<void> {
  const adapter: AppendRunLog = async (input) => {
    await appendLog({ level: input.level, source: input.source, message: input.message });
    await ctx.append("agent_transcript", `${input.level} ${input.source} ${input.message}\n`);
  };
  return binder(adapter, runId, source);
}

// Default impls. Lazily required to keep this module loadable without
// the heavyweight step packages in the import graph during tests.

const resolveTestCommandReal: ResolveTestCommandFn = async (input) => {
  const { resolveTestCommand } = await import("@alertforge/step-test-gate");
  return resolveTestCommand(input);
};

const ensureDepsReal: EnsureDepsFn = async (input) => {
  const { ensureDeps } = await import("@alertforge/step-test-gate");
  return ensureDeps(input);
};

const runRepoTestsReal: RunRepoTestsFn = async (input) => {
  const { runRepoTests } = await import("@alertforge/step-test-gate");
  return runRepoTests(input);
};
