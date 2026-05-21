/**
 * PipelineStep wrapper around @alertforge/step-secret-scan.
 *
 * Lists changed files in the workspace via `git diff --name-only HEAD`,
 * reads each one, and scans for the common stolen-token shapes (AWS,
 * GitHub, OpenAI, Anthropic, JWT). Writes findings to ctx.secret_scan
 * with a `blocked` flag honoring cfg.toggles.secretScanStrict.
 *
 * The legacy `scanWorkspace` lives in agent-job.ts; here we re-implement
 * the equivalent logic using the injectable runCommand seam so the
 * integration test can drive `git diff --name-only` without spawning
 * a subprocess. The actual `scanText` call is reused from the
 * @alertforge/step-secret-scan package unchanged.
 *
 * Reads:  ctx.workspace, ctx.agent_output (exit code — skip scan if
 *         agent never produced a diff)
 * Writes: ctx.secret_scan ({ findings, blocked })
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";
import { type SecretFinding, scanText } from "@alertforge/step-secret-scan";
import { type RunCommandFn, runCommand } from "../spawn";
import type { WorkspaceCtxValue } from "./workspace";

export interface SecretScanCtxValue {
  findings: SecretFinding[];
  blocked: boolean;
}

export interface WrapSecretScanOpts {
  /** Override for tests. Production routes through Bun.spawn via runCommand. */
  runScriptedCommand?: RunCommandFn;
  /** Override for tests. Production reads from disk. */
  readChangedFile?: (path: string) => Promise<string>;
}

const DEFAULT_READ: NonNullable<WrapSecretScanOpts["readChangedFile"]> = async (path) => {
  const file = Bun.file(path);
  return await file.text();
};

export async function runSecretScanStep(
  ctx: CtxStore,
  cfg: ResolvedConfig,
  _deps: StepDeps,
  opts: WrapSecretScanOpts = {},
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) {
    // No workspace means no diff to scan. Write a clean record so
    // downstream steps don't see `null`.
    await ctx.write("secret_scan", { findings: [], blocked: false });
    return;
  }
  const cmdFn = opts.runScriptedCommand ?? runCommand;
  const readFile = opts.readChangedFile ?? DEFAULT_READ;
  const out = await cmdFn(["git", "diff", "--name-only", "HEAD"], { cwd: workspace.dir });
  const names = out.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const findings: SecretFinding[] = [];
  for (const name of names) {
    try {
      const content = await readFile(`${workspace.dir}/${name}`);
      findings.push(...scanText(name, content));
    } catch {
      // file deleted or unreadable; skip
    }
  }
  const blocked = findings.length > 0 && cfg.toggles.secretScanStrict === "block";
  await ctx.write("secret_scan", { findings, blocked });
}

export async function skipSecretScanIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  return cfg.stopAfter === "budget";
}

export function wrapSecretScanStep(opts: WrapSecretScanOpts = {}): PipelineStep {
  return {
    name: "secret-scan",
    description: "Scan agent's diff for credential-shaped strings",
    skipIf: skipSecretScanIf,
    async run(ctx, cfg, deps) {
      await runSecretScanStep(ctx, cfg, deps, opts);
    },
  };
}
