import { describe, expect, it } from "bun:test";
import { parseAgentOutput } from "./parse-output";

describe("parseAgentOutput", () => {
  it("returns unknown markers when no summary tag", () => {
    const out = parseAgentOutput("agent rambled and never closed the envelope");
    expect(out.confidence).toBe("unknown");
    expect(out.risk).toBe("unknown");
    expect(out.summary).toContain("agent rambled");
  });

  it("extracts confidence and risk from summary tag", () => {
    const out = parseAgentOutput(
      "lots of output\n<summary>\nconfidence: high\nrisk: low\nChanged cart.ts to handle empty arrays.\n</summary>",
    );
    expect(out.confidence).toBe("high");
    expect(out.risk).toBe("low");
  });

  it("accepts json-style fields inside the envelope", () => {
    const out = parseAgentOutput(
      '<summary>"confidence":"medium","risk":"medium","fixed":true</summary>',
    );
    expect(out.confidence).toBe("medium");
    expect(out.risk).toBe("medium");
  });

  it("returns unknown for unrecognized levels", () => {
    const out = parseAgentOutput("<summary>confidence: certain, risk: high</summary>");
    expect(out.confidence).toBe("unknown");
    expect(out.risk).toBe("high");
  });
});
