/**
 * Setup guide rendered in the Alertforge UI catalog page for the Sentry
 * source adapter. Stored as a TS module rather than a .md import so it
 * does not depend on bundler-specific markdown handling. Edit this
 * string when the Sentry integration setup steps change.
 */
export const SENTRY_SETUP_GUIDE = `# Sentry source — setup guide

Wires Sentry alerts into Alertforge so the bot can triage them and open
fix PRs. Requires a Sentry plan that supports webhooks (Team plan and
above) plus a Sentry Internal Integration with \`event:read\` and
\`issue:write\` scopes.

## 1. Create the Sentry Internal Integration

In your Sentry org settings → Custom Integrations → New Internal
Integration:

- **Name:** \`alertforge\`
- **Webhook URL:** \`https://<your-alertforge-host>/webhooks/sentry\`
- **Permissions:**
  - Project: \`Read\`
  - Issue & Event: \`Read & Write\` (Write is needed for the
    auto-generated comment on a fixed issue)
  - Member: \`Read\`
- **Webhooks → Alert rule action:** \`Yes\` (lets you select Alertforge
  as a target in your alert rules)
- **Generate a webhook secret** and copy it.

Click "Install for your organization" to provision the token + secret.

## 2. Add credentials to Alertforge

Set the following environment variables (\`/etc/alertforge/env\`):

\`\`\`bash
SENTRY_WEBHOOK_SECRET=<from step 1's "Webhook secret">
SENTRY_API_TOKEN=<from step 1's "Tokens" tab>
SENTRY_ORG_SLUG=<your sentry org slug>
\`\`\`

Restart the Alertforge worker + web after editing.

## 3. Create the Sentry alert rule

In your Sentry project → Alerts → New Alert Rule:

- **Conditions:** when a new issue is created (or any condition you
  want — Alertforge dedups storms).
- **Actions:** Send a notification → \`alertforge\` (the integration
  you created in step 1).

Save. The next matching event will fire a webhook to
\`/webhooks/sentry\`.

## 4. Configure a trigger in Alertforge

In Alertforge UI → \`/triggers/new\`:

1. Source: **Sentry**
2. Source project: your Sentry project slug (e.g. \`backend-api\`)
3. Repo: the GitHub repo where fixes land
4. Preset: \`Auto-fix\` (default) or \`Triage-only\` if you want to start
   conservative
5. Add a Slack / email channel (optional)

That's it — the next webhook from the configured project will run the
full pipeline.

## Troubleshooting

- **Webhook signature check fails (401):** confirm \`SENTRY_WEBHOOK_SECRET\`
  matches exactly what Sentry shows in the integration settings (no
  trailing newline).
- **Triage step says "Sentry not configured":** confirm \`SENTRY_API_TOKEN\`
  is set and the token has \`event:read\` scope.
- **Comment-on-issue silently no-ops:** confirm the token has
  \`issue:write\` scope. Comment failures never abort the pipeline; check
  \`runs.error\` for the exact reason.
`;
