import { createDb } from "@alertforge/db";
import { repos } from "@alertforge/db/schema/admin";

type SpawnedProc = {
  stdout?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};
type BunG = {
  spawn(
    argv: string[],
    opts: { env?: Record<string, string | undefined>; cwd?: string; stdout?: "pipe" },
  ): SpawnedProc;
};
const Bun = (globalThis as unknown as { Bun: BunG }).Bun;

/**
 * Try to discover a GitHub repo whose name matches the Sentry project
 * slug. Falls back to a token-based heuristic so e.g. "developer-
 * portal-ui" → owner/developer-portal-ui in any org the gh CLI can
 * see. Returns null if no plausible match.
 *
 * We deliberately don't fetch Sentry's own /projects/<slug>/repos/
 * endpoint — that requires the repo to be explicitly linked inside
 * Sentry, which most operators won't have done. gh repo search is
 * cheaper and works in practice.
 */
async function ghSearchRepo(
  slug: string,
): Promise<{ nameWithOwner: string; defaultBranch: string } | null> {
  const stateHome = `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/home`;
  // `gh search repos` JSON exposes `fullName` (owner/repo) — not the
  // `nameWithOwner` field that `gh repo list` uses. Same data, just
  // a different key. Defensive: also accept nameWithOwner if a future
  // gh release adds it.
  const proc = Bun.spawn(
    ["gh", "search", "repos", slug, "--limit", "20", "--json", "name,fullName,defaultBranch"],
    {
      env: { ...process.env, HOME: stateHome },
      stdout: "pipe",
    },
  );
  const out = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
  const exit = await proc.exited;
  if (exit !== 0) return null;
  let parsed: Array<{
    name: string;
    fullName?: string;
    nameWithOwner?: string;
    defaultBranch: string;
  }>;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  const exact = parsed.find((r) => r.name.toLowerCase() === slug.toLowerCase());
  const pick = exact ?? parsed[0];
  if (!pick) return null;
  const fullName = pick.fullName ?? pick.nameWithOwner;
  if (!fullName) return null;
  return { nameWithOwner: fullName, defaultBranch: pick.defaultBranch || "main" };
}

/**
 * Resolve a Sentry project slug to a `repos` row, auto-inserting
 * one when gh can find a matching repo. Returns null when no plausible
 * GitHub repo is found — caller falls back to no_repo_match.
 */
export async function resolveOrCreateRepoConfig(sentryProject: string): Promise<{
  id: string;
  github: string;
  defaultBranch: string;
  testCommand: string | null;
  prReviewers: string[];
  minSeverityToFix: string;
  dailyTokenCap: number;
  dailyCostCapCents: number;
} | null> {
  // Caller has already confirmed no existing row matches sentryProject;
  // skip straight to gh search.
  const db = createDb();
  const hit = await ghSearchRepo(sentryProject);
  if (!hit) return null;
  const inserted = await db
    .insert(repos)
    .values({
      sentryProject,
      github: hit.nameWithOwner,
      defaultBranch: hit.defaultBranch,
      // Leave testCommand null; the agent worker auto-detects from the
      // worktree (package.json / pyproject.toml / pom.xml / build.gradle
      // / go.mod / Cargo.toml / Gemfile / composer.json / Makefile) and
      // skips the gate if nothing's there. Operator can still override
      // via /repos/<id>.
      testCommand: null,
      prReviewers: [],
      dailyTokenCap: 1_000_000,
      dailyCostCapCents: 500,
      minSeverityToFix: "medium",
      enabled: true,
    })
    .returning();
  const row = inserted[0];
  if (!row) return null;
  return {
    id: row.id,
    github: row.github,
    defaultBranch: row.defaultBranch,
    testCommand: row.testCommand,
    prReviewers: row.prReviewers as string[],
    minSeverityToFix: row.minSeverityToFix,
    dailyTokenCap: row.dailyTokenCap,
    dailyCostCapCents: row.dailyCostCapCents,
  };
}
