import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an HMAC-SHA256 signature over a raw body.
 * Accepts either bare hex digest or "sha256=<hex>" prefix.
 * Constant-time comparison.
 */
export function verifyHmacSha256(input: {
  secret: string;
  body: string | Uint8Array;
  headerValue: string | null | undefined;
}): boolean {
  if (!input.headerValue) return false;
  const provided = input.headerValue.startsWith("sha256=")
    ? input.headerValue.slice("sha256=".length)
    : input.headerValue;
  if (!/^[0-9a-fA-F]+$/.test(provided)) return false;

  const expected = createHmac("sha256", input.secret).update(input.body).digest("hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}
