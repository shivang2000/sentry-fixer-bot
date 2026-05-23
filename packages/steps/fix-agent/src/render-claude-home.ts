import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@alertforge/db";
import { mcpInstalls, skillInstalls } from "@alertforge/db/schema/admin";
import { and, eq, or } from "drizzle-orm";

export type RenderResult = { home: string; mcpConfigPath: string };

/**
 * Render a per-run $HOME dir that wires the installed MCPs and skills
 * into the spawned Claude Code session.
 * - $home/.claude/mcp_servers.json   — assembled from mcp_installs rows
 * - $home/.claude/skills/<name>      — symlinks to skill_installs.storagePath
 */
export async function renderClaudeHome(input: {
  repo: string;
  runDir: string;
}): Promise<RenderResult> {
  const home = join(input.runDir, "claude-home");
  const claudeDir = join(home, ".claude");
  const skillsDir = join(claudeDir, "skills");
  await mkdir(skillsDir, { recursive: true });

  const db = createDb();

  // MCPs: global + repo-scoped enabled
  const mcps = await db
    .select()
    .from(mcpInstalls)
    .where(
      and(
        eq(mcpInstalls.enabled, true),
        or(
          eq(mcpInstalls.scope, "global"),
          and(eq(mcpInstalls.scope, "repo"), eq(mcpInstalls.repo, input.repo)),
        ),
      ),
    );

  const mcpServers: Record<string, unknown> = {};
  for (const m of mcps) {
    const env = Object.fromEntries((m.envKeys ?? []).map((k) => [k, process.env[k] ?? ""]));
    mcpServers[m.catalogId] =
      m.transport === "stdio" ? { command: m.command, args: m.args ?? [], env } : { url: m.url };
  }
  const mcpConfigPath = join(claudeDir, "mcp_servers.json");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });

  // Skills: global + repo-scoped enabled
  const skills = await db
    .select()
    .from(skillInstalls)
    .where(
      and(
        eq(skillInstalls.enabled, true),
        or(
          eq(skillInstalls.scope, "global"),
          and(eq(skillInstalls.scope, "repo"), eq(skillInstalls.repo, input.repo)),
        ),
      ),
    );
  for (const s of skills) {
    await symlink(s.storagePath, join(skillsDir, s.name)).catch(() => {
      /* already exists or unreachable; ignore */
    });
  }

  return { home, mcpConfigPath };
}
