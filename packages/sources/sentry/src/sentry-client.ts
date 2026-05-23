import { getSentryToken } from "@alertforge/api/run/sentry-runner";

const SENTRY_BASE = "https://sentry.io/api/0";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSentryToken();
  if (!token) throw new Error("SENTRY_API_TOKEN is not configured");
  return { Authorization: `Bearer ${token}` };
}

export type SentryEvent = {
  id: string;
  title: string;
  platform?: string;
  release?: string;
  entries: Array<{ type: string; data: unknown }>;
  tags?: Array<{ key: string; value: string }>;
};

/** Fetch the latest event for an issue. Used by triage to read the stack trace. */
export async function getLatestEvent(issueId: string): Promise<SentryEvent | null> {
  const headers = await authHeaders();
  const res = await fetch(`${SENTRY_BASE}/issues/${issueId}/events/latest/`, {
    headers: { ...headers, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sentry getLatestEvent ${res.status}`);
  return (await res.json()) as SentryEvent;
}

/** Extract a normalized stack trace string for the prompt. */
export function extractStackTrace(event: SentryEvent): string {
  const exceptionEntry = event.entries.find((e) => e.type === "exception");
  if (!exceptionEntry) return "";
  const data = exceptionEntry.data as {
    values?: Array<{
      type: string;
      value: string;
      stacktrace?: {
        frames?: Array<{
          filename: string;
          function?: string;
          lineno?: number;
          context_line?: string;
        }>;
      };
    }>;
  };
  const lines: string[] = [];
  for (const v of data.values ?? []) {
    lines.push(`${v.type}: ${v.value}`);
    for (const f of v.stacktrace?.frames ?? []) {
      lines.push(`  at ${f.function ?? "<anonymous>"} (${f.filename}:${f.lineno ?? "?"})`);
      if (f.context_line) lines.push(`    > ${f.context_line.trim()}`);
    }
  }
  return lines.join("\n");
}
