import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "@sentry-fixer-bot/db";
import { skillInstalls } from "@sentry-fixer-bot/db/schema/admin";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { adminProcedure, protectedProcedure, router } from "../index";
import { runCommand } from "../run/npm-runner";
import { SKILLS_CATALOG } from "../skills-catalog";
import { safeExtractZip, validateZipBuffer } from "../skills-zip";

function defaultSkillsDir(): string {
  if (process.env.SFB_SKILLS_DIR) return process.env.SFB_SKILLS_DIR;
  if (process.env.SFB_STATE_DIR) return `${process.env.SFB_STATE_DIR}/skills`;
  return "/var/lib/sfb/skills";
}

const SKILLS_DIR = defaultSkillsDir();
const SH_BASE = "https://www.skills.sh";
const SH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const SCOPE = z.enum(["global", "repo"]);

const shCache = new Map<string, { at: number; data: unknown }>();

function builtinSourceDir(id: string): string {
  // resolve from this file's location so the package works in dev + bundled output
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "skills-catalog", id);
}

export const skillsRouter = router({
  catalog: protectedProcedure.query(() => SKILLS_CATALOG),

  list: protectedProcedure.query(async () => {
    const db = createDb();
    return db.select().from(skillInstalls).orderBy(skillInstalls.createdAt);
  }),

  installBuiltin: adminProcedure
    .input(
      z.object({
        catalogId: z.string(),
        scope: SCOPE,
        repo: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const entry = SKILLS_CATALOG.find((c) => c.id === input.catalogId);
      if (!entry) throw new Error("unknown_catalog_id");
      if (input.scope === "repo" && !input.repo) {
        throw new Error("repo_required_for_repo_scope");
      }

      const db = createDb();
      const sourceDir = builtinSourceDir(entry.id);
      const installId = crypto.randomUUID();
      const target = join(SKILLS_DIR, installId);
      await mkdir(target, { recursive: true });
      await cp(sourceDir, target, { recursive: true });

      const inserted = await db
        .insert(skillInstalls)
        .values({
          id: installId,
          scope: input.scope,
          repo: input.repo ?? null,
          sourceType: "builtin",
          sourceRef: entry.id,
          name: entry.name,
          description: entry.description,
          storagePath: target,
          installedBy: ctx.user.id,
        })
        .returning();
      return inserted[0];
    }),

  installCustom: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        scope: SCOPE,
        repo: z.string().optional(),
        filename: z.string(),
        base64Zip: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.scope === "repo" && !input.repo) {
        throw new Error("repo_required_for_repo_scope");
      }
      const buf = Buffer.from(input.base64Zip, "base64");
      const validated = validateZipBuffer(buf);
      if (!validated.ok) {
        throw new Error(`zip_invalid:${validated.error.kind}`);
      }

      const installId = crypto.randomUUID();
      const target = join(SKILLS_DIR, installId);
      await mkdir(target, { recursive: true });
      safeExtractZip(validated.zip, target);

      const db = createDb();
      const inserted = await db
        .insert(skillInstalls)
        .values({
          id: installId,
          scope: input.scope,
          repo: input.repo ?? null,
          sourceType: "upload",
          sourceRef: input.filename,
          name: input.name,
          description: input.description ?? null,
          storagePath: target,
          installedBy: ctx.user.id,
        })
        .returning();
      return inserted[0];
    }),

  shList: protectedProcedure
    .input(z.object({ q: z.string().optional() }))
    .query(async ({ input }) => {
      const key = `list:${input.q ?? ""}`;
      const cached = shCache.get(key);
      if (cached && Date.now() - cached.at < SH_CACHE_TTL_MS) {
        return cached.data as { ok: true; results: unknown[] };
      }
      try {
        const url = new URL("/api/list", SH_BASE);
        if (input.q) url.searchParams.set("q", input.q);
        const resp = await fetch(url.toString(), {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) {
          return { ok: false as const, error: "skills_sh_api_unavailable" };
        }
        const data = (await resp.json()) as { results?: unknown[] };
        const out = { ok: true as const, results: data.results ?? [] };
        shCache.set(key, { at: Date.now(), data: out });
        return out;
      } catch {
        return { ok: false as const, error: "skills_sh_api_unavailable" };
      }
    }),

  installFromSh: adminProcedure
    .input(
      z.object({
        slug: z.string().min(1),
        scope: SCOPE,
        repo: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.scope === "repo" && !input.repo) {
        throw new Error("repo_required_for_repo_scope");
      }
      let buf: Buffer;
      try {
        const resp = await fetch(`${SH_BASE}/api/skills/${input.slug}/download`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          return { ok: false as const, error: "skills_sh_api_unavailable" };
        }
        buf = Buffer.from(await resp.arrayBuffer());
      } catch {
        return { ok: false as const, error: "skills_sh_api_unavailable" };
      }
      const validated = validateZipBuffer(buf);
      if (!validated.ok) {
        throw new Error(`zip_invalid:${validated.error.kind}`);
      }
      const installId = crypto.randomUUID();
      const target = join(SKILLS_DIR, installId);
      await mkdir(target, { recursive: true });
      safeExtractZip(validated.zip, target);

      const db = createDb();
      const inserted = await db
        .insert(skillInstalls)
        .values({
          id: installId,
          scope: input.scope,
          repo: input.repo ?? null,
          sourceType: "skills_sh",
          sourceRef: input.slug,
          name: input.slug,
          description: null,
          storagePath: target,
          installedBy: ctx.user.id,
        })
        .returning();
      return { ok: true as const, row: inserted[0] };
    }),

  installFromGit: adminProcedure
    .input(
      z.object({
        url: z
          .string()
          .url()
          .regex(/^https:\/\/(?:github|gitlab)\.com\//, "url_must_be_github_or_gitlab_https"),
        ref: z.string().optional(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        scope: SCOPE,
        repo: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      if (input.scope === "repo" && !input.repo) {
        throw new Error("repo_required_for_repo_scope");
      }
      const installId = crypto.randomUUID();
      const target = join(SKILLS_DIR, installId);
      await mkdir(target, { recursive: true });

      // Shallow clone into the install dir. The git allowlist in
      // runCommand only permits `git clone …`, so this is safe.
      const args = ["clone", "--depth", "1"];
      if (input.ref) args.push("--branch", input.ref);
      args.push(input.url, target);
      const result = await runCommand({
        command: `git ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`,
      });
      if (result.exitCode !== 0) {
        await rm(target, { recursive: true, force: true });
        throw new Error(
          `git_clone_failed:${result.stderr.slice(0, 500).replace(/\s+/g, " ").trim()}`,
        );
      }

      // Derive a display name: explicit override, else last URL segment.
      const inferredName =
        input.name ??
        input.url
          .replace(/\.git$/, "")
          .split("/")
          .filter(Boolean)
          .pop() ??
        "skill";

      const db = createDb();
      const inserted = await db
        .insert(skillInstalls)
        .values({
          id: installId,
          scope: input.scope,
          repo: input.repo ?? null,
          sourceType: "git",
          sourceRef: input.ref ? `${input.url}@${input.ref}` : input.url,
          name: inferredName,
          description: input.description ?? null,
          storagePath: target,
          installedBy: ctx.user.id,
        })
        .returning();
      return { ok: true as const, row: inserted[0] };
    }),

  uninstall: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const db = createDb();
      const rows = await db
        .select()
        .from(skillInstalls)
        .where(eq(skillInstalls.id, input.id))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("not_found");
      await db.delete(skillInstalls).where(eq(skillInstalls.id, input.id));
      try {
        await rm(row.storagePath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; DB row already gone
      }
      return { ok: true };
    }),
});
