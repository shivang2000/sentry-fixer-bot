import { getSentryToken } from "@alertforge/api/run/sentry-runner";

const SENTRY_BASE = "https://sentry.io/api/0";

/**
 * Post a comment on a Sentry issue. Token comes from getSentryToken
 * which prefers SENTRY_API_TOKEN env then falls back to `sentry auth
 * token` from the CLI (cli.sentry.dev). No-op when neither is set.
 */
export async function postIssueComment(issueId: string, body: string): Promise<string | null> {
  const token = await getSentryToken();
  if (!token) return null;
  // Sentry's issue-comments endpoint accepts {"text": "..."} at top
  // level. The older {"data":{"text":"..."}} envelope returns 400 on
  // the current API. We also swallow non-2xx so a comment failure
  // never crashes triage — the run row still records the outcome.
  const res = await fetch(`${SENTRY_BASE}/issues/${issueId}/comments/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: body }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ?? null;
}
