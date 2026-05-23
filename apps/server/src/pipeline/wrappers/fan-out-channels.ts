/**
 * PipelineStep wrapper for fan-out to enabled notification channels.
 *
 * Reads the trigger's `channel_configs` rows (filtered to enabled + the
 * status's `notifyOn` list), invokes each channel adapter's `send`
 * method via deps.channels, and records the per-channel outcome into
 * ctx.notifications. One channel failure does NOT abort the others —
 * we collect-then-throw-nothing so the run row still reaches a
 * terminal state with partial-success visibility.
 *
 * Status derivation:
 *   - ctx.pr present → "pr_opened"
 *   - cfg.stopAfter === "budget" → "triage_only" (budget-blocked OR
 *     triage_only preset)
 *   - ctx.test_result.passed === false → status stays "pr_opened" (the
 *     PR was opened as draft; the channel adapter decides whether to
 *     mention)
 *
 * Reads:  ctx.trigger, ctx.alert, ctx.pr (optional), ctx.triage
 *         (optional), ctx.review (optional), ctx.agent_output (optional)
 * Writes: ctx.notifications
 *
 * Skip rules: NEVER skipped (per spec: "always fan out, even on
 * failure paths").
 */

import type {
  CtxStore,
  NormalizedAlert,
  NotificationStatus,
  PipelineNotification,
  PipelineStep,
  ResolvedConfig,
  SeverityLevel,
  StepDeps,
  TriggerRow,
} from "@alertforge/core";
import type { TriageResult } from "@alertforge/step-classify";
import type { AgentOutput } from "./fix-agent";
import type { PrCtxValue } from "./open-pr";
import type { ReviewCtxValue } from "./review-pr";

export interface ChannelConfigRow {
  id: string;
  triggerId: string;
  channelType: string;
  enabled: boolean;
  notifyOn: string[];
  config: unknown;
}

export interface NotificationRecord {
  channelId: string;
  channelType: string;
  status: NotificationStatus;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export type ListChannelConfigsFn = (triggerId: string) => Promise<ChannelConfigRow[]>;

export interface WrapFanOutChannelsOpts {
  /** Override for tests. Production routes through drizzle. */
  listChannelConfigsFn?: ListChannelConfigsFn;
  /** Per-run id used for the PipelineNotification.runId field. */
  runId: string;
}

export async function runFanOutChannelsStep(
  ctx: CtxStore,
  cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapFanOutChannelsOpts,
): Promise<void> {
  const trigger = await ctx.read<TriggerRow>("trigger");
  const alert = await ctx.read<NormalizedAlert>("alert");
  if (!trigger || !alert) {
    await ctx.write("notifications", []);
    return;
  }

  const pr = await ctx.read<PrCtxValue>("pr");
  const triage = await ctx.read<TriageResult>("triage");
  const review = await ctx.read<ReviewCtxValue>("review");
  const agentOutput = await ctx.read<AgentOutput>("agent_output");

  const status: NotificationStatus =
    cfg.stopAfter === "budget" ? "triage_only" : pr ? "pr_opened" : "failed";

  const severity: SeverityLevel | undefined = (() => {
    if (triage?.severity) return triage.severity as SeverityLevel;
    const fromAgent = (agentOutput as { severity?: string } | null)?.severity;
    if (
      fromAgent === "low" ||
      fromAgent === "medium" ||
      fromAgent === "high" ||
      fromAgent === "critical"
    ) {
      return fromAgent;
    }
    return undefined;
  })();

  const notification: PipelineNotification = {
    triggerId: trigger.id,
    alert,
    runId: opts.runId,
    status,
    ...(pr?.url ? { prUrl: pr.url } : {}),
    ...(triage?.summary ? { triageSummary: triage.summary } : {}),
    ...(severity ? { severity } : {}),
  };
  void review;

  const list = opts.listChannelConfigsFn ?? (await loadListChannelsReal(deps));
  const configs = await list(trigger.id);

  const records: NotificationRecord[] = [];
  for (const cc of configs) {
    if (!cc.notifyOn.includes(status)) {
      // Channel opted out of this status; skip silently.
      continue;
    }
    const adapter = deps.channels.get(cc.channelType);
    if (!adapter) {
      records.push({
        channelId: cc.id,
        channelType: cc.channelType,
        status,
        ok: false,
        error: `no channel adapter registered for type=${cc.channelType}`,
        durationMs: 0,
      });
      continue;
    }
    const t0 = Date.now();
    try {
      await adapter.send(notification, cc.config);
      records.push({
        channelId: cc.id,
        channelType: cc.channelType,
        status,
        ok: true,
        durationMs: Date.now() - t0,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await deps.appendLog?.({
        level: "warn",
        source: "fan-out",
        message: `channel ${cc.channelType} send failed: ${msg}`,
      });
      records.push({
        channelId: cc.id,
        channelType: cc.channelType,
        status,
        ok: false,
        error: msg,
        durationMs: Date.now() - t0,
      });
    }
  }
  await ctx.write("notifications", records);
}

export function wrapFanOutChannelsStep(opts: WrapFanOutChannelsOpts): PipelineStep {
  return {
    name: "fan-out-channels",
    description: "Send PipelineNotification to every enabled channel for this trigger",
    async run(ctx, cfg, deps) {
      await runFanOutChannelsStep(ctx, cfg, deps, opts);
    },
  };
}

// ---------- helpers ----------

async function loadListChannelsReal(deps: StepDeps): Promise<ListChannelConfigsFn> {
  // Production drizzle lookup. The deps.db opaque slot carries the
  // real client; wrappers in tests inject listChannelConfigsFn
  // directly via the factory option.
  return async (triggerId: string) => {
    const db = deps.db as
      | {
          select: () => {
            from: (t: unknown) => {
              where: (expr: unknown) => Promise<ChannelConfigRow[]>;
            };
          };
        }
      | undefined;
    if (!db) return [];
    const { channelConfigs } = await import("@alertforge/db/schema/triggers");
    const { eq, and } = await import("drizzle-orm");
    const rows = (await db
      .select()
      .from(channelConfigs)
      .where(
        and(eq(channelConfigs.triggerId, triggerId), eq(channelConfigs.enabled, true)),
      )) as Array<
      Pick<ChannelConfigRow, "id" | "triggerId" | "channelType" | "enabled" | "notifyOn" | "config">
    >;
    return rows.map((r) => ({
      id: r.id,
      triggerId: r.triggerId,
      channelType: r.channelType,
      enabled: r.enabled,
      notifyOn: r.notifyOn,
      config: r.config,
    }));
  };
}
