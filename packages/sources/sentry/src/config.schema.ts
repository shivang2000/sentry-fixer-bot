import { z } from "zod";

/**
 * Per-source-project install config for the Sentry adapter. Stored on
 * `triggers.config.sourceConfig` and rendered as a form in the trigger
 * wizard. Today the Sentry pipeline reads everything it needs from
 * env (SENTRY_WEBHOOK_SECRET, SENTRY_API_TOKEN, SENTRY_ORG_SLUG); no
 * per-source-project knobs exist yet, so the schema is empty.
 *
 * Future fields likely include:
 *   - issueLevelFloor: "error" | "warning"  (skip warnings)
 *   - excludeFingerprints: string[]
 *   - environmentFilter: string[]            (only fix issues from prod, etc.)
 */
export const sentryConfigSchema = z.object({}).strict();
export type SentryConfig = z.infer<typeof sentryConfigSchema>;
