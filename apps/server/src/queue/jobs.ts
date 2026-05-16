export const JOB_TRIAGE = "triage" as const;
export const JOB_AGENT = "agent" as const;
export const JOB_SENTRY_POLL = "sentry-poll" as const;

export type TriageJob = { alertId: string };
export type AgentJob = { alertId: string; runId: string; repo: string };
export type SentryPollJob = Record<string, never>;

export type JobNameToData = {
  [JOB_TRIAGE]: TriageJob;
  [JOB_AGENT]: AgentJob;
  [JOB_SENTRY_POLL]: SentryPollJob;
};

export type JobName = keyof JobNameToData;
