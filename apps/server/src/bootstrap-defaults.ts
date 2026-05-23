import { access, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG } from "@alertforge/api/mcps-catalog";
import { runCommand } from "@alertforge/api/run/npm-runner";
import { createDb } from "@alertforge/db";
import { mcpInstalls, skillInstalls } from "@alertforge/db/schema/admin";
import { and, eq, isNull } from "drizzle-orm";
import { log } from "./log";

/** Where claude's CLI looks up `/skill-name` slash commands. */
function claudeSkillsDir(): string {
  const home = `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/home`;
  return join(home, ".claude", "skills");
}

/**
 * Link each subskill of a bundle into ~/.claude/skills/ as a flat
 * directory name. Claude resolves `/<name>` against the immediate
 * children of that dir — it does NOT understand a `bundle:name`
 * namespace, so `/superpowers:brainstorming` would 404 even if the
 * file existed under `skills/brainstorming/SKILL.md`. Flat-symlink
 * each subdir and the prompt can invoke them via `/<name>`.
 *
 * Idempotent (uses `ln -sfn` semantics — replaces existing symlink).
 * Skips non-directory entries inside the bundle (LICENSE, README, etc.).
 * Logs the count of linked skills for observability.
 */
async function linkBundleSubskills(bundlePath: string): Promise<void> {
  const src = join(bundlePath, "skills");
  try {
    await access(src);
  } catch {
    return; // bundle structure doesn't expose a skills/ dir; nothing to do
  }
  const target = claudeSkillsDir();
  await mkdir(target, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  let linked = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const linkPath = join(target, entry.name);
    try {
      await rm(linkPath, { recursive: false, force: true });
    } catch {
      // ignore — symlink replacement is best-effort
    }
    try {
      await symlink(join(src, entry.name), linkPath, "dir");
      linked += 1;
    } catch (err) {
      log.warn(
        { name: entry.name, err: err instanceof Error ? err.message : err },
        "[bootstrap] failed to symlink skill",
      );
    }
  }
  log.info({ linked, target }, "[bootstrap] linked bundle subskills into claude skills dir");
}

const DEFAULT_SKILLS_REPO =
  process.env.ALERTFORGE_DEFAULT_SKILLS_REPO ?? "https://github.com/obra/superpowers";
const DEFAULT_SKILLS_NAME = "superpowers-bundle";

function disabled(): boolean {
  return process.env.ALERTFORGE_DISABLE_AUTO_BOOTSTRAP === "true";
}

function skillsRoot(): string {
  const explicit = process.env.ALERTFORGE_SKILLS_DIR;
  if (explicit) return explicit;
  const state = process.env.ALERTFORGE_STATE_DIR;
  if (state) return `${state}/skills`;
  return "/var/lib/alertforge/skills";
}

/**
 * Seed canonical MCP installs (sentry + github) and a canonical skills
 * bundle (superpowers) on a fresh install. Idempotent — checked by
 * catalog id / source ref so re-runs do nothing. Logs one line per
 * insert. Honours ALERTFORGE_DISABLE_AUTO_BOOTSTRAP=true for CI / tests.
 *
 * Failure of the skills clone is non-fatal: we log the error and keep
 * the server booting. An operator can retry from `/skills`.
 */
export async function bootstrapDefaults(): Promise<void> {
  if (disabled()) {
    log.info("[bootstrap] skipped (ALERTFORGE_DISABLE_AUTO_BOOTSTRAP=true)");
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
    .select({ id: skillInstalls.id, storagePath: skillInstalls.storagePath })
    .from(skillInstalls)
    .where(eq(skillInstalls.sourceRef, DEFAULT_SKILLS_REPO))
    .limit(1);
  // Already installed in a prior boot — relink subskills so /brainstorming
  // etc. resolve. Cheap (~10 symlink ops); safe to repeat on every boot.
  if (existingSkill.length > 0 && existingSkill[0]?.storagePath) {
    await linkBundleSubskills(existingSkill[0].storagePath).catch((err) =>
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "[bootstrap] relink subskills failed",
      ),
    );
  }
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
        await linkBundleSubskills(target).catch((err) =>
          log.warn(
            { err: err instanceof Error ? err.message : err },
            "[bootstrap] post-clone link failed",
          ),
        );
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
