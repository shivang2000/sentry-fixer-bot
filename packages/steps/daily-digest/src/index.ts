/**
 * `sendDailyDigests` — cron entry point. Per trigger:
 *
 *   1. Skip if disabled.
 *   2. Skip if no channel_config has 'digest' in notify_on.
 *   3. Load the rows `buildDigest` needs (alerts + runs + prs + cost +
 *      cap for the 7d window).
 *   4. Compute the DigestPayload.
 *   5. Fan out the synthetic PipelineNotification via every digest-
 *      subscribed channel. Failures isolate per channel.
 *
 * Network effects (channel sends) are wrapped in try/catch so one
 * dying channel doesn't kill the sweep. The DB load happens once per
 * trigger; if it throws, the trigger is skipped with a warn.
 */

import type { ChannelAdapter, Logger } from "@alertforge/core";
import { buildDigest, buildDigestNotification, type DigestInput } from "./build-digest";

export type {
  DigestAlertRow,
  DigestEnvelope,
  DigestInput,
  DigestPrRow,
  DigestRunRow,
} from "./build-digest";
export { buildDigest, buildDigestNotification } from "./build-digest";

/** Days the digest looks back. */
export const DIGEST_WINDOW_DAYS = 7;

export interface ChannelConfigRow {
  id: string;
  channelType: string;
  enabled: boolean;
  notifyOn: string[];
  config: unknown;
}

export interface TriggerForDigest {
  id: string;
  name: string;
  enabled: boolean;
  sourceProject: string;
  /** GitHub slug for diagnostics; not currently rendered. */
  repo: string;
  /** Cap-cents to compare cost-vs-cap. */
  capCents: number;
  channels: ChannelConfigRow[];
}

export interface DigestDataLoad {
  alerts: DigestInput["alerts"];
  runs: DigestInput["runs"];
  prs: DigestInput["prs"];
  costCents: number;
  capCents: number;
}

export interface DailyDigestDb {
  /**
   * Returns triggers + their channelConfigs joined in. The cron sweep
   * uses this single round trip rather than N+1 queries. Filtering on
   * `enabled` / `digest in notifyOn` happens in the loop body to keep
   * the SQL simple.
   */
  listTriggersWithDigestChannels(): Promise<TriggerForDigest[]>;
  /**
   * Per-trigger window load. Implementation runs three drizzle queries:
   * count alerts seen, list PRs with their outcome, sum cost over the
   * window.
   */
  loadDigestData(input: {
    triggerId: string;
    windowStart: Date;
    windowEnd: Date;
  }): Promise<DigestDataLoad>;
}

export interface DailyDigestDeps {
  db: DailyDigestDb;
  log: Logger;
  channels: Map<string, ChannelAdapter>;
  /** Override for tests; production uses Date.now(). */
  now?(): Date;
}

export async function sendDailyDigests(deps: DailyDigestDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const windowEnd = now;
  const windowStart = new Date(windowEnd.getTime() - DIGEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const runId = `digest-${windowEnd.toISOString().slice(0, 10)}`;

  const triggers = await deps.db.listTriggersWithDigestChannels();
  let sent = 0;
  let skipped = 0;

  for (const trigger of triggers) {
    if (!trigger.enabled) {
      skipped += 1;
      continue;
    }
    const digestChannels = trigger.channels.filter(
      (c) => c.enabled && c.notifyOn.includes("digest"),
    );
    if (digestChannels.length === 0) {
      skipped += 1;
      continue;
    }

    let data: DigestDataLoad;
    try {
      data = await deps.db.loadDigestData({
        triggerId: trigger.id,
        windowStart,
        windowEnd,
      });
    } catch (err) {
      deps.log.warn(
        { triggerId: trigger.id, err: err instanceof Error ? err.message : String(err) },
        "daily-digest: data load failed",
      );
      continue;
    }

    const payload = buildDigest({
      trigger: { id: trigger.id, name: trigger.name },
      window: { start: windowStart, end: windowEnd },
      alerts: data.alerts,
      runs: data.runs,
      prs: data.prs,
      costCents: data.costCents,
      capCents: data.capCents,
    });

    const notification = buildDigestNotification({
      trigger: {
        id: trigger.id,
        name: trigger.name,
        sourceProject: trigger.sourceProject,
      },
      runId,
      payload,
      costCents: data.costCents,
    });

    for (const cc of digestChannels) {
      const adapter = deps.channels.get(cc.channelType);
      if (!adapter) {
        deps.log.warn(
          { triggerId: trigger.id, channelType: cc.channelType },
          "daily-digest: no adapter registered for channel type — skipping",
        );
        continue;
      }
      try {
        await adapter.send(notification, cc.config);
        sent += 1;
      } catch (err) {
        deps.log.warn(
          {
            triggerId: trigger.id,
            channelId: cc.id,
            channelType: cc.channelType,
            err: err instanceof Error ? err.message : String(err),
          },
          "daily-digest: channel send failed",
        );
      }
    }
  }

  deps.log.info({ triggers: triggers.length, sent, skipped }, "daily-digest: sweep complete");
}
