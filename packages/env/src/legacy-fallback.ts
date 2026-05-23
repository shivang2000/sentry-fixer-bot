/**
 * One-release back-compat shim for the SFB_* → ALERTFORGE_* env-key rename
 * (P7 cutover, 2026-05-23).
 *
 * Policy: alertforge-2.0.x reads BOTH old (SFB_*) and new (ALERTFORGE_*)
 * env keys. New wins when both are set. Reading any old key emits a
 * one-shot deprecation warning so operators know what to migrate before
 * alertforge-2.1.0 (P9) removes the legacy surface.
 *
 * Called once at module load, BEFORE @t3-oss/env-core's createEnv runs.
 * Mutates process.env in place (the only way createEnv sees the resolved
 * value, since it reads process.env synchronously at module load).
 */
export const LEGACY_ENV_KEY_MAP: Readonly<Record<string, string>> = Object.freeze({
  ALERTFORGE_RUN_MODE: "SFB_RUN_MODE",
  ALERTFORGE_STATE_DIR: "SFB_STATE_DIR",
  ALERTFORGE_ENV_FILE: "SFB_ENV_FILE",
  ALERTFORGE_SKILLS_DIR: "SFB_SKILLS_DIR",
  ALERTFORGE_CHAT_DIR: "SFB_CHAT_DIR",
  ALERTFORGE_DISABLE_AUTO_BOOTSTRAP: "SFB_DISABLE_AUTO_BOOTSTRAP",
  ALERTFORGE_DEFAULT_SKILLS_REPO: "SFB_DEFAULT_SKILLS_REPO",
  ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL: "SFB_BOOTSTRAP_ADMIN_EMAIL",
});

export type LegacyWarn = (message: string) => void;

const warnedKeys = new Set<string>();

function defaultWarn(message: string): void {
  // Use console.warn so it lands in journalctl on EC2 + stderr in dev.
  // Pino isn't available this early — `env` is a static module dep of
  // pino-based logging itself.
  console.warn(message);
}

/**
 * For each (new, old) pair: if the new key is unset/empty AND the old key
 * is set, copy old → new on process.env and warn once. If the new key is
 * already set, leave it (new wins) and warn once that the old key is
 * deprecated and ignored.
 *
 * Idempotent: safe to call multiple times in the same process. Each old
 * key warns at most once per process via warnedKeys.
 */
export function applyLegacyEnvFallbacks(
  env: NodeJS.ProcessEnv = process.env,
  warn: LegacyWarn = defaultWarn,
): void {
  for (const [newKey, oldKey] of Object.entries(LEGACY_ENV_KEY_MAP)) {
    const oldVal = env[oldKey];
    const newVal = env[newKey];
    const oldSet = typeof oldVal === "string" && oldVal.length > 0;
    const newSet = typeof newVal === "string" && newVal.length > 0;

    if (!oldSet) continue;

    if (!warnedKeys.has(oldKey)) {
      warnedKeys.add(oldKey);
      if (newSet) {
        warn(
          `[alertforge] ${oldKey} is deprecated and IGNORED (${newKey} is set); ` +
            "will be removed in alertforge-2.1.0.",
        );
      } else {
        warn(
          `[alertforge] ${oldKey} is deprecated; use ${newKey}. ` +
            "Will be removed in alertforge-2.1.0.",
        );
        env[newKey] = oldVal;
      }
    } else if (!newSet) {
      // Already warned, but still apply the fallback so subsequent
      // readers see the value. (Common in tests that warm-load the
      // module then re-call.)
      env[newKey] = oldVal;
    }
  }
}

/**
 * Test helper: reset the once-only warn dedupe. Production never calls
 * this — it would re-spam on every reload. Tests need it for clean
 * fixture state.
 */
export function __resetLegacyWarnCacheForTesting(): void {
  warnedKeys.clear();
}

/**
 * Read an env var by its NEW (ALERTFORGE_*) name, falling back to the
 * legacy (SFB_*) name during the 2.0.x back-compat window.
 *
 * Use this for ad-hoc `process.env.X` reads outside the `createEnv`
 * schema (e.g. path constants, runtime conditionals). For schema-bound
 * reads, prefer the `env` object from `@alertforge/env/server`, which
 * applies the same fallback once at module load.
 *
 * Does NOT emit a warning here — the boot-time `applyLegacyEnvFallbacks`
 * call already handles the operator-visible deprecation message. We
 * avoid spamming per-read.
 */
export function readEnvWithLegacyFallback(
  newKey: string,
  legacyKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const newVal = env[newKey];
  if (typeof newVal === "string" && newVal.length > 0) return newVal;
  const oldVal = env[legacyKey];
  if (typeof oldVal === "string" && oldVal.length > 0) return oldVal;
  return undefined;
}
