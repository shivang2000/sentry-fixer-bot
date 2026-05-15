/**
 * Test fixtures: minimal Sentry "issue_alert" webhook payload + helpers.
 */

export type SentryIssueAlertPayload = {
  action: "created" | "resolved" | "assigned";
  data: {
    issue: {
      id: string;
      title: string;
      level: string;
      project: { slug: string };
      metadata?: Record<string, string>;
    };
    event?: {
      release?: string;
      tags?: Array<[string, string]>;
    };
  };
  installation: { uuid: string };
};

export function makeSentryAlert(
  overrides: Partial<SentryIssueAlertPayload> = {},
): SentryIssueAlertPayload {
  return {
    action: "created",
    data: {
      issue: {
        id: "1234567890",
        title: "TypeError: Cannot read properties of undefined (reading 'foo')",
        level: "error",
        project: { slug: "demo-app" },
        metadata: {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'foo')",
        },
      },
      event: { release: "v1.2.3" },
    },
    installation: { uuid: "00000000-0000-0000-0000-000000000000" },
    ...overrides,
  };
}
