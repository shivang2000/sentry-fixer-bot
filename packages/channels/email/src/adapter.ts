import type { ChannelAdapter, PipelineNotification } from "@alertforge/core";
import { type EmailConfig, emailConfigSchema, meetsSeverityFloor } from "./config.schema";
import { renderEmailHtml, renderEmailSubject, renderEmailText } from "./render";

const RESEND_API_BASE = "https://api.resend.com/emails";
const DEFAULT_FROM_ENV = "ALERTFORGE_DEFAULT_FROM";
const API_KEY_ENV = "RESEND_API_KEY";

const SETUP_GUIDE = `# Email channel — setup guide

V1 sends via [Resend](https://resend.com)'s HTTP API. Set
\`RESEND_API_KEY\` in \`/etc/alertforge/env\` (or your container env).

Optionally pin a default \`from\` address via \`ALERTFORGE_DEFAULT_FROM\`
(e.g. \`alertforge@yourdomain.com\`) — the per-trigger config can
override.

To add an email channel:

1. Alertforge UI → Trigger → Channels tab → **+ Add channel** → **Email**.
2. Add recipient(s) in the \`to\` list (max 20).
3. Optionally set \`from\` (else uses the env default).
4. Pick the severity floor — \`medium\` skips info/low notifications;
   \`critical\` keeps only critical events.

**Test send** to verify the API key + DNS / SPF / DKIM are in place.

SMTP fallback is planned for a later release; current build is
Resend-only.
`;

const adapter: ChannelAdapter = {
  type: "email",
  displayName: "Email",
  configSchema: emailConfigSchema,
  catalogEntry: {
    description: "Send Alertforge notifications as HTML email via Resend.",
    setupGuide: SETUP_GUIDE,
    requiresEnvKeys: [API_KEY_ENV],
  },

  async send(notification: PipelineNotification, rawConfig: unknown): Promise<void> {
    const config: EmailConfig = emailConfigSchema.parse(rawConfig);

    if (!meetsSeverityFloor(notification.severity, config.notifyOnSeverityAtLeast)) {
      // Below floor — silently drop. Recorder in the fan-out step
      // will mark the channel as "skipped" rather than "failed".
      return;
    }

    const apiKey = process.env[API_KEY_ENV];
    if (!apiKey) {
      throw new Error(
        `${API_KEY_ENV} not set — cannot deliver email. SMTP fallback ships in a later release.`,
      );
    }

    const from = config.from ?? process.env[DEFAULT_FROM_ENV];
    if (!from) {
      throw new Error(
        `Email from-address not configured. Set ${DEFAULT_FROM_ENV} env or set "from" on the channel config.`,
      );
    }

    const body = {
      from,
      to: config.to,
      subject: renderEmailSubject(notification),
      html: renderEmailHtml(notification),
      text: renderEmailText(notification),
    };

    const res = await fetch(RESEND_API_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Resend send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  },
};

export default adapter;
