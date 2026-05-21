/**
 * Log-writer callback the binder needs. Same shape as
 * apps/server/src/runs/log.ts `appendRunLog`. Injecting it keeps the
 * step package free of any DB / apps/server dependency — the consumer
 * passes its own writer.
 */
export type AppendRunLog = (input: {
  runId: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
}) => Promise<void>;

/**
 * Bind a stream-parser to a run id. Returns an `onLine` callback
 * suitable for passing to spawnClaudeAgent. Each meaningful event
 * becomes one `run_logs` row keyed off the given run id.
 *
 * The `source` argument lets the UI distinguish primary-agent stream
 * events ("agent-stream") from reviewer-pass events ("reviewer-stream")
 * and follow-up-loop events ("followup-stream") even though all three
 * call the same claude binary with the same JSONL output format.
 *
 * `appendLog` is the writer the consumer wants the events delivered to.
 * apps/server passes its appendRunLog from src/runs/log.ts; tests can
 * pass an in-memory recorder.
 */
export function bindStreamToRunLogs(appendLog: AppendRunLog, runId: string, source: string) {
  return async (line: string): Promise<void> => {
    const ev = parseStreamEvent(line);
    if (!ev) return;
    // The `result` event's text is what parse-output.ts will read at
    // the end. Logging it again as a full chunk would be redundant
    // noise; the kind=result message is a short "claude finished"
    // line so the timeline marks the transition.
    await appendLog({
      runId,
      level: ev.level,
      source,
      message: ev.message,
    });
  };
}

/**
 * Parser for claude CLI `--output-format stream-json --verbose` output.
 *
 * The CLI emits one JSON object per line. We classify each into a
 * `ParsedStreamEvent` so callers can decide what to log + at what
 * verbosity. Unknown shapes return null so a future CLI rev that adds
 * event types degrades to "we just skip the line" rather than
 * crashing the worker.
 *
 * Conventions:
 *  - `kind` is the bucket the run_logs writer cares about.
 *  - `message` is the pre-formatted, single-line string to display.
 *  - `level` matches RunLogLevel so the writer can pass it straight
 *    through without further mapping.
 */

export type ParsedStreamEvent =
  | { kind: "assistant_text"; message: string; level: "info" }
  | { kind: "tool_use"; message: string; level: "info" | "debug" }
  | { kind: "tool_error"; message: string; level: "error" }
  | { kind: "system"; message: string; level: "debug" }
  | { kind: "result"; result: string; level: "debug"; message: string }
  | { kind: "raw"; message: string; level: "debug" };

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

interface AssistantEvent {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  content?: string;
  tool_use_id?: string;
}

export function parseStreamEvent(line: string): ParsedStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Non-JSON output (e.g. claude prints a warning before the JSONL
  // stream starts). Surface it as a raw debug line so the operator
  // can still see it without losing the rest of the stream.
  if (!trimmed.startsWith("{")) {
    return { kind: "raw", message: trimmed.slice(0, 400), level: "debug" };
  }

  let ev: AssistantEvent;
  try {
    ev = JSON.parse(trimmed) as AssistantEvent;
  } catch {
    return { kind: "raw", message: trimmed.slice(0, 400), level: "debug" };
  }

  switch (ev.type) {
    case "system":
      // Init noise (model name, mcp servers, session id). Skip.
      return null;

    case "assistant": {
      const blocks = ev.message?.content ?? [];
      // Flatten into a list of one-line entries, since a single
      // assistant message can mix text + tool_use blocks.
      const parts: ParsedStreamEvent[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) {
          // Collapse newlines so each "thought" is one log row.
          // Cap at 400 chars; the model's chain-of-thought can run
          // long, and we already store raw stdout for forensics.
          const compact = b.text.replace(/\s+/g, " ").trim();
          if (compact) {
            parts.push({
              kind: "assistant_text",
              message: compact.slice(0, 400),
              level: "info",
            });
          }
        } else if (b.type === "tool_use") {
          parts.push(formatToolUse(b));
        }
      }
      // Return the FIRST event; caller will see multiple lines
      // because each newline-delimited JSON event triggers one
      // parseStreamEvent call, so over the lifetime of the run,
      // every block gets surfaced. If a single event ever batches
      // multiple text/tool blocks, we lose the trailing ones —
      // observed in practice this is rare; safe trade-off vs.
      // returning a list and complicating the writer.
      return parts[0] ?? null;
    }

    case "user": {
      // tool_result blocks come back as `user` messages with a
      // synthetic content list. Skip non-errors; surface errors so
      // the operator sees why claude reissued the same tool.
      const blocks = ev.message?.content ?? [];
      for (const b of blocks) {
        if (b.type === "tool_result" && b.is_error) {
          const msg = (b.content ?? "(empty error)").slice(0, 400);
          return { kind: "tool_error", message: `✗ tool error: ${msg}`, level: "error" };
        }
      }
      return null;
    }

    case "result": {
      // Final event — has the assistant's last text. Caller uses it
      // for the `<summary>` parser; the run_logs entry is debug.
      return {
        kind: "result",
        result: ev.result ?? "",
        message: "claude finished (result event)",
        level: "debug",
      };
    }
  }

  return null;
}

function formatToolUse(b: ContentBlock): ParsedStreamEvent {
  const name = b.name ?? "tool";
  const input = b.input ?? {};

  // Important tools first (the ones whose call is interesting to
  // an operator watching the timeline). Compact, single-line form.
  if (name === "Bash") {
    const cmd = String(input.command ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      kind: "tool_use",
      message: `$ ${cmd.slice(0, 300)}`,
      level: "info",
    };
  }
  if (name === "Edit" || name === "MultiEdit") {
    return {
      kind: "tool_use",
      message: `✎ ${String(input.file_path ?? "")}`.slice(0, 300),
      level: "info",
    };
  }
  if (name === "Write") {
    return {
      kind: "tool_use",
      message: `✎ write ${String(input.file_path ?? "")}`.slice(0, 300),
      level: "info",
    };
  }
  if (name === "Read") {
    return {
      kind: "tool_use",
      message: `· read ${String(input.file_path ?? "")}`.slice(0, 300),
      level: "debug",
    };
  }
  if (name === "Glob") {
    return {
      kind: "tool_use",
      message: `· glob ${String(input.pattern ?? "")}`.slice(0, 300),
      level: "debug",
    };
  }
  if (name === "Grep") {
    return {
      kind: "tool_use",
      message: `· grep ${String(input.pattern ?? "")}`.slice(0, 300),
      level: "debug",
    };
  }
  if (name === "TodoWrite") {
    // The literal todo list is noisy. Just announce the call.
    return { kind: "tool_use", message: "· todo updated", level: "debug" };
  }
  // Unknown tool — show name + first input key as a hint.
  const firstKey = Object.keys(input)[0];
  const hint = firstKey ? ` ${firstKey}=${String(input[firstKey]).slice(0, 60)}` : "";
  return {
    kind: "tool_use",
    message: `· ${name}${hint}`,
    level: "debug",
  };
}
