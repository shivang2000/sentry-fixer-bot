import { describe, expect, it } from "bun:test";
import { scanText } from "./secret-scan";

describe("scanText", () => {
  it("returns empty on clean content", () => {
    expect(scanText("a.ts", "const x = 1;\nconst y = 'hello';")).toEqual([]);
  });

  it("flags an AWS access key id", () => {
    const f = scanText("a.ts", 'const k = "AKIAIOSFODNN7EXAMPLE";');
    expect(f).toEqual([{ file: "a.ts", line: 1, pattern: "aws_access_key" }]);
  });

  it("flags a github PAT (ghp_)", () => {
    const f = scanText("b.ts", "token = ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(f.length).toBeGreaterThan(0);
  });

  it("flags an anthropic key (sk-ant-)", () => {
    const f = scanText("c.ts", "ANTHROPIC=sk-ant-abc123abc123abc123abc123");
    expect(f.some((x) => x.pattern === "anthropic_key")).toBe(true);
  });

  it("flags multiple patterns on different lines", () => {
    const f = scanText(
      "d.ts",
      "line1\nAKIAIOSFODNN7EXAMPLE\nline3\nghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(f.length).toBeGreaterThanOrEqual(2);
  });
});
