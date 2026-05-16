import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG } from "@sentry-fixer-bot/api/mcps-catalog";
import { runCommand } from "@sentry-fixer-bot/api/run/npm-runner";
import { createDb } from "@sentry-fixer-bot/db";
import { mcpInstalls, skillInstalls } from "@sentry-fixer-bot/db/schema/admin";
import { and, eq, isNull } from "drizzle-orm";
import { log } from "./log";

const DEFAULT_SKILLS_REPO =
  process.env.SFB_DEFAULT_SKILLS_REPO ?? "https://github.com/obra/superpowers";
const DEFAULT_SKILLS_NAME = "superpowers-bundle";

function disabled(): boolean {
  return process.env.SFB_DISABLE_AUTO_BOOTSTRAP === "true";
}

function skillsRoot(): string {
  if (process.env.SFB_SKILLS_DIR) return process.env.SFB_SKILLS_DIR;
  if (process.env.SFB_STATE_DIR) return `${process.env.SFB_STATE_DIR}/skills`;
  return "/var/lib/sfb/skills";
}

/**
 * Seed canonical MCP installs (sentry + github) and a canonical skills
 * bundle (superpowers) on a fresh install. Idempotent — checked by
 * catalog id / source ref so re-runs do nothing. Logs one line per
 * insert. Honours SFB_DISABLE_AUTO_BOOTSTRAP=true for CI / tests.
 *
 * Failure of the skills clone is non-fatal: we log the error and keep
 * the server booting. An operator can retry from `/skills`.
 */
export async function bootstrapDefaults(): Promise<void> {
  if (disabled()) {
    log.info("[bootstrap] skipped (SFB_DISABLE_AUTO_BOOTSTRAP=true)");
    return;
  }
  const db = createDb();

  for (const id of ["sentry", "github"] as const) {
    const entry = CATALOG.find((c) => c.id === id);
    if (!entry) continue;
    const existing = await db
      .select({ id: mcpInstalls.id })
      .from(mcpInstalls)
      .where(and(eq(mcpInstalls.catalogId, id), isNull(mcpInstalls.repo)))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(mcpInstalls).values({
      scope: "global",
      repo: null,
      catalogId: entry.id,
      displayName: entry.name,
      transport: entry.transport,
      command: entry.command,
      args: entry.argsTemplate,
      envKeys: Object.keys(entry.envSchema),
      installedBy: null,
    });
    log.info(`[bootstrap] installed mcp:${entry.id}`);
  }

  const existingSkill = await db
    .select({ id: skillInstalls.id })
    .from(skillInstalls)
    .where(eq(skillInstalls.sourceRef, DEFAULT_SKILLS_REPO))
    .limit(1);
  if (existingSkill.length === 0) {
    const installId = crypto.randomUUID();
    const target = join(skillsRoot(), installId);
    await mkdir(target, { recursive: true });
    try {
      const result = await runCommand({
        command: `git clone --depth 1 ${DEFAULT_SKILLS_REPO} ${target}`,
      });
      if (result.exitCode !== 0) {
        await rm(target, { recursive: true, force: true });
        log.warn(
          { stderr: result.stderr.slice(0, 500) },
          `[bootstrap] skill clone failed (${DEFAULT_SKILLS_REPO}); will retry on next boot`,
        );
      } else {
        await db.insert(skillInstalls).values({
          id: installId,
          scope: "global",
          repo: null,
          sourceType: "git",
          sourceRef: DEFAULT_SKILLS_REPO,
          name: DEFAULT_SKILLS_NAME,
          description: "Canonical claude-code skills bundle (auto-installed on first boot).",
          storagePath: target,
          installedBy: null,
        });
        log.info(`[bootstrap] installed skill:${DEFAULT_SKILLS_NAME}`);
      }
    } catch (err) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[bootstrap] skill clone errored",
      );
    }
  }
}
