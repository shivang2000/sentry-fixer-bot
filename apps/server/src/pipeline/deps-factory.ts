/**
 * Build the StepDeps the production worker hands to runPipeline.
 *
 * Centralising this here means apps/server/src/worker/agent-job.ts is
 * a thin orchestrator (P3c.2) — it constructs the deps, calls
 * runPipeline, and handles the finally-block cleanup. The wrappers
 * are oblivious to the source of their deps; tests build their own
 * stubbed deps inline in the integration test.
 *
 * Curries `runId` into `appendLog` so wrappers can call `deps.appendLog
 * ({ level, source, message })` without each one knowing the runId
 * separately — the deps factory binds it once.
 */

import { registry, type S3PutClient, type StepDeps } from "@alertforge/core";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createDb } from "@sentry-fixer-bot/db";
import { env } from "@sentry-fixer-bot/env/server";
import { resolveGithubToken } from "../github/auth";
import { log } from "../log";
import { appendRunLog } from "../runs/log";

export interface BuildPipelineDepsInput {
  runId: string;
}

let cachedS3: S3Client | null = null;
function getS3Client(): S3Client {
  if (cachedS3) return cachedS3;
  cachedS3 = new S3Client({ region: env.S3_REGION ?? "us-east-1" });
  return cachedS3;
}

function makeS3Adapter(): S3PutClient {
  return {
    async put(key, body, contentType) {
      const bucket = env.S3_BUCKET;
      if (!bucket) {
        // No bucket configured (dev) — return a sentinel so callers
        // can still link a "local://" URI in the runs row without a
        // separate dev branch.
        return `local://${key}`;
      }
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: typeof body === "string" ? body : body,
        ContentType: contentType ?? "application/octet-stream",
      });
      await getS3Client().send(cmd);
      return `s3://${bucket}/${key}`;
    },
  };
}

/**
 * Construct the StepDeps bundle. Per-run scope (runId) is curried into
 * appendLog so wrappers don't have to know the runId separately.
 */
export function buildPipelineDeps(input: BuildPipelineDepsInput): StepDeps {
  return {
    modelProvider: makeNoopModelProvider(),
    log,
    sources: registry.sources,
    channels: registry.channels,
    appendLog: async (line) =>
      appendRunLog({
        runId: input.runId,
        level: line.level,
        source: line.source,
        message: line.message,
      }),
    resolveToken: resolveGithubToken,
    db: createDb(),
    s3: makeS3Adapter(),
  };
}

/**
 * Placeholder ModelProvider for production. The wrapClassifyStep and
 * other LlmStep wrappers will route through this provider once a real
 * Anthropic-SDK provider is plugged in (P3c.2+ wiring). Today, the
 * legacy classify path was a subprocess `claude` CLI call; the new
 * abstraction lets us swap in the SDK at the deps-factory boundary
 * without touching every wrapper.
 *
 * Returns a placeholder JSON envelope on `complete()`. In production
 * the worker can substitute a real provider before calling runPipeline.
 */
function makeNoopModelProvider() {
  return {
    name: "noop",
    async complete(args: { model: string }) {
      // Default placeholder. apps/server may replace this with a real
      // Anthropic-SDK provider once wired; see ADR-0001 + the
      // pluggable-pipeline-design spec.
      return JSON.stringify({ model: args.model, response: "(placeholder)" });
    },
  };
}
