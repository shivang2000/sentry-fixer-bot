import { describe, expect, it } from "bun:test";
import { validateClaimRequest } from "./claim-logic";

const NOW = new Date("2026-05-15T12:00:00Z");
const FUTURE = new Date("2026-05-16T12:00:00Z");
const PAST = new Date("2026-05-14T12:00:00Z");

describe("validateClaimRequest", () => {
  it("returns unauthorized when no signed-in user", () => {
    expect(
      validateClaimRequest({
        sessionUser: null,
        code: "abc",
        dbRow: { code: "abc", expiresAt: FUTURE, consumedAt: null },
        now: NOW,
      }),
    ).toBe("unauthorized");
  });

  it("returns missing_code when no code provided", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: null,
        dbRow: { code: "abc", expiresAt: FUTURE, consumedAt: null },
        now: NOW,
      }),
    ).toBe("missing_code");
  });

  it("returns invalid_or_expired when token row missing", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: "abc",
        dbRow: null,
        now: NOW,
      }),
    ).toBe("invalid_or_expired");
  });

  it("returns invalid_or_expired when code mismatches", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: "wrong",
        dbRow: { code: "abc", expiresAt: FUTURE, consumedAt: null },
        now: NOW,
      }),
    ).toBe("invalid_or_expired");
  });

  it("returns invalid_or_expired when expired", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: "abc",
        dbRow: { code: "abc", expiresAt: PAST, consumedAt: null },
        now: NOW,
      }),
    ).toBe("invalid_or_expired");
  });

  it("returns consumed when already consumed", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: "abc",
        dbRow: { code: "abc", expiresAt: FUTURE, consumedAt: PAST },
        now: NOW,
      }),
    ).toBe("consumed");
  });

  it("returns ok when everything valid", () => {
    expect(
      validateClaimRequest({
        sessionUser: { id: "u1" },
        code: "abc",
        dbRow: { code: "abc", expiresAt: FUTURE, consumedAt: null },
        now: NOW,
      }),
    ).toBe("ok");
  });
});
