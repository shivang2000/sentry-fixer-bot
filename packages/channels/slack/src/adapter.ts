import type { ChannelAdapter, PipelineNotification } from "@alertforge/core";
import { type SlackConfig, slackConfigSchema } from "./config.schema";
import { renderSlackBlocks, renderSlackFallbackText } from "./render-blocks";

const SETUP_GUIDE = `# Slack channel — setup guide

1. In your Slack workspace, create an **Incoming Webhook**
   (Workspace settings → App Directory → Incoming Webhooks → Add to Slack).
2. Pick the channel to post to (e.g. \`#oncall-backend\`).
3. Copy the generated webhook URL.
4. In Alertforge UI → Trigger → Channels tab → **+ Add channel** → **Slack**.
5. Paste the webhook URL into the form. Optionally pin a channel override
   or add user IDs (\`U01234ABC\`) to @-mention on every notification.

Test the channel with **[Test send]** before relying on it.
`;

const adapter: ChannelAdapter = {
  type: "slack",
  displayName: "Slack",
  configSchema: slackConfigSchema,
  catalogEntry: {
    description: "Post Alertforge notifications to a Slack channel via an Incoming Webhook URL.",
    setupGuide: SETUP_GUIDE,
    requiresEnvKeys: [],
  },

  async send(notification: PipelineNotification, rawConfig: unknown): Promise<void> {
    const config: SlackConfig = slackConfigSchema.parse(rawConfig);
    const blocks = renderSlackBlocks(notification, config.mentionUserIds);
    const text = renderSlackFallbackText(notification, config.mentionUserIds);

    const body: Record<string, unknown> = {
      text,
      blocks,
    };
    if (config.channel) body.channel = config.channel;

    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Slack send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  },
};

export default adapter;
