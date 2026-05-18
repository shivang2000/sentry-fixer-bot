import { env } from "@sentry-fixer-bot/env/server";

export type SpawnResult = {
  exitCode: number;
  /** Raw stdout, newline-delimited stream-json events. */
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type SpawnOptions = {
  cwd: string;
  prompt: string;
  home?: string;
  mcpConfigPath?: string;
  timeoutSeconds?: number;
  /**
   * Called with each newline-delimited line from stdout as it arrives.
   * Lines are JSONL events from `--output-format stream-json` (when
   * `streaming` is true; default) — wire to a parser via
   * `stream-parser.ts` to classify into typed events.
   *
   * The returned promise is awaited before reading the next line, so
   * the callback can write to `run_logs` (which mutates a per-runId
   * seq counter that must be sequential) without racing. If the
   * callback throws, the spawn aborts.
   */
  onLine?: (line: string) => Promise<void> | void;
  /**
   * When false, falls back to the legacy text mode (no JSONL events).
   * Default true. Set false for callers that just want the final
   * answer and don't care about streaming.
   */
  streaming?: boolean;
};

/**
 * Spawn Claude Code CLI headlessly inside a per-run workspace.
 * Uses --dangerously-skip-permissions since the worktree is isolated.
 *
 * With `streaming: true` (the default), the CLI emits one JSON event
 * per line to stdout via `--output-format stream-json --verbose`. We
 * read incrementally and call `onLine` for each newline; callers can
 * surface tool calls and assistant text in real time. The full raw
 * stream is also accumulated into the returned `stdout` so existing
 * post-hoc parsers (e.g. parse-output's `<summary>` extractor) keep
 * working — they just operate on the JSONL string and read the
 * `result` event for the final assistant text.
 */
export async function spawnClaudeAgent(input: SpawnOptions): Promise<SpawnResult> {
  const streaming = input.streaming !== false;
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--model",
    env.CLAUDE_MODEL,
    "--effort",
    "high",
  ];
  if (streaming) {
    // `--verbose` is required when using stream-json with --print so
    // claude emits incremental events. Without --verbose, the CLI
    // batches the run into a single `result` event at the end —
    // operationally identical to non-stream mode and defeats the
    // point of the live timeline.
    args.push("--verbose", "--output-format", "stream-json");
  }
  if (input.mcpConfigPath) {
    // `--mcp-config=<path>` form, not space-separated. claude's
    // arg parser eats the next positional with the space form which
    // means the prompt itself is misread as the config path.
    args.push(`--mcp-config=${input.mcpConfigPath}`);
  }
  args.push(input.prompt);

  const t0 = performance.now();
  const proc = Bun.spawn([env.CLAUDE_BIN, ...args], {
    cwd: input.cwd,
    env: {
      ...process.env,
      // Only forward ANTHROPIC_API_KEY when set. Forwarding "" wins
      // over claude's own ~/.claude/.credentials.json — operator runs
      // `claude auth login`, key file is fine, but the agent saw an
      // empty env var and treated itself as unauthenticated.
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      // Pin HOME to the state volume so the session creds resolve.
      // input.home wins if provided (per-run isolated home).
      HOME: input.home ?? `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/home`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = (input.timeoutSeconds ?? env.AGENT_TIMEOUT_SECONDS) * 1000;
  const timer = setTimeout(() => proc.kill("SIGTERM"), timeout);

  const [stdout, stderr, exitCode] = await Promise.all([
    drainLineByLine(proc.stdout, input.onLine),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  return { exitCode, stdout, stderr, durationMs: performance.now() - t0 };
}

/**
 * Read a ReadableStream line-by-line while accumulating the full text.
 *
 * Bun.spawn's stdout is a web-standard ReadableStream<Uint8Array>. We
 * decode incrementally so partial UTF-8 sequences split across chunks
 * don't corrupt characters (stream mode of TextDecoder handles this).
 *
 * Newline splitter keeps trailing partial line in `buf` until either
 * another chunk completes it or the stream closes. On close, any
 * remaining buffered text becomes the final line — claude usually
 * terminates with \n but defending here is cheap.
 */
async function drainLineByLine(
  stream: ReadableStream<Uint8Array>,
  onLine: ((line: string) => Promise<void> | void) | undefined,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buf = "";
  let full = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    full += chunk;
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (onLine) await onLine(line);
    }
  }
  // Flush decoder + any trailing partial line.
  const tail = decoder.decode();
  if (tail) {
    full += tail;
    buf += tail;
  }
  if (buf.length > 0 && onLine) await onLine(buf);
  return full;
}
