import { env } from "@sentry-fixer-bot/env/server";

const SENTRY_BASE = "https://sentry.io/api/0";

/**
 * Post a comment on a Sentry issue. Uses internal-integration token.
 * No-op (returns null) when Sentry isn't configured (dev path).
 */
export async function postIssueComment(issueId: string, body: string): Promise<string | null> {
  if (!env.SENTRY_API_TOKEN) return null;
  const res = await fetch(`${SENTRY_BASE}/issues/${issueId}/comments/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SENTRY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: { text: body } }),
  });
  if (!res.ok) throw new Error(`Sentry postIssueComment ${res.status}`);
  const json = (await res.json()) as { id: string };
  return json.id;
}
