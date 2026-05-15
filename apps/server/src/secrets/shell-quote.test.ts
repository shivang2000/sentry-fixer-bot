import { describe, expect, it } from "bun:test";
import { isValidEnvKey, shellQuote } from "./shell-quote";

describe("shellQuote", () => {
  it("returns simple unquoted for safe characters", () => {
    expect(shellQuote("abc")).toBe("abc");
    expect(shellQuote("a.b-c_d/e:f@g%h+i,j=k")).toBe("a.b-c_d/e:f@g%h+i,j=k");
  });

  it("single-quotes values with spaces", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("returns empty string as ''", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("isValidEnvKey", () => {
  it("accepts ALL_CAPS keys", () => {
    expect(isValidEnvKey("FOO")).toBe(true);
    expect(isValidEnvKey("FOO_BAR_BAZ_2")).toBe(true);
  });

  it("rejects lowercase or invalid", () => {
    expect(isValidEnvKey("foo")).toBe(false);
    expect(isValidEnvKey("FOO-BAR")).toBe(false);
    expect(isValidEnvKey("2FOO")).toBe(false);
    expect(isValidEnvKey("")).toBe(false);
  });
});
