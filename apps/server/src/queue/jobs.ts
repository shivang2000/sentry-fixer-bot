export const JOB_TRIAGE = "triage" as const;
export const JOB_AGENT = "agent" as const;
export const JOB_SENTRY_POLL = "sentry-poll" as const;
export const JOB_HEALTH_CHECK = "health-check" as const;
export const JOB_PR_FOLLOWUP = "pr-followup" as const;
export const JOB_PR_COMMENT_POLL = "pr-comment-poll" as const;

export type TriageJob = { alertId: string };
export type AgentJob = { alertId: string; runId: string; repo: string };
export type SentryPollJob = { lookbackMinutes?: number };
export type HealthCheckJob = Record<string, never>;

/**
 * One job per (PR, instruction-comment). The follow-up worker uses
 * `prId` to look up the original run + repo + branch and `commentId` /
 * `commentBody` to compose the prompt for the second agent pass.
 * `commentCreatedAt` is what advances `prs.lastReviewedCommentAt` after
 * the worker finishes, so duplicate webhook + cron deliveries are
 * idempotent.
 */
export type PrFollowupJob = {
  prId: string;
  commentId: string;
  commentBody: string;
  commentAuthor: string;
  commentCreatedAt: string;
};

export type PrCommentPollJob = Record<string, never>;

export type JobNameToData = {
  [JOB_TRIAGE]: TriageJob;
  [JOB_AGENT]: AgentJob;
  [JOB_SENTRY_POLL]: SentryPollJob;
  [JOB_HEALTH_CHECK]: HealthCheckJob;
  [JOB_PR_FOLLOWUP]: PrFollowupJob;
  [JOB_PR_COMMENT_POLL]: PrCommentPollJob;
};

export type JobName = keyof JobNameToData;
