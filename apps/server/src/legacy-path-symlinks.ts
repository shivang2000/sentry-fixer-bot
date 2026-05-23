/**
 * Boot-time idempotent symlink creator for the SFB → alertforge rename
 * back-compat window (alertforge-2.0.x).
 *
 * The rename moves the canonical state + config directories:
 *   /var/lib/sfb  → /var/lib/alertforge
 *   /etc/sfb      → /etc/alertforge
 *   /opt/sfb      → /opt/alertforge
 *
 * Operators may still have systemd units / cron jobs / scripts that
 * reference the old paths. To avoid splitting their state across two
 * directory trees during cutover, we create symlinks from the old paths
 * to the new ones if the new path exists and the old one is absent.
 *
 * Removed in alertforge-2.1.0 (P9) once operators have had one release
 * cycle to migrate.
 *
 * Behaviour notes:
 *   - Idempotent: no-ops if the old path already exists (symlink, dir,
 *     or otherwise) OR if the new path does not exist.
 *   - Tolerates EACCES / EPERM silently — in dev / container modes the
 *     server doesn't own /var/lib or /etc, and that's fine.
 *   - Logs at info when a symlink is created so operators see it once
 *     per boot, never spams.
 */

import { existsSync, lstatSync } from "node:fs";
import { symlink } from "node:fs/promises";

export interface LegacySymlinkPair {
  legacyPath: string;
  newPath: string;
}

export const DEFAULT_LEGACY_PATH_PAIRS: ReadonlyArray<LegacySymlinkPair> = [
  { legacyPath: "/var/lib/sfb", newPath: "/var/lib/alertforge" },
  { legacyPath: "/etc/sfb", newPath: "/etc/alertforge" },
  { legacyPath: "/opt/sfb", newPath: "/opt/alertforge" },
];

export type LegacySymlinkLog = (
  level: "info" | "warn",
  message: string,
  ctx?: Record<string, unknown>,
) => void;

export interface LegacySymlinkResult {
  /** Pairs where we successfully created a new symlink. */
  created: LegacySymlinkPair[];
  /** Pairs where the legacy path already existed (no action taken). */
  alreadyExists: LegacySymlinkPair[];
  /** Pairs where the new path did not exist (no action taken). */
  newPathMissing: LegacySymlinkPair[];
  /** Pairs where symlink creation failed (logged + swallowed). */
  failed: { pair: LegacySymlinkPair; err: unknown }[];
}

/**
 * Walk the configured pairs and create back-compat symlinks where
 * appropriate. Designed to be safe under any privilege level — failures
 * are returned in the result object, not thrown.
 */
export async function applyLegacyPathSymlinks(opts?: {
  pairs?: ReadonlyArray<LegacySymlinkPair>;
  log?: LegacySymlinkLog;
}): Promise<LegacySymlinkResult> {
  const pairs = opts?.pairs ?? DEFAULT_LEGACY_PATH_PAIRS;
  const log = opts?.log ?? defaultLog;
  const result: LegacySymlinkResult = {
    created: [],
    alreadyExists: [],
    newPathMissing: [],
    failed: [],
  };

  for (const pair of pairs) {
    // lstatSync rather than existsSync: existsSync follows the symlink,
    // so an existing dangling legacy symlink would be reported as
    // missing and we'd try to re-create it. lstat catches it.
    const legacyPresent = (() => {
      try {
        lstatSync(pair.legacyPath);
        return true;
      } catch {
        return false;
      }
    })();
    if (legacyPresent) {
      result.alreadyExists.push(pair);
      continue;
    }
    if (!existsSync(pair.newPath)) {
      result.newPathMissing.push(pair);
      continue;
    }
    try {
      await symlink(pair.newPath, pair.legacyPath, "dir");
      result.created.push(pair);
      log("info", "[alertforge] created legacy back-compat symlink", {
        from: pair.legacyPath,
        to: pair.newPath,
      });
    } catch (err) {
      result.failed.push({ pair, err });
      // EACCES / EPERM are expected when the server doesn't own /var or
      // /etc (most dev + container setups). Don't escalate.
      log("warn", "[alertforge] legacy symlink skipped", {
        from: pair.legacyPath,
        to: pair.newPath,
        err: err instanceof Error ? err.message : err,
      });
    }
  }

  return result;
}

function defaultLog(level: "info" | "warn", message: string, ctx?: Record<string, unknown>): void {
  // Imported lazily so this module stays importable from tests without
  // the pino-based logger setup.
  if (level === "warn") {
    console.warn(message, ctx ?? "");
  } else {
    console.log(message, ctx ?? "");
  }
}
