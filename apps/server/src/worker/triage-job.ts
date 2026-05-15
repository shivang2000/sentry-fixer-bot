import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { log } from "../log";
import { publishJob } from "../queue/boss";
import { JOB_AGENT, type TriageJob } from "../queue/jobs";
import { createRun, updateRun } from "../runs/persist";
import { extractStackTrace, getLatestEvent } from "../sentry/client";
import { postIssueComment } from "../sentry/comment";
import { classify } from "../triage/classify";

const SEVERITY_ORDER = ["low", "medium", "high", "critical"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

function severityAllowed(triaged: Severity, min: string): boolean {
  const t = SEVERITY_ORDER.indexOf(triaged);
  const m = SEVERITY_ORDER.indexOf(min as Severity);
  return t >= 0 && m >= 0 && t >= m;
}

export async function processTriageJob(payload: TriageJob): Promise<void> {
  const db = createDb();
  const alertRows = await db.select().from(alerts).where(eq(alerts.id, payload.alertId)).limit(1);
  const alert = alertRows[0];
  if (!alert) {
    log.warn({ alertId: payload.alertId }, "triage: alert not found");
    return;
  }

  const cfgRows = await db
    .select()
    .from(reposConfig)
    .where(eq(reposConfig.sentryProject, alert.sentryProject))
    .limit(1);
  const cfg = cfgRows[0];

  // Start a run row regardless of repo-configured (so unknown-repo alerts are visible)
  const runId = await createRun({
    alertId: alert.id,
    repo: cfg?.github,
    status: "running",
  });

  // Fetch stack trace from Sentry (best effort)
  let stackTrace = "";
  try {
    const ev = await getLatestEvent(alert.sentryIssueId);
    stackTrace = ev ? extractStackTrace(ev) : "";
  } catch (e) {
    log.warn({ alertId: alert.id, err: e instanceof Error ? e.message : e }, "sentry fetch failed");
  }

  // Classify
  const triage = await classify({ title: alert.title, stackTrace }).catch((e) => {
    log.error({ err: e instanceof Error ? e.message : e }, "classify failed");
    return null;
  });

  await updateRun(runId, {
    severity: triage?.severity ?? "medium",
    triageSummary: triage?.summary ?? "",
    suspectedFiles: triage?.suspectedFiles ?? [],
    stackTrace,
  });

  // Unknown repo → comment + stop
  if (!cfg) {
    await postIssueComment(
      alert.sentryIssueId,
      `sentry-fixer-bot: project "${alert.sentryProject}" is not in repos_config — add it to enable agent fixes.`,
    );
    await updateRun(runId, { status: "no_repo_match", endedAt: new Date() });
    return;
  }

  // Severity below threshold → triage-only
  if (!severityAllowed(triage?.severity ?? "medium", cfg.minSeverityToFix)) {
    await postIssueComment(
      alert.sentryIssueId,
      `sentry-fixer-bot: triaged as ${triage?.severity}. Below configured min severity (${cfg.minSeverityToFix}); not attempting a fix.`,
    );
    await updateRun(runId, { status: "triaged_only", endedAt: new Date() });
    return;
  }

  // Enqueue agent job
  await publishJob(JOB_AGENT, { alertId: alert.id, runId, repo: cfg.github });
}
