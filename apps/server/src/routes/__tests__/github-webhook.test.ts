// github-webhook.ts pulls @alertforge/env/server transitively (via
// queue/boss → env). Preload stub envs so the validator passes when
// `bun test` is run from repo root without dotenv loading.
import "../../pipeline/__tests__/env-preload";
import { describe, expect, it } from "bun:test";
import { ALERTFORGE_COMMAND_PREFIX, isAlertforgeCommand } from "../github-webhook";

/**
 * Post-cleanup (alertforge-2.1.0 / P9) exclusive `/alertforge` recognition.
 * The legacy `/sfb` prefix is no longer recognised.
 */
describe("isAlertforgeCommand", () => {
  it("recognises the canonical /alertforge prefix", () => {
    expect(isAlertforgeCommand("/alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("/alertforge")).toBe(true);
    expect(isAlertforgeCommand("/alertforge add a null check")).toBe(true);
  });

  it("does NOT recognise the legacy /sfb prefix (dropped in 2.1.0)", () => {
    expect(isAlertforgeCommand("/sfb apply")).toBe(false);
    expect(isAlertforgeCommand("/sfb")).toBe(false);
    expect(isAlertforgeCommand("/sfb add a null check")).toBe(false);
  });

  it("is case-insensitive on the prefix", () => {
    expect(isAlertforgeCommand("/Alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("/ALERTFORGE apply")).toBe(true);
  });

  it("ignores leading whitespace before the prefix", () => {
    expect(isAlertforgeCommand("  /alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("\t/alertforge apply")).toBe(true);
    expect(isAlertforgeCommand("\n/alertforge")).toBe(true);
  });

  it("ignores comments that don't start with /alertforge", () => {
    expect(isAlertforgeCommand("looks good to me")).toBe(false);
    expect(isAlertforgeCommand("@alertforge apply")).toBe(false);
    expect(isAlertforgeCommand("alertforge: please apply")).toBe(false);
    expect(isAlertforgeCommand("/")).toBe(false);
    expect(isAlertforgeCommand("")).toBe(false);
  });

  it("rejects glued-prefix words that are not the command", () => {
    // `/alertforgenope` is NOT a legitimate command — `\b` after the
    // canonical prefix prevents false matches on alphanumeric suffixes.
    expect(isAlertforgeCommand("/alertforgenope")).toBe(false);
  });

  it("does NOT trigger on the bare prefix being a substring", () => {
    expect(isAlertforgeCommand("not at /alertforge start")).toBe(false);
  });

  it("exports the canonical prefix constant", () => {
    expect(ALERTFORGE_COMMAND_PREFIX).toBe("/alertforge");
  });
});
