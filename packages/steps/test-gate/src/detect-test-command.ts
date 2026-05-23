import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type ResolvedTest = {
  command: string;
  source: "override" | "detected";
  /** Which ecosystem the detector matched on (debug + run-log surfacing). */
  ecosystem?:
    | "node"
    | "python"
    | "java-maven"
    | "java-gradle"
    | "go"
    | "rust"
    | "ruby"
    | "php"
    | "make";
};

/**
 * Resolve the test command for a workspace.
 *
 * Priority:
 *   1. Operator override (`repos.testCommand`) — wins unconditionally.
 *   2. Auto-detect by inspecting the worktree's project files. We support
 *      the major language ecosystems out-of-the-box so this works as an
 *      open-source product, not just on Node repos.
 *   3. `null` → no tests detected; the test gate is skipped.
 *
 * Detection is intentionally file-based (no LLM call) so it's
 * deterministic, free, and fast. Operators with non-standard setups
 * can still set `cfg.testCommand` explicitly.
 *
 * Per ecosystem, the priority is:
 *   - dedicated `test:coverage` script when available (CI parity),
 *   - else the canonical "run all tests" command for that toolchain.
 */
export async function resolveTestCommand(input: {
  cwd: string;
  override: string | null | undefined;
}): Promise<ResolvedTest | null> {
  const override = input.override?.trim();
  if (override) {
    return { command: override, source: "override" };
  }

  for (const detector of DETECTORS) {
    const hit = await detector(input.cwd);
    if (hit) return { ...hit, source: "detected" };
  }
  return null;
}

type Detector = (cwd: string) => Promise<Omit<ResolvedTest, "source"> | null>;

const DETECTORS: Detector[] = [
  detectNode,
  detectPython,
  detectMaven,
  detectGradle,
  detectGo,
  detectRust,
  detectRuby,
  detectPhp,
  detectMakefile,
];

async function detectNode(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  const pkg = await readJson<{ scripts?: Record<string, unknown> }>(join(cwd, "package.json"));
  if (!pkg) return null;
  const scripts = pkg.scripts ?? {};
  // Coverage-flavoured script names get priority for CI parity.
  // Two passes: try coverage names first, then plain test names. Each
  // pass walks its list in author-preference order — `test:coverage`
  // is the convention, but real repos use `jest:coverage`,
  // `test:cov`, `coverage`, `test:c8`, `test:nyc` interchangeably.
  const coverageNames = [
    "test:coverage",
    "test:cov",
    "coverage",
    "jest:coverage",
    "vitest:coverage",
    "test:c8",
    "test:nyc",
    "cov",
  ];
  const plainNames = ["test:ci", "ci-test", "test", "tests", "spec", "specs", "ci"];
  for (const name of [...coverageNames, ...plainNames]) {
    if (typeof scripts[name] === "string" && (scripts[name] as string).trim()) {
      // `npm run` works regardless of which package manager wrote the
      // lockfile because npm always resolves from package.json scripts.
      // Operator can override with `pnpm test` etc. if they care.
      return { command: `npm run ${name}`, ecosystem: "node" };
    }
  }
  return null;
}

async function detectPython(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  const pyproject = await readText(join(cwd, "pyproject.toml"));
  const reqs = await fileExists(join(cwd, "requirements.txt"));
  const setupPy = await fileExists(join(cwd, "setup.py"));
  const setupCfg = await fileExists(join(cwd, "setup.cfg"));
  const manage = await fileExists(join(cwd, "manage.py"));
  const toxIni = await fileExists(join(cwd, "tox.ini"));
  const hasTestsDir = (await fileExists(join(cwd, "tests"))) || (await hasTestFiles(cwd));

  if (!pyproject && !reqs && !setupPy && !setupCfg && !manage && !toxIni) return null;

  // Django gets its own command — `python manage.py test` is the
  // canonical entry point + most Django repos do not have pytest set up.
  if (manage) return { command: "python manage.py test", ecosystem: "python" };

  // Tox is a meta-runner that orchestrates everything — if it's
  // configured, the repo wants `tox` to drive the suite (matches CI).
  if (toxIni) return { command: "tox", ecosystem: "python" };

  // Coverage opt-in: when the repo already configures coverage in
  // pyproject (either [tool.coverage] or `pytest-cov` in deps),
  // append `--cov` so the gate's run matches CI.
  const wantsCov =
    pyproject &&
    (/\[tool\.coverage/i.test(pyproject) ||
      /pytest-cov/i.test(pyproject) ||
      /coverage\[toml\]/i.test(pyproject));
  const pytestArgs = wantsCov ? " --cov" : "";

  // Package-manager preference. The lockfile drives which `run`
  // wrapper resolves deps automatically — same idea as `pnpm test`
  // vs `npm test` on the JS side.
  if (await fileExists(join(cwd, "poetry.lock"))) {
    return { command: `poetry run pytest${pytestArgs}`, ecosystem: "python" };
  }
  if (await fileExists(join(cwd, "pdm.lock"))) {
    return { command: `pdm run pytest${pytestArgs}`, ecosystem: "python" };
  }
  if (await fileExists(join(cwd, "Pipfile"))) {
    return { command: `pipenv run pytest${pytestArgs}`, ecosystem: "python" };
  }

  if (pyproject && /\[tool\.pytest/i.test(pyproject)) {
    return { command: `pytest${pytestArgs}`, ecosystem: "python" };
  }
  if (hasTestsDir) {
    return { command: `pytest${pytestArgs}`, ecosystem: "python" };
  }
  // Fallback: unittest discovery — works for any std-lib test suite.
  if (pyproject || reqs || setupPy || setupCfg) {
    return { command: "python -m unittest discover", ecosystem: "python" };
  }
  return null;
}

async function detectMaven(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  const pom = await readText(join(cwd, "pom.xml"));
  if (!pom) return null;
  // `verify` runs integration tests (failsafe) on top of unit tests
  // (surefire); prefer it when failsafe is configured so the gate
  // covers the same goals CI does. Fall back to `test` for projects
  // that only have unit tests.
  // `-B` (batch mode) for non-TTY CI output; `--no-transfer-progress`
  // keeps logs sane in stdout.
  const wantsVerify = /maven-failsafe-plugin/i.test(pom);
  return {
    command: wantsVerify
      ? "mvn -B --no-transfer-progress verify"
      : "mvn -B --no-transfer-progress test",
    ecosystem: "java-maven",
  };
}

async function detectGradle(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  if (
    !(await fileExists(join(cwd, "build.gradle"))) &&
    !(await fileExists(join(cwd, "build.gradle.kts")))
  ) {
    return null;
  }
  // Prefer the wrapper if present so the build's pinned Gradle
  // version is used; otherwise fall back to the system `gradle`.
  const wrapper = await fileExists(join(cwd, "gradlew"));
  const gradleBin = wrapper ? "./gradlew" : "gradle";
  // `check` runs tests + verification plugins (jacoco, lint). Prefer
  // it when present to match what CI typically runs; fall back to the
  // plain `test` task otherwise. We don't grep the build file because
  // `check` is always defined by the `java` / `java-library` plugin.
  return {
    command: `${gradleBin} check`,
    ecosystem: "java-gradle",
  };
}

async function detectGo(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  if (await fileExists(join(cwd, "go.mod"))) {
    // `-race` catches data races for free; `-cover` produces summary
    // coverage output without writing a profile. Both are cheap and
    // match what most Go CIs run.
    return { command: "go test -race -cover ./...", ecosystem: "go" };
  }
  return null;
}

async function detectRust(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  if (!(await fileExists(join(cwd, "Cargo.toml")))) return null;
  // `cargo-nextest` is faster + has better failure isolation. Prefer
  // it when the repo opts in via a `.config/nextest.toml` or
  // `nextest.toml`. Otherwise fall back to vanilla `cargo test`.
  const hasNextest =
    (await fileExists(join(cwd, ".config", "nextest.toml"))) ||
    (await fileExists(join(cwd, "nextest.toml")));
  return {
    command: hasNextest ? "cargo nextest run" : "cargo test",
    ecosystem: "rust",
  };
}

async function detectRuby(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  if (!(await fileExists(join(cwd, "Gemfile")))) return null;
  // RSpec is dominant in modern Ruby; minitest/rake is the older
  // default. Prefer RSpec if a spec dir exists, else `rake test`.
  if ((await fileExists(join(cwd, "spec"))) || (await fileExists(join(cwd, ".rspec")))) {
    return { command: "bundle exec rspec", ecosystem: "ruby" };
  }
  return { command: "bundle exec rake test", ecosystem: "ruby" };
}

async function detectPhp(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  const composer = await readJson<{ scripts?: Record<string, unknown> }>(
    join(cwd, "composer.json"),
  );
  if (!composer) return null;
  const scripts = composer.scripts ?? {};
  // Same script-preference idea as the Node detector: coverage-named
  // scripts win when they exist, otherwise fall back to the canonical
  // `test`. Composer doesn't standardise names so we search broadly.
  for (const name of ["test:coverage", "test-coverage", "coverage", "test:ci", "test", "tests"]) {
    if (typeof scripts[name] === "string") {
      return { command: `composer run-script ${name}`, ecosystem: "php" };
    }
  }
  // PHPUnit is the de-facto standard. If composer is set up but no
  // recognised script is defined, run phpunit directly.
  if (await fileExists(join(cwd, "phpunit.xml"))) {
    return { command: "vendor/bin/phpunit", ecosystem: "php" };
  }
  return null;
}

async function detectMakefile(cwd: string): Promise<Omit<ResolvedTest, "source"> | null> {
  const mk = await readText(join(cwd, "Makefile"));
  if (!mk) return null;
  // `^test:` (start of line) or `^test :` — match a real target.
  if (/^test\s*:/m.test(mk)) {
    return { command: "make test", ecosystem: "make" };
  }
  return null;
}

// ---------- fs helpers ----------

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  const raw = await readText(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Cheap heuristic for "this repo has Python tests somewhere" when there
 * is no `tests/` directory at the root. Looks at the top-level only;
 * deep recursive scans would dominate the run cost on monorepos.
 */
async function hasTestFiles(cwd: string): Promise<boolean> {
  try {
    const entries = await readdir(cwd);
    return entries.some((e) => /^test_.*\.py$/.test(e) || /^.*_test\.py$/.test(e));
  } catch {
    return false;
  }
}
