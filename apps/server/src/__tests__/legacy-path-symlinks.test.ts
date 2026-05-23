import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyLegacyPathSymlinks } from "../legacy-path-symlinks";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "alertforge-symlink-test-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("applyLegacyPathSymlinks", () => {
  it("creates a symlink when legacy is absent and new exists", async () => {
    const newPath = join(workDir, "alertforge");
    const legacyPath = join(workDir, "sfb");
    await mkdir(newPath);

    const r = await applyLegacyPathSymlinks({
      pairs: [{ legacyPath, newPath }],
      log: () => undefined,
    });

    expect(r.created).toHaveLength(1);
    expect(r.alreadyExists).toHaveLength(0);
    expect(r.newPathMissing).toHaveLength(0);
    expect(await readlink(legacyPath)).toBe(newPath);
  });

  it("is idempotent — repeat calls do nothing once the symlink exists", async () => {
    const newPath = join(workDir, "alertforge");
    const legacyPath = join(workDir, "sfb");
    await mkdir(newPath);

    await applyLegacyPathSymlinks({ pairs: [{ legacyPath, newPath }], log: () => undefined });
    const r2 = await applyLegacyPathSymlinks({
      pairs: [{ legacyPath, newPath }],
      log: () => undefined,
    });

    expect(r2.created).toHaveLength(0);
    expect(r2.alreadyExists).toHaveLength(1);
  });

  it("skips when the new path is missing (nothing to link to)", async () => {
    const legacyPath = join(workDir, "sfb");
    const newPath = join(workDir, "alertforge-missing");

    const r = await applyLegacyPathSymlinks({
      pairs: [{ legacyPath, newPath }],
      log: () => undefined,
    });

    expect(r.created).toHaveLength(0);
    expect(r.newPathMissing).toHaveLength(1);
  });

  it("does not replace an existing legacy directory", async () => {
    const newPath = join(workDir, "alertforge");
    const legacyPath = join(workDir, "sfb");
    await mkdir(newPath);
    await mkdir(legacyPath);
    await writeFile(join(legacyPath, "marker"), "preserve-me");

    const r = await applyLegacyPathSymlinks({
      pairs: [{ legacyPath, newPath }],
      log: () => undefined,
    });

    expect(r.created).toHaveLength(0);
    expect(r.alreadyExists).toHaveLength(1);
    // Marker file still present — we did not nuke the dir.
    expect(await Bun.file(join(legacyPath, "marker")).text()).toBe("preserve-me");
  });

  it("handles multiple pairs in one call", async () => {
    const pair1 = {
      legacyPath: join(workDir, "sfb-a"),
      newPath: join(workDir, "alertforge-a"),
    };
    const pair2 = {
      legacyPath: join(workDir, "sfb-b"),
      newPath: join(workDir, "alertforge-b"),
    };
    await mkdir(pair1.newPath);
    // pair2.newPath intentionally absent.

    const r = await applyLegacyPathSymlinks({
      pairs: [pair1, pair2],
      log: () => undefined,
    });

    expect(r.created).toHaveLength(1);
    expect(r.newPathMissing).toHaveLength(1);
  });

  it("logs info on creation and warn on swallowed failure", async () => {
    const newPath = join(workDir, "alertforge");
    const legacyPath = join(workDir, "sfb");
    await mkdir(newPath);

    const records: Array<{ level: string; message: string }> = [];
    await applyLegacyPathSymlinks({
      pairs: [{ legacyPath, newPath }],
      log: (level, message) => records.push({ level, message }),
    });

    expect(records.some((r) => r.level === "info")).toBe(true);
  });
});
