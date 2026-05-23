import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetLegacyWarnCacheForTesting,
  applyLegacyEnvFallbacks,
  LEGACY_ENV_KEY_MAP,
} from "./legacy-fallback";

function makeWarn() {
  const messages: string[] = [];
  const warn = (m: string) => {
    messages.push(m);
  };
  return { warn, messages };
}

describe("applyLegacyEnvFallbacks", () => {
  beforeEach(() => {
    __resetLegacyWarnCacheForTesting();
  });
  afterEach(() => {
    __resetLegacyWarnCacheForTesting();
  });

  it("does nothing + does not warn when only the new key is set", () => {
    const env = { ALERTFORGE_RUN_MODE: "container" } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBe("container");
    expect(env.SFB_RUN_MODE).toBeUndefined();
    expect(messages).toHaveLength(0);
  });

  it("copies old → new and warns once when only the old key is set", () => {
    const env = { SFB_RUN_MODE: "container" } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBe("container");
    expect(env.SFB_RUN_MODE).toBe("container"); // not deleted, just mirrored
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/SFB_RUN_MODE is deprecated/);
    expect(messages[0]).toMatch(/ALERTFORGE_RUN_MODE/);
    expect(messages[0]).toMatch(/2\.1\.0/);
  });

  it("new wins when both set; warns that old is ignored", () => {
    const env = {
      SFB_RUN_MODE: "legacy",
      ALERTFORGE_RUN_MODE: "container",
    } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBe("container");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/IGNORED/);
  });

  it("does nothing when neither key is set", () => {
    const env = {} as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBeUndefined();
    expect(messages).toHaveLength(0);
  });

  it("warns once per old key across repeated calls in the same process", () => {
    const env = { SFB_STATE_DIR: "/alertforge/state" } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    applyLegacyEnvFallbacks(env, warn);
    applyLegacyEnvFallbacks(env, warn);
    expect(messages).toHaveLength(1);
    expect(env.ALERTFORGE_STATE_DIR).toBe("/alertforge/state");
  });

  it("covers every documented legacy alias", () => {
    // Sanity-check the explicit map matches the rename spec. If a new
    // env key is added without a matching legacy alias, this test stays
    // green; the test exists to prevent the inverse — a stale entry
    // here long after the alias was removed.
    expect(Object.keys(LEGACY_ENV_KEY_MAP)).toEqual(
      expect.arrayContaining([
        "ALERTFORGE_RUN_MODE",
        "ALERTFORGE_STATE_DIR",
        "ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL",
      ]),
    );
  });

  it("treats empty string as unset (matches t3-env emptyStringAsUndefined)", () => {
    const env = { SFB_RUN_MODE: "", ALERTFORGE_RUN_MODE: "container" } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBe("container");
    expect(messages).toHaveLength(0);
  });

  it("applies every alias in one call", () => {
    const env = {
      SFB_RUN_MODE: "container",
      SFB_STATE_DIR: "/alertforge/state",
      SFB_BOOTSTRAP_ADMIN_EMAIL: "ops@example.com",
    } as NodeJS.ProcessEnv;
    const { warn, messages } = makeWarn();
    applyLegacyEnvFallbacks(env, warn);
    expect(env.ALERTFORGE_RUN_MODE).toBe("container");
    expect(env.ALERTFORGE_STATE_DIR).toBe("/alertforge/state");
    expect(env.ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL).toBe("ops@example.com");
    expect(messages).toHaveLength(3);
  });
});
