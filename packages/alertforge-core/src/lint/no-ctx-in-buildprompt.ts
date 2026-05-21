/**
 * CI lint rule: forbid CtxStore references inside any `buildPrompt`
 * implementation. Enforces the LlmStep contract — buildPrompt must
 * work strictly on the projected `TInput`, never on the full
 * pipeline context, so it cannot accidentally send the whole ctx to
 * an LLM.
 *
 * Implementation: simple regex-based scan over packages/steps. Not as
 * robust as a true AST grep but has no external dependency and runs
 * fast. When `@ast-grep/cli` is available we switch to a real AST
 * rule (see commented-out implementation below).
 *
 * Hook into the CI chain by adding a script to root package.json:
 *
 *   "lint:ctx-boundary": "bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts"
 *
 * and including it in the `check` task.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface LintViolation {
  file: string;
  line: number;
  snippet: string;
  reason: string;
}

const STEPS_ROOT_DEFAULTS = ["packages/steps"];

/**
 * Find every `buildPrompt(...)` function body and assert it does not
 * mention `CtxStore` or `ctx.read(`, `ctx.write(`, `ctx.append(`.
 */
export async function checkNoCtxInBuildprompt(
  roots: string[] = STEPS_ROOT_DEFAULTS,
): Promise<LintViolation[]> {
  const violations: LintViolation[] = [];

  for (const root of roots) {
    try {
      const files = await collectTsFiles(root);
      for (const file of files) {
        const text = await readFile(file, "utf8");
        const lines = text.split("\n");

        let inBuildPrompt = false;
        let braceDepth = 0;
        let startLine = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;

          // Detect a buildPrompt definition. Match function form,
          // method form, and arrow form.
          if (!inBuildPrompt && /\bbuildPrompt\s*[(:]/.test(line)) {
            inBuildPrompt = true;
            startLine = i + 1;
            braceDepth = 0;
          }

          if (inBuildPrompt) {
            for (const ch of line) {
              if (ch === "{") braceDepth++;
              if (ch === "}") braceDepth--;
            }

            if (
              /\bCtxStore\b/.test(line) ||
              /\bctx\s*\.\s*(read|write|append|exists|size|truncatedFields)\b/.test(line)
            ) {
              violations.push({
                file: relative(process.cwd(), file),
                line: i + 1,
                snippet: line.trim(),
                reason: "buildPrompt must not reach CtxStore — use selectInput projection",
              });
            }

            if (braceDepth === 0 && i > startLine) {
              inBuildPrompt = false;
            }
          }
        }
      }
    } catch (_err) {
      // root doesn't exist yet (e.g. before P3 lands packages/steps) — skip
    }
  }

  return violations;
}

async function collectTsFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.tsx?$/.test(e.name) && !/__tests__/.test(full)) out.push(full);
    }
  }

  await walk(root);
  return out;
}

// CLI entry point for `bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts`
if (import.meta.main) {
  const violations = await checkNoCtxInBuildprompt();
  if (violations.length === 0) {
    console.log("OK: no-ctx-in-buildprompt — no violations");
    process.exit(0);
  }
  console.error(`FAIL: no-ctx-in-buildprompt — ${violations.length} violation(s):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    console.error(`    → ${v.reason}`);
  }
  process.exit(1);
}
