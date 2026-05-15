import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyHmacSha256 } from "./verify-hmac";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyHmacSha256", () => {
  const secret = "test-secret";
  const body = '{"hello":"world"}';

  it("accepts a correctly signed body", () => {
    const sig = sign(secret, body);
    expect(verifyHmacSha256({ secret, body, headerValue: sig })).toBe(true);
  });

  it("accepts a sha256= prefixed header (GitHub-style)", () => {
    const sig = sign(secret, body);
    expect(verifyHmacSha256({ secret, body, headerValue: `sha256=${sig}` })).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyHmacSha256({ secret, body, headerValue: "deadbeef" })).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(verifyHmacSha256({ secret, body, headerValue: "" })).toBe(false);
    expect(verifyHmacSha256({ secret, body, headerValue: null })).toBe(false);
  });

  it("rejects signature signed with a different secret", () => {
    const sig = sign("wrong-secret", body);
    expect(verifyHmacSha256({ secret, body, headerValue: sig })).toBe(false);
  });
});
