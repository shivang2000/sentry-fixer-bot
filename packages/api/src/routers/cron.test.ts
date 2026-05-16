import { describe, expect, it } from "bun:test";
import { cronToPreset, PRESET_LOOKBACK_MINUTES, PRESET_TO_CRON } from "./cron";

describe("cron presets", () => {
  it("maps every preset to a 5-field cron expression", () => {
    for (const [preset, expr] of Object.entries(PRESET_TO_CRON)) {
      expect(expr.split(/\s+/).length).toBe(5);
      expect(preset).toBeTruthy();
    }
  });

  it("round-trips preset → cron → preset", () => {
    for (const preset of Object.keys(PRESET_TO_CRON)) {
      const expr = PRESET_TO_CRON[preset as keyof typeof PRESET_TO_CRON];
      expect(cronToPreset(expr)).toBe(preset);
    }
  });

  it("returns 'never' for null", () => {
    expect(cronToPreset(null)).toBe("never");
  });

  it("returns 'never' for an unknown cron string", () => {
    expect(cronToPreset("17 3 * * *")).toBe("never");
  });

  it("lookback minutes align with the preset interval", () => {
    expect(PRESET_LOOKBACK_MINUTES["15m"]).toBe(15);
    expect(PRESET_LOOKBACK_MINUTES["30m"]).toBe(30);
    expect(PRESET_LOOKBACK_MINUTES["1h"]).toBe(60);
    expect(PRESET_LOOKBACK_MINUTES["4h"]).toBe(240);
    expect(PRESET_LOOKBACK_MINUTES["1d"]).toBe(1440);
  });
});
