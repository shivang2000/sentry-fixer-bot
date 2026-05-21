/**
 * Archive a finished run's ctx/ directory to S3.
 *
 * Walks `ctx.dir`, uploads each file under `runs/<runId>/ctx/<basename>`,
 * and returns the S3 prefix so the caller can persist it on the runs
 * row (`ctx_archive_s3`). After upload, the local ctx dir is removed
 * via `cleanupCtxDir`.
 *
 * Best-effort: archive failure does NOT abort the worker — we log and
 * continue. The disk store survives container restarts (worker host
 * volume); the hourly orphan-prune cron sweeps unfinished runs.
 *
 * V1 uses per-file uploads. Spec mentions `tar -I zstd` but tar+zstd
 * requires extra binaries we don't ship; per-file is functionally
 * equivalent (S3 prefix list ≡ tarball contents) and simpler.
 */

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CtxStore, S3PutClient } from "@alertforge/core";

export async function archiveCtxToS3(input: {
  ctx: CtxStore;
  s3: S3PutClient;
  log?: (level: "warn" | "info" | "error", message: string) => void;
}): Promise<string | null> {
  try {
    const entries = await readdir(input.ctx.dir, { withFileTypes: true });
    const prefix = `runs/${input.ctx.runId}/ctx`;
    for (const e of entries) {
      if (!e.isFile()) continue;
      const path = join(input.ctx.dir, e.name);
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const body = await file.text();
      const contentType = e.name.endsWith(".json")
        ? "application/json"
        : e.name.endsWith(".patch")
          ? "text/x-diff"
          : "text/plain";
      await input.s3.put(`${prefix}/${e.name}`, body, contentType);
    }
    return prefix;
  } catch (err) {
    input.log?.("warn", `ctx archive failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function cleanupCtxDir(ctx: CtxStore): Promise<void> {
  try {
    await rm(ctx.dir, { recursive: true, force: true });
  } catch {
    // Best-effort; the hourly orphan-prune cron is the fallback.
  }
}
