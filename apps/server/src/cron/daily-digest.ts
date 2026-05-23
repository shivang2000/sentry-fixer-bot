/**
 * Cron registration for the daily-digest sweep.
 *
 * Schedule: 06:00 UTC daily — after the 02:00 outcome-poll so the
 * digest counts include the freshest outcomes. The window the digest
 * covers is always "last 7 days" relative to the tick, computed by
 * the step package.
 *
 * Reuses the same channel registry the worker uses for per-event
 * fan-out (deps.channels). The daily-digest step synthesizes a
 * PipelineNotification with status='digest' and dispatches via every
 * digest-subscribed channel — no parallel pathway.
 */

import { registry } from "@alertforge/core";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts, prs, runs } from "@sentry-fixer-bot/db/schema/domain";
import { channelConfigs, triggers } from "@sentry-fixer-bot/db/schema/triggers";
import {
  type DailyDigestDb,
  type DigestAlertRow,
  type DigestDataLoad,
  type DigestPrRow,
  type DigestRunRow,
  sendDailyDigests,
  type TriggerForDigest,
} from "@sentry-fixer-bot/step-daily-digest";
import { and, eq, gte, lte } from "drizzle-orm";
import { log } from "../log";

export const JOB_DAILY_DIGEST = "daily-digest" as const;
export const DAILY_DIGEST_CRON = "0 6 * * *"; // 06:00 UTC daily

function makeDbAdapter(): DailyDigestDb {
  const db = createDb();
  return {
    async listTriggersWithDigestChannels(): Promise<TriggerForDigest[]> {
      // Fetch every trigger row joined with its repo (for the github
      // slug + cap) and channel configs. Filtering on `digest in
      // notifyOn` happens in the loop body — jsonb-contains predicates
      // are awkward in drizzle and the trigger list is small.
      const triggerRows = await db
        .select({
          id: triggers.id,
          name: triggers.name,
          enabled: triggers.enabled,
          sourceProject: triggers.sourceProject,
          repoGithub: reposConfig.github,
          capCents: reposConfig.dailyCostCapCents,
        })
        .from(triggers)
        .innerJoin(reposConfig, eq(reposConfig.id, triggers.repoId));

      const triggerIds = triggerRows.map((t) => t.id);
      // No triggers → no channels query needed.
      if (triggerIds.length === 0) return [];

      const allChannels = await db
        .select({
          id: channelConfigs.id,
          triggerId: channelConfigs.triggerId,
          channelType: channelConfigs.channelType,
          enabled: channelConfigs.enabled,
          notifyOn: channelConfigs.notifyOn,
          config: channelConfigs.config,
        })
        .from(channelConfigs);
      const channelsByTrigger = new Map<string, typeof allChannels>();
      for (const cc of allChannels) {
        const list = channelsByTrigger.get(cc.triggerId) ?? [];
        list.push(cc);
        channelsByTrigger.set(cc.triggerId, list);
      }

      return triggerRows.map((t) => ({
        id: t.id,
        name: t.name,
        enabled: t.enabled,
        sourceProject: t.sourceProject,
        repo: t.repoGithub,
        capCents: t.capCents,
        channels: (channelsByTrigger.get(t.id) ?? []).map((c) => ({
          id: c.id,
          channelType: c.channelType,
          enabled: c.enabled,
          notifyOn: c.notifyOn,
          config: c.config,
        })),
      }));
    },

    async loadDigestData(input): Promise<DigestDataLoad> {
      const { triggerId, windowStart, windowEnd } = input;

      // Alerts seen in window — joined via runs.alert_id since `alerts`
      // doesn't carry trigger_id directly.
      const alertRows = (await db
        .selectDistinct({
          id: alerts.id,
          fingerprint: alerts.fingerprint,
        })
        .from(alerts)
        .innerJoin(runs, eq(runs.alertId, alerts.id))
        .where(
          and(
            eq(runs.triggerId, triggerId),
            gte(runs.startedAt, windowStart),
            lte(runs.startedAt, windowEnd),
          ),
        )) as DigestAlertRow[];

      // PRs in window with their outcome + alert title/fingerprint.
      const prRows = await db
        .select({
          id: prs.id,
          outcome: prs.outcome,
          fingerprint: alerts.fingerprint,
          title: alerts.title,
        })
        .from(prs)
        .innerJoin(runs, eq(runs.id, prs.runId))
        .innerJoin(alerts, eq(alerts.id, prs.alertId))
        .where(
          and(
            eq(runs.triggerId, triggerId),
            gte(prs.openedAt, windowStart),
            lte(prs.openedAt, windowEnd),
          ),
        );
      const prList: DigestPrRow[] = prRows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        title: r.title,
        outcome: r.outcome as DigestPrRow["outcome"],
      }));

      // Runs with their cost for the trigger over the window.
      const runRows = await db
        .select({
          id: runs.id,
          costCents: runs.costCents,
        })
        .from(runs)
        .where(
          and(
            eq(runs.triggerId, triggerId),
            gte(runs.startedAt, windowStart),
            lte(runs.startedAt, windowEnd),
          ),
        );
      const runList: DigestRunRow[] = runRows.map((r) => ({
        id: r.id,
        costCents: r.costCents,
      }));

      const costCents = runList.reduce((s, r) => s + (r.costCents ?? 0), 0);

      // capCents lives on the trigger's repo; pulled in listTriggers
      // above but we don't have it here — query directly.
      const trig = await db
        .select({
          capCents: reposConfig.dailyCostCapCents,
        })
        .from(triggers)
        .innerJoin(reposConfig, eq(reposConfig.id, triggers.repoId))
        .where(eq(triggers.id, triggerId))
        .limit(1);
      const capCents = trig[0]?.capCents ?? 0;

      return {
        alerts: alertRows,
        runs: runList,
        prs: prList,
        costCents,
        capCents,
      };
    },
  };
}

/**
 * pg-boss worker callback. Single shot — handler runs the whole sweep
 * and returns. Per-trigger / per-channel failures are caught inside
 * `sendDailyDigests`.
 */
export async function processDailyDigestJob(): Promise<void> {
  try {
    await sendDailyDigests({
      db: makeDbAdapter(),
      log,
      channels: registry.channels,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "daily-digest: sweep failed (top-level)",
    );
  }
}
