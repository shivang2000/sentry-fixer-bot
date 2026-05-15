/**
 * Worker entry: registers pg-boss handlers for triage + agent jobs.
 * Run via `bun apps/server/src/worker/index.ts` (separate process from
 * the HTTP server; pg-boss coordinates via Postgres).
 */
import { log } from "../log";
import { getBoss } from "../queue/boss";
import { type AgentJob, JOB_AGENT, JOB_TRIAGE, type TriageJob } from "../queue/jobs";
import { processAgentJob } from "./agent-job";
import { processTriageJob } from "./triage-job";

async function main(): Promise<void> {
  const boss = await getBoss();

  await boss.work<TriageJob>(JOB_TRIAGE, async (jobs) => {
    for (const job of jobs) {
      log.info({ id: job.id, payload: job.data }, "triage job picked up");
      await processTriageJob(job.data);
    }
  });

  await boss.work<AgentJob>(JOB_AGENT, async (jobs) => {
    for (const job of jobs) {
      log.info({ id: job.id, payload: job.data }, "agent job picked up");
      await processAgentJob(job.data);
    }
  });

  log.info("worker ready");
}

await main();
