import type { DigestPayload, PipelineNotification } from "@alertforge/core";

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
 *
 * When `notification.status === 'digest'` we dispatch to
 * `renderDigestBlocks` for a roll-up layout instead of the per-event
 * card. Other channel adapters can follow the same dispatch pattern.
 */
export function renderSlackBlocks(
  notification: PipelineNotification,
  mentionUserIds?: string[],
): Array<Record<string, unknown>> {
  if (notification.status === "digest") {
    return renderDigestBlocks(notification, mentionUserIds);
  }
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
 *
 * For digest notifications we synthesize a short summary line — the
 * full layout lives in the blocks payload.
 */
export function renderSlackFallbackText(
  notification: PipelineNotification,
  mentionUserIds?: string[],
): string {
  const mentions = (mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
  const prefix = mentions ? `${mentions} ` : "";
  if (notification.status === "digest") {
    const body = notification.digestBody;
    if (!body) return `${prefix}Alertforge digest (no data)`;
    const mergedRate =
      body.fixesAttempted > 0
        ? Math.round(((body.mergedClean + body.mergedWithEdits) / body.fixesAttempted) * 100)
        : 0;
    return `${prefix}Alertforge digest — ${notification.alert.title} · ${body.alertCount} alerts, ${body.fixesAttempted} PRs, ${mergedRate}% merged`;
  }
  const sev = notification.severity ?? "medium";
  return `${prefix}[${notification.status}] (${sev}) ${notification.alert.title}${
    notification.prUrl ? ` — ${notification.prUrl}` : ""
  }`;
}

/**
 * Digest layout. Header → roll-up fields → top fingerprints →
 * (optional) suggested action. No buttons; digests are informational.
 *
 * Guard: if `digestBody` is missing on a digest-status notification we
 * render a minimal placeholder rather than throw — the cron sweep
 * shouldn't die over one bad row.
 */
function renderDigestBlocks(
  notification: PipelineNotification,
  mentionUserIds?: string[],
): Array<Record<string, unknown>> {
  const body: DigestPayload | undefined = notification.digestBody;
  const titleSuffix = notification.alert?.title
    ? notification.alert.title.replace(/^Daily digest\s*[—-]\s*/i, "")
    : notification.triggerId;
  const header = `${STATUS_EMOJI.digest} Alertforge digest — ${titleSuffix}, last 7d`;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: header.slice(0, 150) },
    },
  ];

  if (!body) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "_Digest body missing — check daily-digest cron logs._",
      },
    });
    return blocks;
  }

  const anyMerged = body.mergedClean + body.mergedWithEdits;
  const mergeRatePct =
    body.fixesAttempted > 0 ? Math.round((anyMerged / body.fixesAttempted) * 100) : 0;
  const mergeCleanPct =
    body.fixesAttempted > 0 ? Math.round((body.mergedClean / body.fixesAttempted) * 100) : 0;
  const costStr = `$${(body.costCents / 100).toFixed(2)} / $${(body.capCents / 100).toFixed(2)}`;
  const capPct = body.capCents > 0 ? Math.round((body.costCents / body.capCents) * 100) : 0;

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Alerts*\n${body.alertCount}` },
      { type: "mrkdwn", text: `*PRs opened*\n${body.fixesAttempted}` },
      {
        type: "mrkdwn",
        text: `*Merge rate (clean)*\n${mergeRatePct}% (${mergeCleanPct}% clean)`,
      },
      { type: "mrkdwn", text: `*Cost vs cap*\n${costStr} (${capPct}%)` },
    ],
  });

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Merged clean*\n${body.mergedClean}` },
      { type: "mrkdwn", text: `*Merged with edits*\n${body.mergedWithEdits}` },
      { type: "mrkdwn", text: `*Closed unmerged*\n${body.closedUnmerged}` },
      { type: "mrkdwn", text: `*Still open*\n${body.open}` },
    ],
  });

  if (body.topFingerprints.length > 0) {
    const lines = body.topFingerprints.map(
      (fp, i) => `${i + 1}. ${fp.title.slice(0, 120)} ×${fp.count} (${fp.closed} closed)`,
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Top recurring fingerprints*\n${lines.join("\n")}`,
      },
    });
  }

  if (body.suggestedAction) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested action*\n${body.suggestedAction}`,
      },
    });
  }

  const mentions = (mentionUserIds ?? []).map((id) => `<@${id}>`).join(" ");
  if (mentions) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: mentions }],
    });
  }

  return blocks;
}
