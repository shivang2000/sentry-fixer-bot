import { z } from "zod";

export const slackConfigSchema = z.object({
  /** Incoming webhook URL — must be a Slack-issued one. */
  webhookUrl: z.string().url(),
  /** Override channel (only respected by some webhook URLs). */
  channel: z.string().optional(),
  /** Slack user IDs (U...) to @-mention in the fallback text. */
  mentionUserIds: z.array(z.string()).optional(),
});

export type SlackConfig = z.infer<typeof slackConfigSchema>;
