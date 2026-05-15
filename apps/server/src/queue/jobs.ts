export const JOB_TRIAGE = "triage" as const;
export const JOB_AGENT = "agent" as const;

export type TriageJob = { alertId: string };
export type AgentJob = { alertId: string; runId: string; repo: string };

export type JobNameToData = {
  [JOB_TRIAGE]: TriageJob;
  [JOB_AGENT]: AgentJob;
};

export type JobName = keyof JobNameToData;
