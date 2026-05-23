import { getSentryOrgSlug, getSentryToken } from "@alertforge/api/run/sentry-runner";
import { createDb } from "@alertforge/db";
import { reposConfig } from "@alertforge/db/schema/admin";
import { upsertAlert } from "@alertforge/source-sentry";
import { eq } from "drizzle-orm";
import { log } from "../log";
import { publishJob } from "../queue/boss";
import { JOB_TRIAGE } from "../queue/jobs";

const SENTRY_BASE = "https://sentry.io/api/0";

type SentryIssue = {
  id: string;
  shortId: string;
  title: string;
  level: string;
  firstSeen: string;
  lastSeen: string;
  metadata?: { type?: string; value?: string };
};

async function fetchRecentIssues(project: string, lookbackMinutes: number): Promise<SentryIssue[]> {
  const token = await getSentryToken();
  const org = await getSentryOrgSlug();
  if (!token || !org) return [];
  const url = new URL(`${SENTRY_BASE}/projects/${org}/${project}/issues/`);
  url.searchParams.set("statsPeriod", `${lookbackMinutes}m`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("query", "is:unresolved");
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`sentry_issues_fetch_failed:${res.status}`);
  }
  return (await res.json()) as SentryIssue[];
}

/**
 * Poll Sentry on a configurable cadence (scheduled in worker/index.ts).
 * Enqueues triage for issues we haven't seen yet. Uses a poll-prefixed
 * dedup_key so webhook arrivals + poll discoveries don't collide.
 *
 * `data.lookbackMinutes` flows in from the pg-boss schedule payload so a
 * 1-hour cron actually asks Sentry for the last hour, not 15 minutes.
 * Fallback is 15 for legacy / runNow callers.
 */
export async function processSentryPollJob(data: { lookbackMinutes?: number } = {}): Promise<void> {
  const token = await getSentryToken();
  const org = await getSentryOrgSlug();
  if (!token || !org) {
    log.warn("[sentry-poll] no sentry token/org (run `sentry auth login` or set SENTRY_*)");
    return;
  }
  const lookbackMinutes = data.lookbackMinutes ?? 15;
  const db = createDb();
  const repos = await db
    .select({ sentryProject: reposConfig.sentryProject })
    .from(reposConfig)
    .where(eq(reposConfig.enabled, true));

  if (repos.length === 0) {
    log.info("[sentry-poll] no enabled repos");
    return;
  }

  let enqueued = 0;
  for (const r of repos) {
    let issues: SentryIssue[];
    try {
      issues = await fetchRecentIssues(r.sentryProject, lookbackMinutes);
    } catch (err) {
      log.warn(
        { project: r.sentryProject, err: err instanceof Error ? err.message : err },
        "[sentry-poll] fetch failed",
      );
      continue;
    }
    for (const issue of issues) {
      // Use a poll-prefixed dedup so a separately-arriving webhook with its
      // own dedup_key doesn't collide; the agent run still deduplicates on
      // (project, issue) downstream.
      const dedupKey = `poll:${r.sentryProject}:${issue.id}`;
      try {
        const alert = await upsertAlert({
          sentryIssueId: issue.id,
          sentryProject: r.sentryProject,
          fingerprint: issue.shortId,
          dedupKey,
          title: issue.title,
          level: issue.level,
          firstSeenAt: new Date(issue.firstSeen),
          lastSeenAt: new Date(issue.lastSeen),
          rawPayloadS3: `poll:${dedupKey}`,
        });
        if (alert.isNew) {
          await publishJob(JOB_TRIAGE, { alertId: alert.id });
          enqueued += 1;
        }
      } catch (err) {
        log.warn(
          { issueId: issue.id, err: err instanceof Error ? err.message : err },
          "[sentry-poll] upsert/publish failed",
        );
      }
    }
  }
  if (enqueued > 0) {
    log.info({ enqueued }, "[sentry-poll] tick");
  }
}
