// github-webhook.ts pulls @alertforge/env/server transitively (via
// queue/boss → env). Preload stub envs so the validator passes when
// `bun test` is run from repo root without dotenv loading.
import "../../pipeline/__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import {
  ALERTFORGE_COMMAND_PREFIX,
  isAlertforgeCommand,
  isSfbCommand,
  SFB_COMMAND_PREFIX,
} from "../github-webhook";

/**
 * Dual-prefix recognition tests for the rename back-compat window
 * (alertforge-2.0.x). Both `/alertforge` and legacy `/sfb` must match;
 * everything else must be ignored. P9 will drop the `/sfb` arm.
 */
describe("isAlertforgeCommand", () => {
  it("recognises the canonical /alertforge prefix", () => {
    expect(isAlertforgeCommand("/alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("/alertforge")).toBe(true);
    expect(isAlertforgeCommand("/alertforge add a null check")).toBe(true);
  });

  it("recognises the legacy /sfb prefix (back-compat)", () => {
    expect(isAlertforgeCommand("/sfb apply")).toBe(true);
    expect(isAlertforgeCommand("/sfb")).toBe(true);
    expect(isAlertforgeCommand("/sfb add a null check")).toBe(true);
  });

  it("is case-insensitive on the prefix", () => {
    expect(isAlertforgeCommand("/SFB apply")).toBe(true);
    expect(isAlertforgeCommand("/Alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("/ALERTFORGE apply")).toBe(true);
  });

  it("ignores leading whitespace before the prefix", () => {
    expect(isAlertforgeCommand("  /alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("\t/sfb apply")).toBe(true);
    expect(isAlertforgeCommand("\n/alertforge")).toBe(true);
  });

  it("ignores comments that don't start with /alertforge or /sfb", () => {
    expect(isAlertforgeCommand("looks good to me")).toBe(false);
    expect(isAlertforgeCommand("@alertforge apply")).toBe(false);
    expect(isAlertforgeCommand("alertforge: please apply")).toBe(false);
    expect(isAlertforgeCommand("/")).toBe(false);
    expect(isAlertforgeCommand("")).toBe(false);
  });

  it("rejects glued-prefix words that are not the command", () => {
    // `/sfbnope` / `/alertforgenope` are NOT legitimate commands —
    // `\b` after the canonical prefix prevents false matches on
    // alphanumeric suffixes.
    expect(isAlertforgeCommand("/sfbnope")).toBe(false);
    expect(isAlertforgeCommand("/alertforgenope")).toBe(false);
  });

  it("does NOT trigger on the bare prefix being a substring", () => {
    expect(isAlertforgeCommand("not at /alertforge start")).toBe(false);
    expect(isAlertforgeCommand("ping /sfb please")).toBe(false);
  });

  it("legacy alias isSfbCommand resolves to the same impl", () => {
    // Same function reference — both should match identically.
    expect(isSfbCommand).toBe(isAlertforgeCommand);
    expect(isSfbCommand("/alertforge x")).toBe(true);
    expect(isSfbCommand("/sfb x")).toBe(true);
  });

  it("exports both prefix constants", () => {
    expect(SFB_COMMAND_PREFIX).toBe("/sfb");
    expect(ALERTFORGE_COMMAND_PREFIX).toBe("/alertforge");
  });
});
