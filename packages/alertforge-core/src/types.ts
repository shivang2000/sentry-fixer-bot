import type { z } from "zod";

// ---------- Normalized domain types ----------

export type AlertLevel = "error" | "warning" | "info";
export type SeverityLevel = "low" | "medium" | "high" | "critical";

export interface NormalizedAlert {
  sourceType: string;
  sourceProject: string;
  externalId: string;
  fingerprint: string;
  title: string;
  level: AlertLevel;
  firstSeenAt: Date;
  lastSeenAt: Date;
  codeVersion?: string;
  rawPayloadS3Key: string;
}

export interface EnrichedAlert extends NormalizedAlert {
  stackTrace?: string;
  breadcrumbs?: Array<{ ts: Date; category: string; message: string }>;
  affectedUsers?: number;
  eventCount24h?: number;
}

// ---------- Source adapter ----------

export interface SourceDeps {
  apiToken?: string;
  log: Logger;
}

export interface SourceAdapter {
  type: string;
  displayName: string;
  webhookPath: string;
  verifyWebhook(req: Request, secret: string): Promise<boolean>;
  parsePayload(body: unknown): NormalizedAlert | null;
  fetchEventDetail?(alert: NormalizedAlert, deps: SourceDeps): Promise<EnrichedAlert>;
  dedupKey(alert: NormalizedAlert): string;
  postAlertComment?(alert: NormalizedAlert, message: string, deps: SourceDeps): Promise<void>;
  urlPatterns: RegExp[];
  parseUrl(url: string): { sourceProject: string; externalId: string } | null;
  fetchByExternalId(
    sourceProject: string,
    externalId: string,
    deps: SourceDeps,
  ): Promise<NormalizedAlert>;
  configSchema: z.ZodSchema;
  catalogEntry: SourceCatalogEntry;
}

export interface SourceCatalogEntry {
  description: string;
  setupGuide: string;
  requiresEnvKeys: string[];
  urlExamples: string[];
}

// ---------- Channel adapter ----------

export type NotificationStatus =
  | "pr_opened"
  | "triage_only"
  | "failed"
  | "budget_blocked"
  | "duplicate_pr"
  | "digest";

export interface PipelineNotification {
  triggerId: string;
  alert: NormalizedAlert;
  runId: string;
  status: NotificationStatus;
  prUrl?: string;
  triageSummary?: string;
  severity?: SeverityLevel;
  confidence?: number;
  costCents?: number;
  ctxArchiveS3?: string;
  digestBody?: DigestPayload;
}

export interface DigestPayload {
  windowStart: Date;
  windowEnd: Date;
  alertCount: number;
  fixesAttempted: number;
  mergedClean: number;
  mergedWithEdits: number;
  closedUnmerged: number;
  open: number;
  topFingerprints: Array<{ fingerprint: string; title: string; count: number; closed: number }>;
  costCents: number;
  capCents: number;
  suggestedAction?: string;
}

export interface ChannelCatalogEntry {
  description: string;
  setupGuide: string;
  requiresEnvKeys: string[];
}

export interface ChannelAdapter {
  type: string;
  displayName: string;
  configSchema: z.ZodSchema;
  send(notification: PipelineNotification, config: unknown): Promise<void>;
  catalogEntry: ChannelCatalogEntry;
}

// ---------- Pipeline steps ----------

export type CtxField =
  | "trigger"
  | "alert"
  | "event_detail"
  | "triage"
  | "budget"
  | "workspace"
  | "agent_transcript"
  | "agent_output"
  | "secret_scan"
  | "test_result"
  | "diff"
  | "pr"
  | "review"
  | "follow_up"
  | "notifications";

export interface CtxStore {
  readonly runId: string;
  readonly dir: string;
  read<T>(field: CtxField): Promise<T | null>;
  write<T>(field: CtxField, value: T, opts?: { capBytes?: number }): Promise<void>;
  append(field: CtxField, chunk: string): Promise<void>;
  exists(field: CtxField): Promise<boolean>;
  size(field: CtxField): Promise<number>;
  truncatedFields(): Promise<CtxField[]>;
}

export interface PipelineStep {
  name: string;
  description: string;
  skipIf?(ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean>;
  run(ctx: CtxStore, cfg: ResolvedConfig, deps: StepDeps): Promise<void>;
}

export type ModelStepKey = "classify" | "fix" | "review" | "followUp";

export interface PromptMessages {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmStep<TInput, TOutput> {
  name: string;
  description: string;
  modelKey: ModelStepKey;
  skipIf?(ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean>;
  selectInput(ctx: CtxStore): Promise<TInput>;
  buildPrompt(input: TInput): PromptMessages;
  parseOutput(raw: string): TOutput;
  applyToCtx(ctx: CtxStore, out: TOutput): Promise<void>;
}

export interface ModelProvider {
  readonly name: string;
  complete(args: { model: string } & PromptMessages): Promise<string>;
}

/**
 * Run-log line consumed by `appendLog` on StepDeps. Mirrors the shape
 * apps/server/src/runs/log.ts `appendRunLog` accepts so wrappers can
 * forward without rebinding fields. `runId` is implicit (curried in by
 * deps-factory) so wrappers only supply level/source/message.
 */
export interface RunLogLine {
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
}

/**
 * Minimal S3-put surface used by wrappers (ctx archive + log archive).
 * Concrete adapters live in apps/server (real AWS SDK client) and in
 * test fixtures (in-memory recording). Wrappers depend on this narrow
 * shape so the core package stays SDK-free.
 */
export interface S3PutClient {
  put(key: string, body: Buffer | string, contentType?: string): Promise<string>;
}

/**
 * Thin DB surface used by wrappers when they need to read/write rows
 * outside the ctx store (channel_configs lookup, prs insert, repos_config
 * read for legacy budget interop). Wrappers receive the project's actual
 * drizzle client through this opaque slot; tests inject a stub. Typed as
 * `unknown` here to keep alertforge-core free of drizzle types — consumers
 * cast at the wrapper boundary.
 */
export type DbClient = unknown;

/**
 * Callback the consumer supplies to resolve a GitHub token for clone +
 * fetch + push. Same shape as the per-step `ResolveGithubToken` aliases
 * in @alertforge/step-workspace + @alertforge/step-open-pr; consolidated
 * here so wrappers pull it via `deps.resolveToken` rather than passing
 * a separate callback into each wrapper factory.
 */
export type ResolveToken = () => Promise<string>;

export interface StepDeps {
  modelProvider: ModelProvider;
  log: Logger;
  sources: Map<string, SourceAdapter>;
  channels: Map<string, ChannelAdapter>;
  /**
   * Per-run run-log writer. Wrappers call `deps.appendLog({level, source,
   * message})` to surface progress in the UI. The runId is curried by
   * the deps factory in apps/server/src/pipeline/deps-factory.ts so the
   * wrapper layer is run-agnostic and re-usable for the pr-followup
   * worker later (P3c.3).
   *
   * Optional so existing tests + tests that don't care about logs can
   * omit it without ceremony — the pipeline.test.ts and llm-step.test.ts
   * suites both lived before this extension landed.
   */
  appendLog?: (line: RunLogLine) => Promise<void>;
  /**
   * Resolve a GitHub token for clone / fetch / push / gh CLI auth.
   * Wrappers pass this down to step packages that take an explicit
   * `resolveToken` callback (workspace, open-pr). Optional for the
   * same back-compat reason as appendLog.
   */
  resolveToken?: ResolveToken;
  /**
   * Drizzle DB client (or stub). Used by wrappers that read/write rows
   * outside the ctx store — e.g. open-pr inserts into `prs`, fan-out
   * reads `channel_configs`. Optional for back-compat.
   */
  db?: DbClient;
  /**
   * S3 put client for archiving ctx + payloads. Optional for back-compat;
   * the deps factory injects a real client in production and an in-memory
   * one in tests.
   */
  s3?: S3PutClient;
}

// ---------- Logger (minimal contract; consumers plug pino) ----------

export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

// ---------- Resolved config (preset-expanded) ----------

export type Preset = "triage_only" | "auto_fix" | "auto_fix_review" | "custom";

export interface ResolvedConfig {
  toggles: {
    autoReview: boolean;
    followUpLoop: boolean;
    secretScanStrict: "block" | "warn";
  };
  models: Record<ModelStepKey, string>;
  budget: {
    dailyTokens: number;
    dailyCostCents: number;
  };
  sourceConfig: Record<string, unknown>;
  stopAfter?: "budget";
}

// ---------- Trigger row shape (DB-aligned) ----------

export interface TriggerRow {
  id: string;
  repoId: string;
  sourceType: string;
  sourceProject: string;
  name: string;
  enabled: boolean;
  preset: Preset;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
