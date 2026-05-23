/**
 * PipelineStep wrapper around @alertforge/step-fix-agent.
 *
 * The fix-agent step:
 *   1. Resolves the test command up-front (so the prompt can mention it).
 *   2. Ensures project deps are installed (legacy parity).
 *   3. Spawns the claude agent (or the injected mock).
 *   4. Runs the self-heal retry loop (up to MAX_AGENT_ATTEMPTS): if the
 *      tests fail, re-spawn with the failure tail appended.
 *   5. Writes ctx.agent_transcript (raw stream) + ctx.agent_output
 *      (parsed envelope) + an intermediate `last_test` ctx field on
 *      workspace for test-gate to confirm.
 *
 * The retry loop intentionally lives here, not in test-gate, because
 * the retry needs the original prompt context (which fix-agent owns)
 * and the workspace dir + claude config (which the wrapper threads
 * through). test-gate is the explicit final confirmation step that
 * records what the last test attempt produced into ctx.test_result.
 *
 * Reads:  ctx.alert, ctx.event_detail, ctx.triage, ctx.workspace,
 *         ctx.trigger (models)
 * Writes: ctx.agent_transcript, ctx.agent_output
 *         Plus a side-channel handoff for test-gate (via opts.testRecorder).
 */

import type {
  CtxStore,
  EnrichedAlert,
  NormalizedAlert,
  PipelineStep,
  ResolvedConfig,
  StepDeps,
} from "@alertforge/core";
import type { TriageResult } from "@alertforge/step-classify";
import type { AppendRunLog, bindStreamToRunLogs as BindStreamFn } from "@alertforge/step-fix-agent";
// Lazy default impls — declared in module scope but resolved on first
// call. @alertforge/step-fix-agent/index re-exports `spawn.ts` which
// pulls @alertforge/env/server and validates DB / Sentry env at
// module load; importing it eagerly here would break env-less unit
// tests. Tests inject their own spawnAgentFn so the lazy resolver
// never runs.
import {
  bindStreamToRunLogs,
  parseAgentOutput,
  renderAgentPrompt,
  spawnClaudeAgent,
} from "@alertforge/step-fix-agent";
import type { WorkspaceCtxValue } from "./workspace";

export type AgentOutput = ReturnType<typeof parseAgentOutput>;

export type SpawnAgentFn = (input: {
  cwd: string;
  prompt: string;
  mcpConfigPath?: string;
  onLine?: (line: string) => Promise<void> | void;
}) => Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;

export type ResolveTestCommandFn = (input: {
  cwd: string;
  override: string | null | undefined;
}) => Promise<{
  command: string;
  source: "override" | "detected";
  ecosystem?: string;
} | null>;

export type EnsureDepsFn = (input: { cwd: string }) => Promise<{
  ran: boolean;
  command: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}>;

export type RunRepoTestsFn = (input: { cwd: string; testCommand: string }) => Promise<{
  passed: boolean;
  stdout: string;
  stderr: string;
}>;

/**
 * Mutable side-channel that fix-agent writes the last test attempt
 * result into, and test-gate reads back. Kept off ctx because it's an
 * implementation detail of the retry loop (the spec's test_result ctx
 * field records the FINAL outcome; intermediate attempts are not
 * persisted there).
 */
export interface TestRecorder {
  command: string | null;
  passed: boolean | null;
  stdoutTail: string;
  stderrTail: string;
  attempts: number;
}

export interface WrapFixAgentOpts {
  /** Override for tests; production uses the real legacy fn. */
  spawnAgentFn?: SpawnAgentFn;
  resolveTestCommandFn?: ResolveTestCommandFn;
  ensureDepsFn?: EnsureDepsFn;
  runRepoTestsFn?: RunRepoTestsFn;
  /** Side-channel for test-gate to read the final test attempt result. */
  testRecorder?: TestRecorder;
  /** Test command override from repos_config; legacy parity. */
  testCommandOverride?: string | null;
  /** Pre-rendered claude home + mcp config. None in tests. */
  mcpConfigPath?: string;
  /** runId for log routing. */
  runId: string;
  /** Max retry attempts. Legacy value: 3. */
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function runFixAgentStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapFixAgentOpts,
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) {
    throw new Error("fix-agent: ctx.workspace missing — workspace step must run first");
  }
  const alert = await ctx.read<NormalizedAlert>("alert");
  const detail = await ctx.read<EnrichedAlert>("event_detail");
  const triage = await ctx.read<TriageResult>("triage");
  if (!alert) throw new Error("fix-agent: ctx.alert missing");

  const resolveTest = opts.resolveTestCommandFn ?? resolveTestCommandReal;
  const ensureDeps = opts.ensureDepsFn ?? ensureDepsReal;
  const runRepoTests = opts.runRepoTestsFn ?? runRepoTestsReal;
  const spawnAgent = opts.spawnAgentFn ?? spawnClaudeAgent;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  // Resolve test command up-front so the prompt mentions it.
  const resolvedTest = await resolveTest({
    cwd: workspace.dir,
    override: opts.testCommandOverride ?? null,
  });
  await deps.appendLog?.({
    level: "info",
    source: "tests",
    message: resolvedTest
      ? `Test command (${resolvedTest.source}): ${resolvedTest.command}`
      : "No test command found. Skipping test gate.",
  });

  // Install deps for the worktree before the agent runs (legacy parity).
  if (resolvedTest) {
    await deps.appendLog?.({
      level: "info",
      source: "deps",
      message: "Detecting + installing project dependencies for test gate…",
    });
    const dep = await ensureDeps({ cwd: workspace.dir });
    if (dep.ran) {
      await deps.appendLog?.({
        level: dep.exitCode === 0 ? "info" : "warn",
        source: "deps",
        message: `${dep.command} → exit ${dep.exitCode} in ${(dep.durationMs / 1000).toFixed(1)}s`,
      });
    }
  }

  const prompt = renderAgentPrompt({
    title: alert.title,
    stackTrace: detail?.stackTrace ?? "",
    suspectedFiles: triage?.suspectedFiles ?? [],
    testCommand: resolvedTest?.command ?? null,
    sentryIssueId: alert.externalId,
    sentryProject: alert.sourceProject,
    sentryLevel: alert.level,
  });

  // Retry loop. Bounded by maxAttempts so a genuinely-hard fix doesn't
  // chew the whole token budget. Captures the final agent result +
  // last test result for test-gate to confirm later.
  let agentRes = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  let testPassed: boolean | null = null;
  let lastTestStdout = "";
  let lastTestStderr = "";
  let attempts = 0;

  const onLineCallback = deps.appendLog
    ? makeStreamRecorder(ctx, bindStreamToRunLogs, deps.appendLog, opts.runId, "agent-stream")
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    const isRetry = attempt > 1;
    const attemptPrompt = isRetry
      ? buildRetryPrompt({
          originalPrompt: prompt,
          testCommand: resolvedTest?.command ?? "",
          testStdoutTail: lastTestStdout.slice(-3000),
          testStderrTail: lastTestStderr.slice(-3000),
          attempt,
          maxAttempts,
        })
      : prompt;

    await deps.appendLog?.({
      level: "info",
      source: "agent",
      message: isRetry
        ? `Retry attempt ${attempt}/${maxAttempts}: re-spawning claude with failing-test context…`
        : `Spawning claude in ${workspace.dir}…`,
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
      source: "agent",
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
      source: "tests",
      message: testRes.passed
        ? `Tests passed on attempt ${attempt}.`
        : attempt < maxAttempts
          ? `Tests failed on attempt ${attempt}. Will retry.`
          : `Tests failed on attempt ${attempt} (final).`,
    });
    if (testRes.passed) break;
  }

  // Persist the parsed envelope + transcript tail. Transcript is
  // already streamed via onLineCallback; we additionally snapshot the
  // final stdout into ctx.agent_transcript so a re-run forensic
  // analysis has the complete batch.
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
  // agent_transcript is a log-format field; write final raw stdout.
  if (agentRes.stdout) {
    await ctx.append("agent_transcript", agentRes.stdout);
  }

  // Side-channel for test-gate.
  if (opts.testRecorder) {
    opts.testRecorder.command = resolvedTest?.command ?? null;
    opts.testRecorder.passed = testPassed;
    opts.testRecorder.stdoutTail = lastTestStdout;
    opts.testRecorder.stderrTail = lastTestStderr;
    opts.testRecorder.attempts = attempts;
  }
}

export async function skipFixAgentIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  return cfg.stopAfter === "budget";
}

export function wrapFixAgentStep(opts: WrapFixAgentOpts): PipelineStep {
  return {
    name: "fix-agent",
    description: "Spawn claude agent with self-heal retry loop",
    skipIf: skipFixAgentIf,
    async run(ctx, cfg, deps) {
      await runFixAgentStep(ctx, cfg, deps, opts);
    },
  };
}

// ---------- helpers ----------

function buildRetryPrompt(input: {
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
unless it was clearly the cause — prefer fixing forward.

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
    // Also mirror into ctx.agent_transcript so the on-disk store keeps
    // the full timeline. Each line is small; cap is enforced by the
    // CtxStore.
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
