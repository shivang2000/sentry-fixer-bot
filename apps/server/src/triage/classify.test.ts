import { describe, expect, it } from "bun:test";
import { parseTriageJson } from "./classify";

describe("parseTriageJson", () => {
  it("parses a well-formed json response", () => {
    const out = parseTriageJson(
      '{"severity":"high","summary":"Null deref in cart","suspectedFiles":["src/cart.ts"]}',
    );
    expect(out).toEqual({
      severity: "high",
      summary: "Null deref in cart",
      suspectedFiles: ["src/cart.ts"],
    });
  });

  it("extracts json embedded in prose", () => {
    const out = parseTriageJson(
      'Here is the triage:\n```json\n{"severity":"critical","summary":"x","suspectedFiles":[]}\n```',
    );
    expect(out.severity).toBe("critical");
  });

  it("returns medium for unknown severity values", () => {
    const out = parseTriageJson('{"severity":"meh","summary":"","suspectedFiles":[]}');
    expect(out.severity).toBe("medium");
  });

  it("returns medium fallback when no json is present", () => {
    expect(parseTriageJson("nothing here")).toEqual({
      severity: "medium",
      summary: "(unparseable)",
      suspectedFiles: [],
    });
  });

  it("coerces non-array suspectedFiles to empty list", () => {
    const out = parseTriageJson('{"severity":"low","summary":"x","suspectedFiles":"oops"}');
    expect(out.suspectedFiles).toEqual([]);
  });
});
