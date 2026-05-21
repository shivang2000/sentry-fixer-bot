#!/usr/bin/env bun
/**
 * CI lint hook for the no-ctx-in-buildprompt rule. Scans the wrapper
 * source under apps/server/src/pipeline/wrappers/ AND the
 * packages/steps/<name>/ tree, calling the shared lint impl in
 * @alertforge/core/lint. Exits non-zero on any violation so a PR
 * touching wrapper buildPrompt code can't accidentally leak the
 * full CtxStore into a model call.
 *
 * Invoked from the root via:
 *   bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts
 * (already wired) plus additionally on the apps/server wrappers:
 *   bun apps/server/src/pipeline/lint-check.ts
 *
 * Both share the same impl; this file just supplies the wrappers/ root.
 */

import { join } from "node:path";
import { checkNoCtxInBuildprompt } from "@alertforge/core";

const roots = [
  join(import.meta.dir, "wrappers"),
  // Also re-scan the steps tree as a belt-and-braces guard.
  join(import.meta.dir, "..", "..", "..", "..", "packages", "steps"),
];

const violations = await checkNoCtxInBuildprompt(roots);
if (violations.length === 0) {
  console.log("OK: no-ctx-in-buildprompt — wrappers + steps clean");
  process.exit(0);
}
console.error(`FAIL: no-ctx-in-buildprompt — ${violations.length} violation(s):`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
  console.error(`    → ${v.reason}`);
}
process.exit(1);
