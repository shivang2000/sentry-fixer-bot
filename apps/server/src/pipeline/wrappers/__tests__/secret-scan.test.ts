/**
 * Unit tests for secret-scan wrapper. Verifies:
 *   - skipIf returns true when cfg.stopAfter='budget'.
 *   - run() lists changed files via the injected runScriptedCommand,
 *     reads each via readChangedFile, runs scanText on each.
 *   - blocked=true only when findings.length > 0 AND
 *     cfg.toggles.secretScanStrict === 'block'.
 *   - blocked=false when strict='warn' even if findings exist.
 *   - empty workspace → empty findings, blocked=false.
 */

import "../../__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import type { ChannelAdapter, SourceAdapter, StepDeps } from "@alertforge/core";
import { MemoryCtxStore, makeCfg, silentLogger } from "../../__tests__/fixtures";
import { runSecretScanStep, skipSecretScanIf } from "../secret-scan";

function makeDeps(): StepDeps {
  return {
    modelProvider: {
      name: "noop",
      async complete() {
        return "{}";
      },
    },
    log: silentLogger,
    sources: new Map<string, SourceAdapter>(),
    channels: new Map<string, ChannelAdapter>(),
  };
}

describe("secret-scan wrapper", () => {
  it("skipIf returns true when cfg.stopAfter='budget'", async () => {
    const ctx = new MemoryCtxStore("run-1");
    expect(await skipSecretScanIf(ctx, makeCfg({ stopAfter: "budget" }))).toBe(true);
  });

  it("clean files → findings=[], blocked=false", async () => {
    const ctx = new MemoryCtxStore("run-2");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await runSecretScanStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async () => ({ exitCode: 0, stdout: "src/safe.ts\n", stderr: "" }),
      readChangedFile: async () => "const safe = 1;",
    });
    const ss = (await ctx.read("secret_scan")) as { findings: unknown[]; blocked: boolean };
    expect(ss.findings).toEqual([]);
    expect(ss.blocked).toBe(false);
  });

  it("finds AKIA secret → findings>0, blocked=true in strict mode", async () => {
    const ctx = new MemoryCtxStore("run-3");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await runSecretScanStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async () => ({ exitCode: 0, stdout: "leak.ts\n", stderr: "" }),
      readChangedFile: async () => 'const k = "AKIAIOSFODNN7EXAMPLE";',
    });
    const ss = (await ctx.read("secret_scan")) as {
      findings: Array<{ pattern: string }>;
      blocked: boolean;
    };
    expect(ss.findings.length).toBeGreaterThan(0);
    expect(ss.findings[0]?.pattern).toBe("aws_access_key");
    expect(ss.blocked).toBe(true);
  });

  it("warn mode: findings present but blocked=false", async () => {
    const ctx = new MemoryCtxStore("run-4");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await runSecretScanStep(
      ctx,
      makeCfg({ toggles: { autoReview: false, followUpLoop: false, secretScanStrict: "warn" } }),
      makeDeps(),
      {
        runScriptedCommand: async () => ({ exitCode: 0, stdout: "leak.ts\n", stderr: "" }),
        readChangedFile: async () => 'const k = "AKIAIOSFODNN7EXAMPLE";',
      },
    );
    const ss = (await ctx.read("secret_scan")) as { findings: unknown[]; blocked: boolean };
    expect(ss.findings.length).toBeGreaterThan(0);
    expect(ss.blocked).toBe(false);
  });

  it("no workspace → writes clean record", async () => {
    const ctx = new MemoryCtxStore("run-5");
    await runSecretScanStep(ctx, makeCfg(), makeDeps());
    expect(await ctx.read<{ findings: unknown[]; blocked: boolean }>("secret_scan")).toEqual({
      findings: [],
      blocked: false,
    });
  });

  it("readChangedFile throwing on a path is tolerated", async () => {
    const ctx = new MemoryCtxStore("run-6");
    await ctx.write("workspace", { dir: "/work", branch: "br", baseBranch: "main" });
    await runSecretScanStep(ctx, makeCfg(), makeDeps(), {
      runScriptedCommand: async () => ({ exitCode: 0, stdout: "gone.ts\nclean.ts\n", stderr: "" }),
      readChangedFile: async (p) => {
        if (p.includes("gone.ts")) throw new Error("file deleted");
        return "const x = 1;";
      },
    });
    const ss = (await ctx.read("secret_scan")) as { findings: unknown[] };
    expect(ss.findings).toEqual([]);
  });
});
