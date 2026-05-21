import type { PipelineNotification } from "@alertforge/core";

const SEVERITY_EMOJI: Record<string, string> = {
  low: ":large_blue_circle:",
  medium: ":large_yellow_circle:",
  high: ":large_orange_circle:",
  critical: ":red_circle:",
};

const STATUS_EMOJI: Record<string, string> = {
  pr_opened: ":sparkles:",
  triage_only: ":mag:",
  failed: ":x:",
  budget_blocked: ":no_entry:",
  duplicate_pr: ":recycle:",
  digest: ":bar_chart:",
};

/**
 * Render an Alertforge notification as a Slack Block Kit payload.
 * Kept small + readable; one section per logical group so future
 * channels can clone the shape with minor tweaks.
 */
export function renderSlackBlocks(
  notification: PipelineNotification,
  mentionUserIds?: string[],
): Array<Record<string, unknown>> {
  const sev = notification.severity ?? "medium";
  const sevEmoji = SEVERITY_EMOJI[sev] ?? "";
  const statusEmoji = STATUS_EMOJI[notification.status] ?? "";
  const mentions = (mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
  const headerText = `${statusEmoji} ${notification.alert.title.slice(0, 140)}`;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText.slice(0, 150) },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Severity*\n${sevEmoji} ${sev}` },
        { type: "mrkdwn", text: `*Status*\n${notification.status}` },
        {
          type: "mrkdwn",
          text: `*Cost*\n${
            notification.costCents !== undefined
              ? `$${(notification.costCents / 100).toFixed(2)}`
              : "—"
          }`,
        },
        {
          type: "mrkdwn",
          text: `*Confidence*\n${
            notification.confidence !== undefined
              ? `${Math.round(notification.confidence * 100)}%`
              : "—"
          }`,
        },
      ],
    },
  ];

  if (notification.triageSummary) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Triage*\n${notification.triageSummary.slice(0, 1500)}`,
      },
    });
  }

  const actionElements: Array<Record<string, unknown>> = [];
  if (notification.prUrl) {
    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "Open PR" },
      url: notification.prUrl,
      style: "primary",
    });
  }
  if (actionElements.length > 0) {
    blocks.push({ type: "actions", elements: actionElements });
  }

  if (mentions) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: mentions }],
    });
  }

  return blocks;
}

/**
 * Plain-text fallback for Slack clients that don't render Block Kit
 * (notification previews, screen readers, mobile push). Mirrors what
 * a human would see in the card form.
 */
export function renderSlackFallbackText(
  notification: PipelineNotification,
  mentionUserIds?: string[],
): string {
  const mentions = (mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
  const prefix = mentions ? `${mentions} ` : "";
  const sev = notification.severity ?? "medium";
  return `${prefix}[${notification.status}] (${sev}) ${notification.alert.title}${
    notification.prUrl ? ` — ${notification.prUrl}` : ""
  }`;
}
