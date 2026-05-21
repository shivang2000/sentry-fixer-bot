import { access } from "node:fs/promises";
import { join } from "node:path";

export type EnsureDepsResult = {
  ran: boolean;
  command: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Install project dependencies in `cwd` before the test gate runs.
 *
 * Mirrors the ecosystem detection used by `resolveTestCommand`: looks
 * for the lockfile and runs the matching package manager's
 * deterministic-install command. Unlike the test command, this one is
 * NOT operator-configurable — the lockfile dictates the only correct
 * install command, and forcing operators to set it would be
 * boilerplate.
 *
 * Per-ecosystem rules:
 *   - npm / pnpm / yarn / bun: `<pm> ci` or `<pm> install --frozen-lockfile`,
 *     falling back to `<pm> install` when the strict form lacks support.
 *   - Python: `<pm> install` for poetry/pdm/pipenv; `pip install -r reqs`
 *     for plain requirements.txt repos.
 *   - Maven / Gradle: skipped — `mvn test` / `gradle test` resolve their
 *     own deps via the local repo cache during the gate run.
 *   - Go / Rust: skipped — both toolchains fetch on `test`.
 *   - Ruby: `bundle install --quiet` when Gemfile present.
 *   - PHP: `composer install --no-progress` when composer.json present.
 *
 * Skips quietly when no recognised lockfile/manifest is present —
 * gate may still succeed for repos that don't need an install step.
 * Caller logs the result; non-zero exit is surfaced but does NOT
 * abort the gate (some installs warn but still populate node_modules).
 */
export async function ensureDeps(input: {
  cwd: string;
  timeoutSeconds?: number;
}): Promise<EnsureDepsResult> {
  const cmd = await detectInstallCommand(input.cwd);
  if (!cmd) {
    return { ran: false, command: null, exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }
  return runInstall(input.cwd, cmd, input.timeoutSeconds ?? 600);
}

async function detectInstallCommand(cwd: string): Promise<string[] | null> {
  // Node lockfiles in order: pnpm > yarn > bun > npm.
  // `npm ci` requires package-lock.json AND that node version matches
  // engines if pinned. Falls back to `npm install --no-audit` on failure
  // so we don't hard-fail on lockfile drift.
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) {
    return ["pnpm", "install", "--frozen-lockfile"];
  }
  if (await fileExists(join(cwd, "yarn.lock"))) {
    return ["yarn", "install", "--frozen-lockfile", "--non-interactive"];
  }
  if ((await fileExists(join(cwd, "bun.lockb"))) || (await fileExists(join(cwd, "bun.lock")))) {
    return ["bun", "install", "--frozen-lockfile"];
  }
  if (await fileExists(join(cwd, "package-lock.json"))) {
    // `--include=dev` overrides any `production` / `omit:dev` npmrc that
    // could be set on the container's npm config. Without this, devDeps
    // (jest, ts-jest, etc.) silently get skipped — see incident from
    // 2026-05-18 where claude spent 800s hunting a missing jest binary.
    return ["npm", "ci", "--include=dev", "--no-audit", "--prefer-offline"];
  }
  if (await fileExists(join(cwd, "package.json"))) {
    // No lockfile — fall back to npm install. Slower + non-deterministic
    // but better than skipping.
    return ["npm", "install", "--include=dev", "--no-audit"];
  }

  // Python
  if (await fileExists(join(cwd, "poetry.lock"))) {
    return ["poetry", "install", "--no-interaction"];
  }
  if (await fileExists(join(cwd, "pdm.lock"))) {
    return ["pdm", "install", "--no-interaction"];
  }
  if (await fileExists(join(cwd, "Pipfile.lock"))) {
    return ["pipenv", "install", "--deploy"];
  }
  if (await fileExists(join(cwd, "requirements.txt"))) {
    return ["pip", "install", "-r", "requirements.txt"];
  }

  // Ruby
  if (await fileExists(join(cwd, "Gemfile.lock"))) {
    return ["bundle", "install", "--quiet"];
  }

  // PHP
  if (await fileExists(join(cwd, "composer.lock"))) {
    return ["composer", "install", "--no-progress", "--no-interaction"];
  }

  // Maven / Gradle / Go / Rust intentionally skipped — their `test`
  // commands resolve deps via the local repo / module cache.
  return null;
}

async function runInstall(
  cwd: string,
  argv: string[],
  timeoutSeconds: number,
): Promise<EnsureDepsResult> {
  const t0 = performance.now();
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutSeconds * 1000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    ran: true,
    command: argv.join(" "),
    exitCode,
    stdout,
    stderr,
    durationMs: performance.now() - t0,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
