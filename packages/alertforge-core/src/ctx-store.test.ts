import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAP_BYTES, DiskCtxStore } from "./ctx-store";

describe("DiskCtxStore", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(join(tmpdir(), "alertforge-ctx-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("write + read round-trip for a JSON field", async () => {
    const ctx = await DiskCtxStore.create("run-1", runsRoot);
    await ctx.write("triage", { severity: "high", summary: "x" });
    const out = await ctx.read<{ severity: string; summary: string }>("triage");
    expect(out).toEqual({ severity: "high", summary: "x" });
  });

  it("read returns null for a field that has not been written", async () => {
    const ctx = await DiskCtxStore.create("run-2", runsRoot);
    expect(await ctx.read("triage")).toBeNull();
  });

  it("exists() reflects write state", async () => {
    const ctx = await DiskCtxStore.create("run-3", runsRoot);
    expect(await ctx.exists("alert")).toBe(false);
    await ctx.write("alert", { title: "boom" });
    expect(await ctx.exists("alert")).toBe(true);
  });

  it("write past capBytes truncates and creates a .truncated.flag sidecar", async () => {
    const ctx = await DiskCtxStore.create("run-4", runsRoot);
    const huge = { blob: "x".repeat(50_000) };
    await ctx.write("triage", huge, { capBytes: 1024 });
    const sizeAfter = await ctx.size("triage");
    expect(sizeAfter).toBeLessThanOrEqual(1024);
    const truncated = await ctx.truncatedFields();
    expect(truncated).toContain("triage");
  });

  it("agent_transcript is written as raw text not JSON", async () => {
    const ctx = await DiskCtxStore.create("run-5", runsRoot);
    await ctx.write("agent_transcript", "line one\nline two\n");
    const out = await ctx.read<string>("agent_transcript");
    expect(out).toBe("line one\nline two\n");
  });

  it("append() accumulates on agent_transcript", async () => {
    const ctx = await DiskCtxStore.create("run-6", runsRoot);
    await ctx.append("agent_transcript", "chunk-a\n");
    await ctx.append("agent_transcript", "chunk-b\n");
    const out = await ctx.read<string>("agent_transcript");
    expect(out).toBe("chunk-a\nchunk-b\n");
  });

  it("append() refuses non-log fields", async () => {
    const ctx = await DiskCtxStore.create("run-7", runsRoot);
    await expect(ctx.append("triage", "x")).rejects.toThrow(/append/);
  });

  it("append() trims to cap by dropping oldest bytes", async () => {
    const ctx = await DiskCtxStore.create("run-8", runsRoot);
    const big = "x".repeat(DEFAULT_CAP_BYTES.agent_transcript + 1024);
    await ctx.append("agent_transcript", big);
    const sizeAfter = await ctx.size("agent_transcript");
    expect(sizeAfter).toBeLessThanOrEqual(DEFAULT_CAP_BYTES.agent_transcript);
    const truncated = await ctx.truncatedFields();
    expect(truncated).toContain("agent_transcript");
  });

  it("size() returns 0 for missing field", async () => {
    const ctx = await DiskCtxStore.create("run-9", runsRoot);
    expect(await ctx.size("triage")).toBe(0);
  });

  it("dir is namespaced under {runsRoot}/{runId}/ctx", async () => {
    const ctx = await DiskCtxStore.create("run-10", runsRoot);
    expect(ctx.dir).toBe(join(runsRoot, "run-10", "ctx"));
  });
});
