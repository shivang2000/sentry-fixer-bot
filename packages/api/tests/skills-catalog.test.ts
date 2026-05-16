import { describe, expect, it } from "bun:test";

import { SKILLS_CATALOG } from "../src/skills-catalog";

describe("SKILLS_CATALOG", () => {
  it("includes sentry-triage", () => {
    const ids = SKILLS_CATALOG.map((c) => c.id);
    expect(ids).toContain("sentry-triage");
  });

  it("includes pr-reviewer", () => {
    const ids = SKILLS_CATALOG.map((c) => c.id);
    expect(ids).toContain("pr-reviewer");
  });

  it("every entry has id, name, description, tags", () => {
    for (const entry of SKILLS_CATALOG) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });
});
