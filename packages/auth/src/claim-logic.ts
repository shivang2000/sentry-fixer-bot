export type ClaimResult =
  | "ok"
  | "missing_code"
  | "invalid_or_expired"
  | "consumed"
  | "unauthorized";

export type ClaimRow = {
  code: string;
  expiresAt: Date;
  consumedAt: Date | null;
};

export function validateClaimRequest(input: {
  sessionUser: { id: string } | null;
  code: string | null;
  dbRow: ClaimRow | null;
  now: Date;
}): ClaimResult {
  if (!input.sessionUser) return "unauthorized";
  if (!input.code) return "missing_code";
  if (!input.dbRow) return "invalid_or_expired";
  if (input.dbRow.code !== input.code) return "invalid_or_expired";
  if (input.dbRow.expiresAt.getTime() <= input.now.getTime()) return "invalid_or_expired";
  if (input.dbRow.consumedAt) return "consumed";
  return "ok";
}
