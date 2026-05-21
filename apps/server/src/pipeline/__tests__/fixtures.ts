/**
 * Shared test fixtures for the runPipeline integration test.
 *
 * The integration test drives a hermetic end-to-end run through every
 * wrapper without:
 *   - hitting the network (no Sentry / GitHub / S3 / channel HTTP calls),
 *   - touching postgres (db client is a stub),
 *   - shelling out to git/gh/test commands (Bun.spawn is mocked via a
 *     module-level seam — see `apps/server/src/pipeline/spawn.ts`).
 *
 * Each fixture exposes:
 *   - `recordedX` arrays the tests assert against,
 *   - a `reset()` to clear state between cases.
 */

import type {
  ChannelAdapter,
  CtxField,
  CtxStore,
  Logger,
  ModelProvider,
  NormalizedAlert,
  PipelineNotification,
  PromptMessages,
  ResolvedConfig,
  S3PutClient,
  SourceAdapter,
  TriggerRow,
} from "@alertforge/core";

// ----------------------------------------------------------------------
// In-memory CtxStore
// ----------------------------------------------------------------------

/**
 * Memory-backed CtxStore for tests. Mirrors DiskCtxStore semantics for
 * the fields the wrappers touch but stays in-process so the assertions
 * can inspect `recordedWrites` without re-reading the file each time.
 */
export class MemoryCtxStore implements CtxStore {
  readonly runId: string;
  readonly dir: string;
  /** field name → JS value (objects for json fields, strings for log fields). */
  readonly recordedWrites: Map<CtxField, unknown> = new Map();
  /** field name → appended chunks (log fields only). */
  readonly recordedAppends: Map<CtxField, string[]> = new Map();
  /** order in which write/append happened, for sequencing assertions. */
  readonly writeOrder: CtxField[] = [];

  constructor(runId: string) {
    this.runId = runId;
    this.dir = `/mem/ctx/${runId}`;
  }

  async read<T>(field: CtxField): Promise<T | null> {
    if (!this.recordedWrites.has(field)) return null;
    return this.recordedWrites.get(field) as T;
  }

  async write<T>(field: CtxField, value: T): Promise<void> {
    this.recordedWrites.set(field, value);
    if (!this.writeOrder.includes(field)) this.writeOrder.push(field);
  }

  async append(field: CtxField, chunk: string): Promise<void> {
    const list = this.recordedAppends.get(field) ?? [];
    list.push(chunk);
    this.recordedAppends.set(field, list);
    // Materialize the accumulated text under read() so wrappers that
    // need to consume the transcript can pull it back out.
    const cur = (this.recordedWrites.get(field) as string | undefined) ?? "";
    this.recordedWrites.set(field, cur + chunk);
    if (!this.writeOrder.includes(field)) this.writeOrder.push(field);
  }

  async exists(field: CtxField): Promise<boolean> {
    return this.recordedWrites.has(field);
  }

  async size(field: CtxField): Promise<number> {
    const v = this.recordedWrites.get(field);
    if (v === undefined) return 0;
    if (typeof v === "string") return v.length;
    return JSON.stringify(v).length;
  }

  async truncatedFields(): Promise<CtxField[]> {
    return [];
  }
}

// ----------------------------------------------------------------------
// Mock model provider with per-modelKey response queue
// ----------------------------------------------------------------------

/**
 * Queued responses keyed by model id (the resolved value of
 * cfg.models[modelKey]). Each call shifts the head; lacking a queued
 * response returns "{}" so the wrapper's parse-fallback path runs.
 */
export class QueuedModelProvider implements ModelProvider {
  readonly name = "queued";
  readonly recordedCalls: Array<{ model: string; prompt: PromptMessages }> = [];
  private readonly queue: Map<string, string[]> = new Map();

  enqueue(modelId: string, response: string): void {
    const q = this.queue.get(modelId) ?? [];
    q.push(response);
    this.queue.set(modelId, q);
  }

  async complete(args: { model: string } & PromptMessages): Promise<string> {
    const { model, ...rest } = args;
    this.recordedCalls.push({ model, prompt: rest });
    const q = this.queue.get(model);
    if (!q || q.length === 0) return "{}";
    return q.shift() ?? "{}";
  }
}

// ----------------------------------------------------------------------
// In-memory channel registry
// ----------------------------------------------------------------------

export interface RecordedSend {
  channelType: string;
  notification: PipelineNotification;
  config: unknown;
  ok: boolean;
  error?: string;
}

/**
 * In-memory channel adapter that captures every send call and lets the
 * test decide success/failure per channel type.
 */
export class RecordingChannel implements ChannelAdapter {
  readonly type: string;
  readonly displayName: string;
  readonly configSchema = { parse: (v: unknown) => v } as unknown as ChannelAdapter["configSchema"];
  readonly catalogEntry = {
    description: "test recording channel",
    setupGuide: "n/a",
    requiresEnvKeys: [],
  };
  readonly recordedSends: RecordedSend[] = [];
  private readonly failOn: boolean;

  constructor(type: string, opts: { fail?: boolean } = {}) {
    this.type = type;
    this.displayName = `Recording (${type})`;
    this.failOn = opts.fail ?? false;
  }

  async send(notification: PipelineNotification, rawConfig: unknown): Promise<void> {
    const entry: RecordedSend = {
      channelType: this.type,
      notification,
      config: rawConfig,
      ok: !this.failOn,
    };
    if (this.failOn) {
      entry.error = `simulated ${this.type} failure`;
      this.recordedSends.push(entry);
      throw new Error(entry.error);
    }
    this.recordedSends.push(entry);
  }
}

// ----------------------------------------------------------------------
// In-memory S3 client
// ----------------------------------------------------------------------

export class MemoryS3 implements S3PutClient {
  readonly objects: Map<string, { body: string; contentType?: string }> = new Map();
  async put(key: string, body: Buffer | string, contentType?: string): Promise<string> {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (contentType !== undefined) {
      this.objects.set(key, { body: text, contentType });
    } else {
      this.objects.set(key, { body: text });
    }
    return `mem://${key}`;
  }
}

// ----------------------------------------------------------------------
// Stub Sentry source adapter
// ----------------------------------------------------------------------

export function makeStubSentrySource(opts: { stackTrace?: string } = {}): SourceAdapter {
  const adapter: SourceAdapter = {
    type: "sentry",
    displayName: "Sentry (stub)",
    webhookPath: "/webhooks/sentry",
    async verifyWebhook() {
      return true;
    },
    parsePayload() {
      return null;
    },
    async fetchEventDetail(alert) {
      return {
        ...alert,
        stackTrace: opts.stackTrace ?? "TypeError: x is undefined\n  at foo.ts:1",
      };
    },
    dedupKey(alert) {
      return `${alert.sourceProject}:${alert.fingerprint}`;
    },
    urlPatterns: [],
    parseUrl() {
      return null;
    },
    async fetchByExternalId(): Promise<NormalizedAlert> {
      throw new Error("not used in integration test");
    },
    configSchema: { parse: (v: unknown) => v } as unknown as SourceAdapter["configSchema"],
    catalogEntry: {
      description: "stub",
      setupGuide: "n/a",
      requiresEnvKeys: [],
      urlExamples: [],
    },
  };
  return adapter;
}

// ----------------------------------------------------------------------
// In-memory DB stub
// ----------------------------------------------------------------------

export interface StubChannelConfigRow {
  id: string;
  triggerId: string;
  channelType: string;
  enabled: boolean;
  notifyOn: string[];
  config: unknown;
}

export interface StubPrRow {
  alertId: string;
  runId: string;
  repo: string;
  number: number;
  url: string;
  isDraft: boolean;
  needsHuman: boolean;
  humanReviewState: string;
}

/**
 * Tiny in-memory stand-in for the drizzle client. Only the operations
 * the wrappers actually perform are implemented:
 *   - `listChannelConfigs(triggerId)` for fan-out-channels,
 *   - `insertPr(row)` for open-pr,
 *   - `recordBudgetUsage(...)` for budget.
 *
 * Wrappers cast `deps.db` to `StubDb` in tests; in production
 * deps-factory hands them the real drizzle client and the wrapper
 * dispatches accordingly.
 */
export class StubDb {
  readonly channelConfigs: StubChannelConfigRow[] = [];
  readonly insertedPrs: StubPrRow[] = [];
  readonly recordedUsage: Array<{ repo: string; tokens: number; costCents: number }> = [];

  async listChannelConfigs(triggerId: string): Promise<StubChannelConfigRow[]> {
    return this.channelConfigs.filter((r) => r.triggerId === triggerId && r.enabled);
  }

  async insertPr(row: StubPrRow): Promise<void> {
    this.insertedPrs.push(row);
  }

  async recordBudgetUsage(input: { repo: string; tokens: number; costCents: number }) {
    this.recordedUsage.push(input);
  }
}

// ----------------------------------------------------------------------
// Logger fixture
// ----------------------------------------------------------------------

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

// ----------------------------------------------------------------------
// Run-log recorder
// ----------------------------------------------------------------------

export interface RecordedLogLine {
  level: string;
  source: string;
  message: string;
}

export function makeLogRecorder() {
  const lines: RecordedLogLine[] = [];
  return {
    lines,
    appendLog: async (line: RecordedLogLine) => {
      lines.push(line);
    },
  };
}

// ----------------------------------------------------------------------
// Bun.spawn shim — overrides the project's spawn seam during tests
// ----------------------------------------------------------------------

/**
 * Scripted command response. Matched by exact argv tokens or by a
 * regexp on the joined string. First match wins.
 */
export interface ScriptedCommand {
  match: RegExp | string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export class SpawnScript {
  readonly calls: Array<{ argv: string[]; cwd?: string }> = [];
  private readonly commands: ScriptedCommand[] = [];

  on(match: RegExp | string[], result: Omit<ScriptedCommand, "match">): this {
    this.commands.push({ match, ...result });
    return this;
  }

  run(argv: string[], cwd?: string): { exitCode: number; stdout: string; stderr: string } {
    if (cwd !== undefined) {
      this.calls.push({ argv, cwd });
    } else {
      this.calls.push({ argv });
    }
    const joined = argv.join(" ");
    for (const c of this.commands) {
      if (Array.isArray(c.match)) {
        if (c.match.length <= argv.length && c.match.every((tok, i) => argv[i]?.includes(tok))) {
          return {
            exitCode: c.exitCode ?? 0,
            stdout: c.stdout ?? "",
            stderr: c.stderr ?? "",
          };
        }
      } else if (c.match.test(joined)) {
        return {
          exitCode: c.exitCode ?? 0,
          stdout: c.stdout ?? "",
          stderr: c.stderr ?? "",
        };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

// ----------------------------------------------------------------------
// Sample fixtures
// ----------------------------------------------------------------------

export const SAMPLE_ALERT: NormalizedAlert = {
  sourceType: "sentry",
  sourceProject: "backend-api",
  externalId: "ISSUE-12345",
  fingerprint: "abc123",
  title: "TypeError: Cannot read property 'name' of undefined",
  level: "error",
  firstSeenAt: new Date("2026-05-21T00:00:00Z"),
  lastSeenAt: new Date("2026-05-21T01:00:00Z"),
  rawPayloadS3Key: "s3://bucket/raw/12345.json",
};

export const SAMPLE_TRIGGER: TriggerRow = {
  id: "trig-1",
  repoId: "repo-1",
  sourceType: "sentry",
  sourceProject: "backend-api",
  name: "backend-api → acme/api (auto_fix)",
  enabled: true,
  preset: "auto_fix",
  config: {
    toggles: { autoReview: false, followUpLoop: false, secretScanStrict: "block" },
    models: {
      classify: "model-classify",
      fix: "model-fix",
      review: "model-review",
      followUp: "model-followup",
    },
    budget: { dailyTokens: 1_000_000, dailyCostCents: 2500 },
    sourceConfig: {},
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function makeCfg(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    toggles: { autoReview: false, followUpLoop: false, secretScanStrict: "block" },
    models: {
      classify: "model-classify",
      fix: "model-fix",
      review: "model-review",
      followUp: "model-followup",
    },
    budget: { dailyTokens: 1_000_000, dailyCostCents: 2500 },
    sourceConfig: {},
    ...overrides,
  };
}
