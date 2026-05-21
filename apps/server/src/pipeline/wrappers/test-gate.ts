/**
 * PipelineStep wrapper that confirms the final test_result.
 *
 * The retry-loop logic lives in @alertforge/step-fix-agent wrapper —
 * that wrapper invokes the test gate repeatedly until either the
 * suite passes or attempts are exhausted, and stamps the final
 * outcome into a `TestRecorder` side-channel passed via opts.
 *
 * This step:
 *   1. Reads back the side-channel state populated by fix-agent.
 *   2. Writes ctx.test_result with the canonical record { passed,
 *      command, stdoutTail, stderrTail, attempts } that open-pr +
 *      fan-out + the PR body consume.
 *
 * Skipped when cfg.stopAfter='budget' (triage_only) or when fix-agent
 * was itself skipped (no workspace → no test command resolved).
 *
 * Reads:  fix-agent's side-channel (opts.testRecorder)
 * Writes: ctx.test_result
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";
import type { TestRecorder } from "./fix-agent";

export interface TestResultCtxValue {
  passed: boolean | null;
  command: string | null;
  stdoutTail: string;
  stderrTail: string;
  attempts: number;
}

export interface WrapTestGateOpts {
  /** Side-channel filled in by the fix-agent wrapper. */
  testRecorder: TestRecorder;
}

export async function runTestGateStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapTestGateOpts,
): Promise<void> {
  const r = opts.testRecorder;
  const result: TestResultCtxValue = {
    passed: r.passed,
    command: r.command,
    stdoutTail: r.stdoutTail.slice(-4000),
    stderrTail: r.stderrTail.slice(-4000),
    attempts: r.attempts,
  };
  await ctx.write("test_result", result);
  await deps.appendLog?.({
    level: r.passed === false ? "warn" : "info",
    source: "tests",
    message:
      r.passed === true
        ? `Test gate: pass on attempt ${r.attempts}.`
        : r.passed === false
          ? `Test gate: FAIL after ${r.attempts} attempt(s). PR will open as draft.`
          : "Test gate: no test command — skipping hard gate.",
  });
}

export async function skipTestGateIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  return cfg.stopAfter === "budget";
}

export function wrapTestGateStep(opts: WrapTestGateOpts): PipelineStep {
  return {
    name: "test-gate",
    description: "Record final test-suite pass/fail outcome",
    skipIf: skipTestGateIf,
    async run(ctx, cfg, deps) {
      await runTestGateStep(ctx, cfg, deps, opts);
    },
  };
}
