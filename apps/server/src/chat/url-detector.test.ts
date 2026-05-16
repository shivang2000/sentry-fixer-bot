import { describe, expect, it } from "bun:test";
import { detectOAuthPrompt } from "./url-detector";

describe("detectOAuthPrompt", () => {
  it("returns null on plain output", () => {
    expect(detectOAuthPrompt("hello world")).toBeNull();
  });

  it("detects a gh device-flow URL with a hint phrase", () => {
    const out = detectOAuthPrompt(
      "Open the following URL in your browser: https://github.com/login/device\nThen paste the code: ABCD-1234",
    );
    expect(out?.url).toBe("https://github.com/login/device");
  });

  it("detects claude /login style", () => {
    const out = detectOAuthPrompt(
      "Visit this URL to complete authentication: https://claude.ai/login/x",
    );
    expect(out?.url).toBe("https://claude.ai/login/x");
  });

  it("returns null when URL is present but no hint phrase", () => {
    expect(detectOAuthPrompt("see https://example.com for docs")).toBeNull();
  });

  it("returns the first URL when multiple are present", () => {
    const out = detectOAuthPrompt(
      "Open the following URL: https://a.example.com and ignore https://b.example.com",
    );
    expect(out?.url).toBe("https://a.example.com");
  });

  it("ignores trailing punctuation in the URL", () => {
    const out = detectOAuthPrompt("Visit this URL: https://claude.ai/login.");
    expect(out?.url).toBe("https://claude.ai/login");
  });

  it("reassembles a URL hard-wrapped by the PTY at column 80", () => {
    const wrapped =
      "Browser didn't open? Use the URL below to sign in\r\n\r\n" +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88\r\n" +
      "ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fexample.com\r\n";
    expect(detectOAuthPrompt(wrapped)?.url).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fexample.com",
    );
  });

  it("stops at a blank line so post-URL prose isn't consumed", () => {
    const out = detectOAuthPrompt(
      "Browser didn't open? Use the URL below to sign in\r\n\r\n" +
        "https://claude.com/cai/oauth/authorize?code=true&client_id=abc\r\n" +
        "\r\nPaste code here if prompted >",
    );
    expect(out?.url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=abc");
  });

  it("strips ANSI escapes before matching", () => {
    const out = detectOAuthPrompt(
      "\x1b[1mOpen the following URL\x1b[0m: \x1b[36mhttps://claude.ai/login/x\x1b[0m",
    );
    expect(out?.url).toBe("https://claude.ai/login/x");
  });
});
