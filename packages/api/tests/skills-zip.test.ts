import { describe, expect, it } from "bun:test";
import AdmZip from "adm-zip";

import { isPathSafe, MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, validateZipBuffer } from "../src/skills-zip";

function zipWithEntries(entries: Array<{ name: string; content: string }>): Buffer {
  const z = new AdmZip();
  for (const e of entries) z.addFile(e.name, Buffer.from(e.content));
  return z.toBuffer();
}

describe("isPathSafe", () => {
  it("accepts a normal entry", () => {
    expect(isPathSafe("/tmp/x", "SKILL.md")).toBe(true);
    expect(isPathSafe("/tmp/x", "nested/file.txt")).toBe(true);
  });

  it("rejects ..", () => {
    expect(isPathSafe("/tmp/x", "../etc/passwd")).toBe(false);
    expect(isPathSafe("/tmp/x", "a/../../b")).toBe(false);
  });
});

describe("validateZipBuffer", () => {
  it("accepts a small clean zip", () => {
    const buf = zipWithEntries([
      { name: "SKILL.md", content: "---\nname: x\n---\n" },
      { name: "scripts/run.sh", content: "echo hi" },
    ]);
    const result = validateZipBuffer(buf);
    expect(result.ok).toBe(true);
  });

  it("rejects a zip that exceeds MAX_ZIP_BYTES", () => {
    // simulate by passing a fake buffer larger than limit
    const big = Buffer.alloc(MAX_ZIP_BYTES + 1, 0);
    const result = validateZipBuffer(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("too_large");
  });

  it("rejects path-escape entries (via isPathSafe contract)", () => {
    // adm-zip normalises addFile() paths, so we cannot directly create a
    // malicious zip from a single file inline. We rely on isPathSafe as the
    // authoritative check inside safeExtractZip; verify its contract here.
    expect(isPathSafe("/tmp/x", "../escape")).toBe(false);
    expect(isPathSafe("/tmp/x", "a/../../escape")).toBe(false);
    expect(isPathSafe("/tmp/x", "/etc/passwd")).toBe(false);
    expect(isPathSafe("/tmp/x", "ok.txt")).toBe(true);
  });

  it("rejects zips with too many entries", () => {
    const entries: Array<{ name: string; content: string }> = [];
    for (let i = 0; i < MAX_ZIP_ENTRIES + 1; i++) {
      entries.push({ name: `f${i}.txt`, content: "x" });
    }
    const buf = zipWithEntries(entries);
    const result = validateZipBuffer(buf);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("too_many_entries");
  });
});
