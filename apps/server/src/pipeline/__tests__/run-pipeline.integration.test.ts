/**
 * Integration test for the full DEFAULT_STEPS pipeline driven by
 * `runPipeline`. Wraps every legacy step function behind a PipelineStep
 * adapter and verifies end-to-end behavior against the 7 spec scenarios
 * in docs/alertforge/plans/2026-05-21-phase-3c-worker-flip.md §"TDD plan".
 *
 * The test is hermetic:
 *   - in-memory CtxStore (apps/.../fixtures MemoryCtxStore)
 *   - queued model provider (QueuedModelProvider) returns canned LLM responses
 *   - SpawnScript routes all git/gh/test/agent commands to canned stdout/exit
 *   - StubDb captures channel_configs + prs writes
 *   - RecordingChannel adapter captures each send (+ optionally throws)
 *   - MemoryS3 captures puts
 *
 * Per spec D2: this test was written BEFORE the wrappers — the wrappers
 * exist to make every scenario below go green.
 */

// Stub the env validation BEFORE anything imports @alertforge/env.
// The fix-agent wrapper transitively pulls env/server at module load; this
// preload ensures the validation passes when `bun test` runs from the repo
// root (where apps/server/.env isn't auto-loaded by dotenv).
import "./env-preload";

import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, StepDeps } from "@alertforge/core";
import { runPipeline } from "@alertforge/core";
import { buildDefaultSteps } from "../default-steps";
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
 * Boot a fully-stubbed pipeline harness. Each scenario calls `boot()`
 * with overrides to script different command exit codes / model responses
 * / channel configs.
 */
function boot(
  opts: {
    modelResponses?: Array<{ model: string; response: string }>;
    spawnScript?: SpawnScript;
    channelConfigs?: StubChannelConfigRow[];
    failingChannelType?: string;
    diff?: string;
    ghPrUrl?: string;
    agentStdout?: string;
  } = {},
) {
  const ctx = new MemoryCtxStore("run-integration-1");
  const model = new QueuedModelProvider();
  for (const r of opts.modelResponses ?? []) model.enqueue(r.model, r.response);
  const spawnScript = opts.spawnScript ?? new SpawnScript();
  // Default canned commands. Tests can override by passing their own
  // SpawnScript with .on() rules registered before the defaults match.
  spawnScript
    .on(["git", "diff", "--name-only"], { exitCode: 0, stdout: "src/fix.ts\n" })
    .on(/git diff origin\//, {
      exitCode: 0,
      stdout: opts.diff ?? "diff --git a/src/fix.ts b/src/fix.ts\n+const x=1;",
    })
    .on(/git status --porcelain/, { exitCode: 0, stdout: "M src/fix.ts\n" })
    .on(/git add -A/, { exitCode: 0 })
    .on(/git -c .* commit/, { exitCode: 0 })
    .on(/git push/, { exitCode: 0 })
    .on(/gh pr create/, {
      exitCode: 0,
      stdout: opts.ghPrUrl ?? "https://github.com/acme/api/pull/42\n",
    })
    .on(/gh pr comment/, { exitCode: 0 })
    .on(/gh pr ready/, { exitCode: 0 });

  // Default file reader used by secret-scan: empty (no secrets).
  const readChangedFile = async (_path: string): Promise<string> => {
    return "const ok = true;\n";
  };

  // Channels registry.
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

  // Pipeline steps with all spawn / agent / step-package functions
  // overridden to consult the SpawnScript instead of shelling out.
  const steps = buildDefaultSteps({
    runId: ctx.runId,
    repo: "acme/api",
    baseBranch: "main",
    createWorkspaceFn: async () => ({
      dir: "/tmp/ws",
      branch: "sfb/run-integration-1",
      cleanup: async () => {},
    }),
    spawnAgentFn: async () => ({
      exitCode: 0,
      stdout:
        opts.agentStdout ??
        "<summary><problem>p</problem><hypotheses>H1: x — CHOSEN because y</hypotheses><fix>changed cart.ts</fix><confidence>high</confidence><risk>low</risk><severity>medium</severity></summary>",
      stderr: "",
      durationMs: 1000,
    }),
    runScriptedCommand: async (argv, opts) => spawnScript.run(argv, opts?.cwd),
    readChangedFile,
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
    runRepoTestsFn: async ({ testCommand }) => ({
      passed: !testCommand.includes("FAIL"),
      stdout: "ok",
      stderr: "",
    }),
    openPrFn: async () => ({
      number: 42,
      url: opts.ghPrUrl ?? "https://github.com/acme/api/pull/42",
    }),
    runReviewerFn: async () => ({
      verdict: "nit",
      body: "<review><verdict>nit</verdict><summary>fine</summary></review>",
      exitCode: 0,
      durationMs: 50,
    }),
    checkBudgetFn: async () => ({ allowed: true as const }),
    recordUsageFn: async () => {},
    capturePrComment: async () => {},
    listChannelConfigsFn: (triggerId: string) => db.listChannelConfigs(triggerId),
  });

  return { ctx, deps, model, spawnScript, db, channels, s3, logRec, steps };
}

// ----------------------------------------------------------------------
// Scenario 1 — happy path, auto_fix preset
// ----------------------------------------------------------------------

describe("runPipeline integration", () => {
  it("scenario 1: happy path, auto_fix preset", async () => {
    const stepsCompleted: string[] = [];
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"Null deref","suspectedFiles":["src/cart.ts"]}',
        },
      ],
      channelConfigs: [
        {
          id: "cc-1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["pr_opened", "failed"],
          config: { webhookUrl: "https://hooks.slack.com/services/T/B/X" },
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
    });

    // Every step in the auto_fix pipeline ran in order. review-pr +
    // follow-up are skipped (toggles off in default auto_fix cfg).
    expect(stepsCompleted).toEqual([
      "classify",
      "fetch-event",
      "budget",
      "workspace",
      "fix-agent",
      "secret-scan",
      "test-gate",
      "commit-push",
      "open-pr",
      "fan-out-channels",
    ]);

    expect(await harness.ctx.read("triage")).toMatchObject({ severity: "high" });
    expect(await harness.ctx.read("pr")).toMatchObject({ number: 42 });
    expect(await harness.ctx.read("notifications")).toBeDefined();

    // Slack channel got a `pr_opened` notification.
    const slack = harness.channels.get("slack") as RecordingChannel;
    expect(slack.recordedSends).toHaveLength(1);
    expect(slack.recordedSends[0]?.notification.status).toBe("pr_opened");
  });

  // -------------------------------------------------------------------
  // Scenario 2 — triage_only preset
  // -------------------------------------------------------------------

  it("scenario 2: triage_only preset short-circuits to fan-out after budget", async () => {
    const stepsCompleted: string[] = [];
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"low","summary":"minor","suspectedFiles":[]}',
        },
      ],
      channelConfigs: [
        {
          id: "cc-1",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "email",
          enabled: true,
          notifyOn: ["triage_only"],
          config: { to: ["oncall@acme.com"], notifyOnSeverityAtLeast: "low" },
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);

    const cfg = makeCfg({ stopAfter: "budget" });
    await runPipeline(harness.ctx, cfg, harness.steps, harness.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
    });

    expect(stepsCompleted).toEqual(["classify", "fetch-event", "budget", "fan-out-channels"]);
    expect(await harness.ctx.exists("workspace")).toBe(false);
    expect(await harness.ctx.exists("agent_output")).toBe(false);

    // The fan-out fired with a triage_only-status notification.
    const email = harness.channels.get("email") as RecordingChannel;
    expect(email.recordedSends).toHaveLength(1);
    expect(email.recordedSends[0]?.notification.status).toBe("triage_only");
  });

  // -------------------------------------------------------------------
  // Scenario 3 — auto_fix_review preset
  // -------------------------------------------------------------------

  it("scenario 3: auto_fix_review preset runs review-pr", async () => {
    const stepsCompleted: string[] = [];
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"x","suspectedFiles":[]}',
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);

    const cfg = makeCfg({
      toggles: { autoReview: true, followUpLoop: false, secretScanStrict: "block" },
    });
    await runPipeline(harness.ctx, cfg, harness.steps, harness.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
    });

    expect(stepsCompleted).toContain("review-pr");
    expect(await harness.ctx.exists("review")).toBe(true);
    const review = (await harness.ctx.read("review")) as { verdict: string };
    expect(review.verdict).toBe("nit");
  });

  // -------------------------------------------------------------------
  // Scenario 4 — budget exhausted
  // -------------------------------------------------------------------

  it("scenario 4: budget exhausted halts before workspace", async () => {
    const stepsCompleted: string[] = [];
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"medium","summary":"","suspectedFiles":[]}',
        },
      ],
    });

    // Override checkBudget to deny.
    const stepsDenied = harness.steps;
    const cfg = makeCfg();
    // Re-build with denied budget.
    const denied = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"medium","summary":"","suspectedFiles":[]}',
        },
      ],
    });
    denied.steps[2] = {
      name: "budget",
      description: "budget (denied)",
      async run(ctx, _c) {
        await ctx.write("budget", { allowed: false, reason: "tokens_exceeded" });
        // Set stopAfter to short-circuit
        (_c as { stopAfter?: string }).stopAfter = "budget";
      },
    };
    void stepsDenied; // keep the lint happy
    await denied.ctx.write("trigger", SAMPLE_TRIGGER);
    await denied.ctx.write("alert", SAMPLE_ALERT);

    await runPipeline(denied.ctx, cfg, denied.steps, denied.deps, {
      onStepEnd: async (name) => {
        stepsCompleted.push(name);
      },
    });

    expect(stepsCompleted).toEqual(["classify", "fetch-event", "budget", "fan-out-channels"]);
    expect(await denied.ctx.exists("workspace")).toBe(false);
    const budget = (await denied.ctx.read("budget")) as { allowed: boolean };
    expect(budget.allowed).toBe(false);
  });

  // -------------------------------------------------------------------
  // Scenario 5 — test-gate fails (PR opens as draft)
  // -------------------------------------------------------------------

  it("scenario 5: test-gate failure still opens PR as draft", async () => {
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"x","suspectedFiles":[]}',
        },
      ],
    });
    // Override runRepoTestsFn to fail. We rebuild steps with the FAIL marker
    // so runRepoTests returns passed=false.
    const failingHarness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"x","suspectedFiles":[]}',
        },
      ],
    });
    // Replace the test-gate step in-place so it writes passed=false.
    const idx = failingHarness.steps.findIndex((s) => s.name === "test-gate");
    failingHarness.steps[idx] = {
      name: "test-gate",
      description: "test-gate (failing)",
      async run(ctx) {
        await ctx.write("test_result", { passed: false, stdoutTail: "fail", stderrTail: "" });
      },
    };

    await failingHarness.ctx.write("trigger", SAMPLE_TRIGGER);
    await failingHarness.ctx.write("alert", SAMPLE_ALERT);

    await runPipeline(failingHarness.ctx, makeCfg(), failingHarness.steps, failingHarness.deps);

    const pr = (await failingHarness.ctx.read("pr")) as { number: number; isDraft: boolean };
    expect(pr).toBeDefined();
    expect(pr.isDraft).toBe(true);
    void harness;
  });

  // -------------------------------------------------------------------
  // Scenario 6 — secret-scan finds a secret (strict mode aborts before PR)
  // -------------------------------------------------------------------

  it("scenario 6: secret-scan strict mode finds a secret and blocks open-pr", async () => {
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"x","suspectedFiles":[]}',
        },
      ],
    });
    // Replace secret-scan to write a finding with strict=block.
    const idx = harness.steps.findIndex((s) => s.name === "secret-scan");
    harness.steps[idx] = {
      name: "secret-scan",
      description: "secret-scan (finds secret)",
      async run(ctx, cfg) {
        await ctx.write("secret_scan", {
          findings: [{ file: "src/leak.ts", line: 1, pattern: "anthropic_key" }],
          blocked: cfg.toggles.secretScanStrict === "block",
        });
      },
    };

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    // open-pr should NOT have written a `pr` key when secret_scan.blocked.
    expect(await harness.ctx.exists("pr")).toBe(false);
    const ss = (await harness.ctx.read("secret_scan")) as { blocked: boolean };
    expect(ss.blocked).toBe(true);
  });

  // -------------------------------------------------------------------
  // Scenario 7 — one channel fails, the other still fires
  // -------------------------------------------------------------------

  it("scenario 7: one channel send fails, the other still fires", async () => {
    const harness = boot({
      modelResponses: [
        {
          model: "model-classify",
          response: '{"severity":"high","summary":"x","suspectedFiles":[]}',
        },
      ],
      failingChannelType: "email",
      channelConfigs: [
        {
          id: "cc-slack",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "slack",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: { webhookUrl: "https://hooks.slack.com/services/T/B/X" },
        },
        {
          id: "cc-email",
          triggerId: SAMPLE_TRIGGER.id,
          channelType: "email",
          enabled: true,
          notifyOn: ["pr_opened"],
          config: { to: ["oncall@acme.com"], notifyOnSeverityAtLeast: "low" },
        },
      ],
    });

    await harness.ctx.write("trigger", SAMPLE_TRIGGER);
    await harness.ctx.write("alert", SAMPLE_ALERT);

    await runPipeline(harness.ctx, makeCfg(), harness.steps, harness.deps);

    const slack = harness.channels.get("slack") as RecordingChannel;
    const email = harness.channels.get("email") as RecordingChannel;
    expect(slack.recordedSends).toHaveLength(1);
    expect(email.recordedSends).toHaveLength(1);

    const notifications = (await harness.ctx.read("notifications")) as Array<{
      channelType: string;
      ok: boolean;
    }>;
    expect(notifications).toHaveLength(2);
    const okMap = Object.fromEntries(notifications.map((n) => [n.channelType, n.ok]));
    expect(okMap.slack).toBe(true);
    expect(okMap.email).toBe(false);
  });
});
