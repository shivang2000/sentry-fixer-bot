import { z } from "zod";

const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const emailConfigSchema = z.object({
  /** Recipient list. Capped at 20 to keep accidental ops blast small. */
  to: z.array(z.string().email()).min(1).max(20),
  /** Optional from-address override. Falls back to ALERTFORGE_DEFAULT_FROM env. */
  from: z.string().email().optional(),
  /** Skip notifications below this severity. Defaults to "medium" (info/low filtered out). */
  notifyOnSeverityAtLeast: SeveritySchema.default("medium"),
});

export type EmailConfig = z.infer<typeof emailConfigSchema>;

const SEVERITY_RANK: Record<z.infer<typeof SeveritySchema>, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * Returns true when `notificationSeverity` meets or exceeds the
 * configured floor. Notifications without a severity (e.g. digest)
 * always pass — operators expect those.
 */
export function meetsSeverityFloor(
  notificationSeverity: string | undefined,
  floor: z.infer<typeof SeveritySchema>,
): boolean {
  if (!notificationSeverity) return true;
  const n = SEVERITY_RANK[notificationSeverity as z.infer<typeof SeveritySchema>];
  if (n === undefined) return true; // unknown severity → pass
  return n >= SEVERITY_RANK[floor];
}
