/**
 * Resolve the canonical TriggerRow for an AgentJob.
 *
 * Strategy: the `triggers` table is the canonical pipeline-config
 * source post-P9; for repos that pre-date `triggers` (synthesised at
 * the P4 backfill from the old `repos_config`), we still synthesize a
 * TriggerRow from the `repos` row keyed on payload.repo so a freshly
 * auto-discovered repo (no triggers row yet) still drives a run.
 *
 * Real triggers (when present) win. The lookup order:
 *   1. triggers row matching (sourceType="sentry", sourceProject=alert.sourceProject)
 *   2. Fall back to synthesizing from `repos` keyed on alert.sourceProject
 *      OR by github repo (legacy lookup).
 *
 * Returns null when neither path can locate a config — caller marks
 * the run no_repo_match.
 */

import { DEFAULT_MODELS, type Preset, type TriggerRow } from "@alertforge/core";
import { createDb } from "@alertforge/db";
import { repos } from "@alertforge/db/schema/admin";
import { triggers } from "@alertforge/db/schema/triggers";
import { and, eq } from "drizzle-orm";

export interface ResolveTriggerInput {
  /** Repo from the AgentJob payload (e.g. "acme/api"). */
  repo: string;
  /** Sentry project slug from the alert (e.g. "backend-api"). */
  sourceProject: string;
}

/**
 * The `repos` row carries the cap, reviewers, default branch, test
 * command override. We re-export the relevant fields alongside the
 * trigger so the worker can pass them into the wrappers without
 * re-querying.
 */
export interface ResolvedTriggerBundle {
  trigger: TriggerRow;
  defaultBranch: string;
  testCommandOverride: string | null;
  reviewers: string[];
  dailyTokenCap: number;
  dailyCostCapCents: number;
}

export async function resolveTriggerForRun(
  input: ResolveTriggerInput,
): Promise<ResolvedTriggerBundle | null> {
  const db = createDb();

  // First: real triggers row.
  const trigRows = await db
    .select()
    .from(triggers)
    .where(and(eq(triggers.sourceType, "sentry"), eq(triggers.sourceProject, input.sourceProject)))
    .limit(1);
  const trig = trigRows[0];

  // Look up the `repos` row either via the trigger's repoId (when we
  // have a real trigger row) or by github repo string (the legacy
  // lookup for auto-discovered repos without a triggers row yet).
  let cfgRow: typeof repos.$inferSelect | undefined;
  if (trig) {
    const cfgRows = await db.select().from(repos).where(eq(repos.id, trig.repoId)).limit(1);
    cfgRow = cfgRows[0];
  } else {
    const cfgRows = await db.select().from(repos).where(eq(repos.github, input.repo)).limit(1);
    cfgRow = cfgRows[0];
  }
  if (!cfgRow) return null;

  const triggerRow: TriggerRow = trig
    ? {
        // DB row → TriggerRow. preset is `string` on the row but `Preset`
        // on the interface; narrow via the union check + fall back to
        // auto_fix if a future preset name lands in DB before the type
        // is widened.
        id: trig.id,
        repoId: trig.repoId,
        sourceType: trig.sourceType,
        sourceProject: trig.sourceProject,
        name: trig.name,
        enabled: trig.enabled,
        preset: normalizePreset(trig.preset),
        config: (trig.config ?? {}) as Record<string, unknown>,
        createdAt: trig.createdAt,
        updatedAt: trig.updatedAt,
      }
    : {
        // Synthetic trigger — id mirrors the `repos` row id so downstream
        // notifications.json + channel_configs lookups have a stable join
        // key without an actual triggers row existing.
        id: cfgRow.id,
        repoId: cfgRow.id,
        sourceType: "sentry",
        sourceProject: input.sourceProject,
        name: `${input.sourceProject} → ${cfgRow.github} (synthesized)`,
        enabled: cfgRow.enabled,
        preset: "auto_fix",
        config: {
          toggles: {
            autoReview: false,
            followUpLoop: false,
            secretScanStrict: "block",
          },
          models: { ...DEFAULT_MODELS },
          budget: {
            dailyTokens: cfgRow.dailyTokenCap,
            dailyCostCents: cfgRow.dailyCostCapCents,
          },
          sourceConfig: {},
        },
        createdAt: cfgRow.createdAt,
        updatedAt: cfgRow.updatedAt,
      };

  return {
    trigger: triggerRow,
    defaultBranch: cfgRow.defaultBranch,
    testCommandOverride: cfgRow.testCommand,
    reviewers: cfgRow.prReviewers,
    dailyTokenCap: cfgRow.dailyTokenCap,
    dailyCostCapCents: cfgRow.dailyCostCapCents,
  };
}

function normalizePreset(raw: string): Preset {
  if (
    raw === "triage_only" ||
    raw === "auto_fix" ||
    raw === "auto_fix_review" ||
    raw === "custom"
  ) {
    return raw;
  }
  // Unknown preset name — default to auto_fix and let the operator
  // notice via the UI; the alternative (throwing) would block runs on
  // a typo'd preset edit.
  return "auto_fix";
}
