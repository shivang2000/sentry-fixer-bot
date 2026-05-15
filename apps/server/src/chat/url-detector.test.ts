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
    // Match drops trailing period since . is not in our URL character class
    expect(out?.url).toBe("https://claude.ai/login");
  });
});
