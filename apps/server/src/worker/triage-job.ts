import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts } from "@sentry-fixer-bot/db/schema/domain";
import { eq } from "drizzle-orm";
import { log } from "../log";
import { publishJob } from "../queue/boss";
import { JOB_AGENT, type TriageJob } from "../queue/jobs";
import { appendRunLog } from "../runs/log";
import { createRun, updateRun } from "../runs/persist";
import { extractStackTrace, getLatestEvent } from "../sentry/client";
import { postIssueComment } from "../sentry/comment";
import { classify } from "../triage/classify";
import { resolveOrCreateRepoConfig } from "../triage/resolve-repo";

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
  let cfg: (typeof cfgRows)[number] | undefined = cfgRows[0];

  // Auto-discover: if no repos_config row, gh-search the slug and
  // insert a sensible default. Operator can edit later via /repos.
  if (!cfg) {
    const created = await resolveOrCreateRepoConfig(alert.sentryProject).catch((e) => {
      log.warn(
        { project: alert.sentryProject, err: e instanceof Error ? e.message : e },
        "resolve repo failed",
      );
      return null;
    });
    if (created) {
      log.info({ project: alert.sentryProject, github: created.github }, "repo auto-registered");
      const fresh = await db
        .select()
        .from(reposConfig)
        .where(eq(reposConfig.id, created.id))
        .limit(1);
      cfg = fresh[0];
    }
  }

  // (runId not yet created here, log via runId below once we have it.)

  // Start a run row regardless of repo-configured (so unknown-repo alerts are visible)
  const runId = await createRun({
    alertId: alert.id,
    repo: cfg?.github,
    status: "running",
  });
  await appendRunLog({
    runId,
    level: "info",
    source: "triage",
    message: `Triage start. Project: ${alert.sentryProject}. Issue: ${alert.sentryIssueId}. Title: ${alert.title}`,
  });
  if (cfg) {
    await appendRunLog({
      runId,
      level: "info",
      source: "triage",
      message: `Matched repos_config row → ${cfg.github} (branch ${cfg.defaultBranch})`,
    });
  }

  // Fetch stack trace from Sentry (best effort)
  let stackTrace = "";
  try {
    const ev = await getLatestEvent(alert.sentryIssueId);
    stackTrace = ev ? extractStackTrace(ev) : "";
    await appendRunLog({
      runId,
      level: "info",
      source: "sentry",
      message: stackTrace
        ? `Fetched stack trace (${stackTrace.length} bytes).`
        : "Sentry issue had no exception event.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ alertId: alert.id, err: msg }, "sentry fetch failed");
    await appendRunLog({ runId, level: "warn", source: "sentry", message: `fetch failed: ${msg}` });
  }

  await appendRunLog({
    runId,
    level: "info",
    source: "triage",
    message: "Classifying via claude…",
  });
  const triage = await classify({ title: alert.title, stackTrace }).catch(async (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.error({ err: msg }, "classify failed");
    await appendRunLog({
      runId,
      level: "error",
      source: "triage",
      message: `classify failed: ${msg}`,
    });
    return null;
  });
  if (triage) {
    await appendRunLog({
      runId,
      level: "info",
      source: "triage",
      message: `Severity: ${triage.severity}. Suspected files: ${triage.suspectedFiles.join(", ") || "—"}. Summary: ${triage.summary}`,
    });
  }

  await updateRun(runId, {
    severity: triage?.severity ?? "medium",
    triageSummary: triage?.summary ?? "",
    suspectedFiles: triage?.suspectedFiles ?? [],
    stackTrace,
  });

  // Unknown repo → comment + stop
  if (!cfg) {
    await appendRunLog({
      runId,
      level: "warn",
      source: "triage",
      message: `No repos_config row for project "${alert.sentryProject}" and gh search returned no candidate. Skipping agent run.`,
    });
    await postIssueComment(
      alert.sentryIssueId,
      `sentry-fixer-bot: project "${alert.sentryProject}" is not in repos_config — add it to enable agent fixes.`,
    );
    await updateRun(runId, { status: "no_repo_match", endedAt: new Date() });
    return;
  }

  // Severity below threshold → triage-only
  if (!severityAllowed(triage?.severity ?? "medium", cfg.minSeverityToFix)) {
    await appendRunLog({
      runId,
      level: "info",
      source: "triage",
      message: `Severity ${triage?.severity} < min ${cfg.minSeverityToFix}. Triage-only, no agent fix.`,
    });
    await postIssueComment(
      alert.sentryIssueId,
      `sentry-fixer-bot: triaged as ${triage?.severity}. Below configured min severity (${cfg.minSeverityToFix}); not attempting a fix.`,
    );
    await updateRun(runId, { status: "triaged_only", endedAt: new Date() });
    return;
  }

  await appendRunLog({
    runId,
    level: "info",
    source: "triage",
    message: `Enqueuing agent job → ${cfg.github}`,
  });
  await publishJob(JOB_AGENT, { alertId: alert.id, runId, repo: cfg.github });
}
