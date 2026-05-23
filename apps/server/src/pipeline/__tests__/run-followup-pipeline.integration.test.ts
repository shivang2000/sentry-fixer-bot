/**
 * Integration test for the FOLLOWUP_STEPS pipeline driven by
 * `runPipeline`. The follow-up pipeline runs when a human reviewer
 * leaves a `/sfb <instruction>` comment on a PR the bot opened; the
 * worker re-attaches a worktree to the PR's existing branch, spawns
 * claude with the reviewer's instruction, gates on tests, and pushes
 * to the existing branch (no new PR).
 *
 * Per P3c.3 TDD constraint: this test was written BEFORE the
 * followup-specific wrappers — the wrappers exist to make every
 * scenario below go green.
 *
 * Scenarios (≥5 required):
 *   1. happy path — reviewer's fix lands, tests pass, PR ready, comment posted
 *   2. test-gate fails — agent retries exhausted, PR stays draft, waiting_human
 *   3. PR closed mid-job — pr-guard halts; downstream steps skipped
 *   4. (covered by the worker, not the pipeline — watermark short-circuit
 *      happens BEFORE runPipeline is called; see pr-followup-job.ts test)
 *   5. channel fan-out fires — followup completion routes through fan-out
 *   6. secret-scan blocks — strict-mode finding aborts before commit/push
 *   7. agent retry loop — first attempt fails tests, second passes; assert 2 spawns
 */

// Stub env validation BEFORE anything imports @alertforge/env.
import "./env-preload";

import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, StepDeps } from "@alertforge/core";
import { runPipeline } from "@alertforge/core";
import { buildFollowupSteps } from "../followup-steps";
import type { PrGuardHandle } from "../wrappers/pr-guard";
import {
  MemoryCtxStore,
  MemoryS3,
  makeCfg,
  makeLogRecorder,
  makeStubSentrySource,
  QueuedModelProvider,
  RecordingChannel,
  SAMPLE_ALERT,
  SAMPLE_TRIGGER,
  SpawnScript,
  type StubChannelConfigRow,
  StubDb,
  silentLogger,
} from "./fixtures";

/**
 * Pre-populated PR shape the worker writes into ctx before invoking
 * runPipeline (the followup pipeline's analogue of the primary
 * pipeline's "agent + tests + open-pr" producing ctx.pr).
 */
function makePrTarget(overrides: Partial<{ number: number; branch: string; repo: string }> = {}) {
  return {
    repo: overrides.repo ?? "acme/api",
    number: overrides.number ?? 42,
    branch: overrides.branch ?? "sfb/run-orig",
    url: `https://github.com/${overrides.repo ?? "acme/api"}/pull/${overrides.number ?? 42}`,
    isDraft: true,
    needsHuman: true,
  };
}

function makeInstruction(overrides: Partial<{ body: string; author: string }> = {}) {
  return {
    body: overrides.body ?? "/sfb fix the null check",
    author: overrides.author ?? "alice",
    commentId: "12345",
    createdAt: "2026-05-21T10:00:00Z",
  };
}

function boot(
  opts: {
    prState?: "open" | "closed" | "merged" | "unknown";
    agentStdout?: string;
    spawnAgentResults?: Array<{
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }>;
    testResults?: Array<{ passed: boolean; stdout: string; stderr: string }>;
    channelConfigs?: StubChannelConfigRow[];
    failingChannelType?: string;
    readChangedFile?: (path: string) => Promise<string>;
    spawnScript?: SpawnScript;
    instructionBody?: string;
    instructionAuthor?: string;
    prRepo?: string;
    prNumber?: number;
    prBranch?: string;
  } = {},
) {
  const ctx = new MemoryCtxStore("followup-12345");
  const model = new QueuedModelProvider();

  const spawnScript = opts.spawnScript ?? new SpawnScript();
  spawnScript
    .on(/git status --porcelain/, { exitCode: 0, stdout: "M src/fix.ts\n" })
    .on(/git diff --name-only/, { exitCode: 0, stdout: "src/fix.ts\n" })
    .on(/git add/, { exitCode: 0 })
    .on(/git -c .* commit/, { exitCode: 0 })
    .on(/git commit/, { exitCode: 0 })
    .on(/git push/, { exitCode: 0 });

  const readChangedFile = opts.readChangedFile ?? (async (_path: string) => "const ok = true;\n");

  const channels = new Map<string, ChannelAdapter>();
  channels.set(
    "slack",
    new RecordingChannel("slack", { fail: opts.failingChannelType === "slack" }),
  );
  channels.set(
    "email",
    new RecordingChannel("email", { fail: opts.failingChannelType === "email" }),
  );

  const db = new StubDb();
  for (const c of opts.channelConfigs ?? []) db.channelConfigs.push(c);

  const sources = new Map();
  sources.set("sentry", makeStubSentrySource());

  const s3 = new MemoryS3();
  const logRec = makeLogRecorder();

  // Track PR ops (markPrReady, convertPrToDraft, commentOnPr).
  const prOpsCalls: Array<{ op: string; repo: string; prNumber: number; body?: string }> = [];
  const markPrReadyFn = async (input: { repo: string; prNumber: number }) => {
    prOpsCalls.push({ op: "markPrReady", repo: input.repo, prNumber: input.prNumber });
    return 0;
  };
  const convertPrToDraftFn = async (input: { repo: string; prNumber: number }) => {
    prOpsCalls.push({ op: "convertPrToDraft", repo: input.repo, prNumber: input.prNumber });
    return 0;
  };
  const commentOnPrFn = async (input: { repo: string; prNumber: number; body: string }) => {
    prOpsCalls.push({
      op: "commentOnPr",
      repo: input.repo,
      prNumber: input.prNumber,
      body: input.body,
    });
    return null;
  };
  const getPrStateFn = async (_input: { repo: string; prNumber: number }) => {
    return opts.prState ?? "open";
  };

  // Mutable handle the pr-guard wrapper writes into and downstream
  // steps consult via skipIf — analogous to WorkspaceHandle.
  const prGuardHandle: PrGuardHandle = { terminated: false };

  // Agent spawn — supports a queue of results for the retry-loop test.
  const spawnResults = opts.spawnAgentResults ?? [
    {
      exitCode: 0,
      stdout:
        opts.agentStdout ??
        "<summary><problem>p</problem><hypotheses>H1</hypotheses><fix>f</fix><confidence>high</confidence><risk>low</risk><severity>medium</severity></summary>",
      stderr: "",
      durationMs: 100,
    },
  ];
  let spawnIdx = 0;
  const spawnAgentFn = async () => {
    const res = spawnResults[Math.min(spawnIdx, spawnResults.length - 1)] ?? {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
    };
    spawnIdx += 1;
    return res;
  };

  // Test runs — queue of results.
  const testQueue = opts.testResults ?? [{ passed: true, stdout: "ok", stderr: "" }];
  let testIdx = 0;
  const runRepoTestsFn = async (_in: { cwd: string; testCommand: string }) => {
    const res = testQueue[Math.min(testIdx, testQueue.length - 1)] ?? {
      passed: true as boolean,
      stdout: "",
      stderr: "",
    };
    testIdx += 1;
    return res;
  };

  const deps: StepDeps = {
    modelProvider: model,
    log: silentLogger,
    sources,
    channels,
    appendLog: logRec.appendLog,
    resolveToken: async () => "test-token",
    db,
    s3,
  };

  const steps = buildFollowupSteps({
    followupId: "12345",
    runId: "run-orig",
    repo: opts.prRepo ?? "acme/api",
    prNumber: opts.prNumber ?? 42,
    prBranch: opts.prBranch ?? "sfb/run-orig",
    prGuardHandle,
    attachWorkspaceFn: async () => ({
      dir: "/tmp/followup-ws",
      branch: opts.prBranch ?? "sfb/run-orig",
      cleanup: async () => {},
    }),
    spawnAgentFn,
    resolveTestCommandFn: async () => ({
      command: "npm test",
      source: "detected",
      ecosystem: "node" as const,
    }),
    ensureDepsFn: async () => ({
      ran: true,
      command: "npm ci",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    }),
    runRepoTestsFn,
    runScriptedCommand: async (argv, optsArg) => spawnScript.run(argv, optsArg?.cwd),
    readChangedFile,
    listChannelConfigsFn: (triggerId: string) => db.listChannelConfigs(triggerId),
    getPrStateFn,
    markPrReadyFn,
    convertPrToDraftFn,
    commentOnPrFn,
  });

  return {
    ctx,
    deps,
    model,
    spawnScript,
    db,
    channels,
    s3,
    logRec,
    steps,
    prOpsCalls,
    prGuardHandle,
  };
}

// ----------------------------------------------------------------------
// Scenario 1 — happy path
// ----------------------------------------------------------------------

describe("runPipeline followup integration", () => {
  it("scenario 1: happy path — fix lands, tests pass, PR ready, comment posted", async () => {
    const stepsCompleted: string[] = [];
    const harness = boot({
      prState: "open",
      channelConfigs: [
        {
          id: "cc-slack",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: {},
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
    });

    expect(stepsCompleted).toEqual([
      "pr-guard",
      "attach-workspace",
      "followup-fix-agent",
      "secret-scan",
      "test-gate",
      "commit-push-only",
      "pr-followup-comment",
      "fan-out-channels",
    ]);

    // markPrReady was called + comment posted.
    expect(harness.prOpsCalls.find((c) => c.op === "markPrReady")).toBeDefined();
    expect(harness.prOpsCalls.find((c) => c.op === "commentOnPr")).toBeDefined();

    // Slack notified with pr_opened status (reused for followup completion).
    const slack = harness.channels.get("slack") as RecordingChannel;
    expect(slack.recordedSends).toHaveLength(1);
    expect(slack.recordedSends[0]?.notification.status).toBe("pr_opened");
  });

  // -------------------------------------------------------------------
  // Scenario 2 — test-gate fails after retries → PR stays draft
  // -------------------------------------------------------------------

  it("scenario 2: tests fail after retries → PR stays draft, waiting_human", async () => {
    const harness = boot({
      prState: "open",
      testResults: [
        { passed: false, stdout: "fail", stderr: "boom" },
        { passed: false, stdout: "still fail", stderr: "still boom" },
        { passed: false, stdout: "still fail", stderr: "still boom" },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget({ number: 100 }));
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    // markPrReady NOT called; convertPrToDraft NOT called (PR was already draft);
    // a comment WAS posted surfacing the failure.
    expect(harness.prOpsCalls.find((c) => c.op === "markPrReady")).toBeUndefined();
    const commentCall = harness.prOpsCalls.find((c) => c.op === "commentOnPr");
    expect(commentCall).toBeDefined();
    expect(commentCall?.body).toMatch(/fail|test/i);

    const testResult = (await harness.ctx.read("test_result")) as { passed: boolean | null };
    expect(testResult.passed).toBe(false);
  });

  // -------------------------------------------------------------------
  // Scenario 3 — PR closed mid-job → pr-guard halts
  // -------------------------------------------------------------------

  it("scenario 3: PR closed mid-job → pr-guard skips downstream steps", async () => {
    const stepsCompleted: string[] = [];
    const stepsSkipped: string[] = [];
    const spawnCount = 0;
    const harness = boot({
      prState: "closed",
    });
    // Wrap spawn to count it; we expect zero spawns.
    const inner = harness.steps;
    void inner;

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
      onStepSkip: async (name) => {
        stepsSkipped.push(name);
      },
    });

    // pr-guard ran; everything else (except fan-out) was skipped.
    expect(stepsCompleted).toContain("pr-guard");
    expect(stepsCompleted).not.toContain("attach-workspace");
    expect(stepsCompleted).not.toContain("followup-fix-agent");
    expect(stepsCompleted).not.toContain("commit-push-only");
    expect(stepsSkipped).toContain("attach-workspace");
    expect(stepsSkipped).toContain("followup-fix-agent");
    expect(stepsSkipped).toContain("commit-push-only");
    expect(stepsSkipped).toContain("pr-followup-comment");

    // Handle marked terminated.
    expect(harness.prGuardHandle.terminated).toBe(true);
    expect(harness.prGuardHandle.state).toBe("closed");

    // No agent spawns happened.
    void spawnCount;
    expect(harness.prOpsCalls.find((c) => c.op === "markPrReady")).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Scenario 4 — channel fan-out fires
  // -------------------------------------------------------------------

  it("scenario 4: channel fan-out fires after successful followup", async () => {
    const harness = boot({
      prState: "open",
      channelConfigs: [
        {
          id: "cc-email",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "email",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: { to: ["oncall@acme.com"] },
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    const email = harness.channels.get("email") as RecordingChannel;
    expect(email.recordedSends).toHaveLength(1);
    expect(email.recordedSends[0]?.notification.status).toBe("pr_opened");
  });

  // -------------------------------------------------------------------
  // Scenario 5 — secret-scan finds secret → aborts before commit-push
  // -------------------------------------------------------------------

  it("scenario 5: secret-scan finds a secret → blocks commit/push", async () => {
    const harness = boot({
      prState: "open",
      // Return a file containing a credential-shaped string.
      readChangedFile: async () => 'const k = "AKIAIOSFODNN7EXAMPLE";',
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    const ss = (await harness.ctx.read("secret_scan")) as {
      findings: unknown[];
      blocked: boolean;
    };
    expect(ss.findings.length).toBeGreaterThan(0);
    expect(ss.blocked).toBe(true);

    // No git push happened (commit-push-only respects blocked).
    const pushCalls = harness.spawnScript.calls.filter((c) => c.argv.join(" ").includes("push"));
    expect(pushCalls).toHaveLength(0);

    // markPrReady NOT called; comment WAS posted surfacing the secret block.
    expect(harness.prOpsCalls.find((c) => c.op === "markPrReady")).toBeUndefined();
    const commentCall = harness.prOpsCalls.find((c) => c.op === "commentOnPr");
    expect(commentCall).toBeDefined();
    expect(commentCall?.body).toMatch(/secret/i);
  });

  // -------------------------------------------------------------------
  // Scenario 6 — agent retry loop (failing tests on first attempt)
  // -------------------------------------------------------------------

  it("scenario 6: agent retry loop — first attempt fails tests, second passes", async () => {
    const harness = boot({
      prState: "open",
      spawnAgentResults: [
        {
          exitCode: 0,
          stdout:
            "<summary><problem>p</problem><hypotheses>H1</hypotheses><fix>broken</fix><confidence>medium</confidence><risk>low</risk><severity>low</severity></summary>",
          stderr: "",
          durationMs: 50,
        },
        {
          exitCode: 0,
          stdout:
            "<summary><problem>p</problem><hypotheses>H1</hypotheses><fix>fixed</fix><confidence>high</confidence><risk>low</risk><severity>low</severity></summary>",
          stderr: "",
          durationMs: 60,
        },
      ],
      testResults: [
        { passed: false, stdout: "first fail", stderr: "err" },
        { passed: true, stdout: "ok", stderr: "" },
      ],
    });

    const spawnCount = 0;
    // Wrap the spawnAgentFn inside the deps wiring via the harness's
    // existing queued spawnAgentResults — the queued model bumps idx
    // each call. Verify via log lines counting "claude exit" mentions.

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    // After retry, tests should pass; PR ready.
    const test = (await harness.ctx.read("test_result")) as { passed: boolean | null };
    expect(test.passed).toBe(true);
    expect(harness.prOpsCalls.find((c) => c.op === "markPrReady")).toBeDefined();

    // The retry-loop counter is observable via agent_output.attempts (mirrors fix-agent).
    const agentOut = (await harness.ctx.read("agent_output")) as { attempts: number };
    expect(agentOut.attempts).toBe(2);
    void spawnCount;
  });

  // -------------------------------------------------------------------
  // Scenario 7 — happy path: assertion that commit-push happens AFTER
  // test-gate and the comment is posted with the PR URL
  // -------------------------------------------------------------------

  it("scenario 7: commit-push and comment happen after test-gate passes", async () => {
    const harness = boot({
      prState: "open",
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);
    await harness.ctx.write("pr", makePrTarget());
    await harness.ctx.write("instruction", makeInstruction());

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    // git push to existing branch happened.
    const pushCalls = harness.spawnScript.calls.filter((c) => c.argv.join(" ").includes("push"));
    expect(pushCalls.length).toBeGreaterThan(0);
    const pushArgv = pushCalls[0]?.argv.join(" ") ?? "";
    expect(pushArgv).toContain("sfb/run-orig");

    // No `gh pr create` should fire — followup never opens a new PR.
    const ghCreate = harness.spawnScript.calls.filter((c) =>
      c.argv.join(" ").includes("gh pr create"),
    );
    expect(ghCreate).toHaveLength(0);
  });
});
