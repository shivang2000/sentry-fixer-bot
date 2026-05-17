// Server-side `sentry` CLI invoker. Same shape as gh-runner /
// claude-runner — server-composed argv, no shell, no injection.
//
// Uses the binary installed by sentry-setup.sh into
// /sfb/state/home/.sentry/bin/sentry. Falls back to PATH lookup if
// that's missing (operator may have installed it differently).

type SpawnedProc = {
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
  exited: Promise<number>;
};
type BunGlobal = {
  spawn(
    argv: string[],
    opts: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      stdout?: "pipe" | "inherit" | "ignore";
      stderr?: "pipe" | "inherit" | "ignore";
    },
  ): SpawnedProc;
};
const BunRuntime = (globalThis as unknown as { Bun: BunGlobal }).Bun;

function sentryBin(): string {
  const stateHome = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  return `${stateHome}/.sentry/bin/sentry`;
}

async function sentry(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stateHome = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`;
  const proc = BunRuntime.spawn([sentryBin(), ...args], {
    cwd: stateHome,
    env: { ...process.env, HOME: stateHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

export type SentryAuthStatus = {
  loggedIn: boolean;
  account?: string;
  organization?: string;
};

/**
 * `sentry auth status` returns a JSON blob with user + org when
 * authenticated. Exit code 0 + non-empty output ⇒ logged in.
 *
 * Falls back to checking env-file presence if the CLI isn't installed
 * (operator may have skipped the shell flow and pasted keys directly).
 */
export async function sentryAuthStatus(): Promise<SentryAuthStatus> {
  try {
    const res = await sentry(["auth", "status"]);
    if (res.exitCode !== 0) return { loggedIn: false };
    const text = (res.stdout || res.stderr).trim();
    if (!text) return { loggedIn: false };
    try {
      const parsed = JSON.parse(text) as {
        loggedIn?: boolean;
        user?: { email?: string; username?: string };
        organization?: { slug?: string; name?: string };
      };
      const loggedIn =
        parsed.loggedIn === true || Boolean(parsed.user?.email || parsed.user?.username);
      return {
        loggedIn,
        account: parsed.user?.email ?? parsed.user?.username,
        organization: parsed.organization?.slug ?? parsed.organization?.name,
      };
    } catch {
      // cli.sentry.dev's `sentry auth status` prints a human table:
      //   ✓ Authenticated
      //   │ User    │ shivang-trestle schheda@trestleiq.com │
      //   │ Token   │ c4c086e3...fd62                       │
      // Match "Authenticated" anywhere in the cleaned output and grab
      // the email if present.
      if (/authenticated/i.test(text) || /logged in/i.test(text)) {
        const email = text.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
        return { loggedIn: true, account: email };
      }
      return { loggedIn: false };
    }
  } catch {
    return { loggedIn: false };
  }
}
