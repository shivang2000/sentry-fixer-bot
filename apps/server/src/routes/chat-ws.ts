import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "@sentry-fixer-bot/db";
import { chatMessages, chatSessions } from "@sentry-fixer-bot/db/schema/admin";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { type PtyHandle, spawnClaudeInteractive, spawnPtyCommand } from "../chat/pty-runner";
import { detectOAuthPrompt } from "../chat/url-detector";
import { log } from "../log";

const { upgradeWebSocket, websocket } = createBunWebSocket();

export const chatWs = new Hono();

// Per-session work dir on the state volume. Each chat session gets its
// own subdir so claude / agent transcripts / scratch don't collide. The
// dir survives container restarts (it's on /sfb/state in container mode
// or /var/lib/sfb in EC2 mode).
function workDirFor(sessionId: string): string {
  const base = process.env.WORK_DIR ?? "/var/lib/sfb/work";
  return join(base, sessionId);
}

type ClientMsg =
  | { type: "init"; cols?: number; rows?: number }
  | { type: "stdin"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "oauth_response"; code: string }
  | { type: "user_input"; data: string }; // legacy

function parseClientMsg(raw: ArrayBuffer | string): ClientMsg | null {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
  try {
    return JSON.parse(text) as ClientMsg;
  } catch {
    return null;
  }
}

chatWs.get(
  "/api/chat/:sessionId",
  upgradeWebSocket((c) => {
    const sessionIdRaw = c.req.param("sessionId");
    if (!sessionIdRaw) throw new Error("sessionId required");
    const sessionId: string = sessionIdRaw;
    let handle: PtyHandle | null = null;
    let outBuffer = "";
    let startFn: ((cols?: number, rows?: number) => Promise<void>) | null = null;
    const db = createDb();

    return {
      async onOpen(_evt, ws) {
        const wireStreams = (h: PtyHandle) => {
          h.proc.stdout.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf8");
            outBuffer += text;
            if (outBuffer.length > 32_000) outBuffer = outBuffer.slice(-16_000);
            ws.send(JSON.stringify({ type: "stdout", data: text }));
            const oauth = detectOAuthPrompt(outBuffer);
            if (oauth) {
              ws.send(JSON.stringify({ type: "oauth_url", url: oauth.url, sessionId }));
              outBuffer = "";
            }
          });
          h.proc.stderr.on("data", (chunk: Buffer) => {
            ws.send(JSON.stringify({ type: "stdout", data: chunk.toString("utf8") }));
          });
          h.proc.on("exit", async (code) => {
            ws.send(JSON.stringify({ type: "exit", code }));
            await db
              .update(chatSessions)
              .set({ status: "exited", endedAt: new Date() })
              .where(eq(chatSessions.id, sessionId));
          });
        };

        startFn = async (cols?: number, rows?: number) => {
          if (handle) return;
          const cwd = workDirFor(sessionId);
          await mkdir(cwd, { recursive: true }).catch(() => undefined);
          handle = spawnClaudeInteractive({ cwd, prompt: "", cols, rows });
          await db
            .update(chatSessions)
            .set({ status: "running", pid: handle.proc.pid ?? null })
            .where(eq(chatSessions.id, sessionId));
          wireStreams(handle);
        };

        // If the client never sends init (broken or legacy), spawn after
        // 2s with a default size so we don't hang the WS forever.
        setTimeout(() => {
          if (!handle && startFn) startFn().catch(() => undefined);
        }, 2000);

        ws.send(JSON.stringify({ type: "ready", sessionId }));
      },

      async onMessage(evt, ws) {
        const msg = parseClientMsg(evt.data as ArrayBuffer | string);
        if (!msg) return;

        if (msg.type === "init") {
          try {
            await startFn?.(msg.cols, msg.rows);
          } catch (e) {
            log.error({ err: e instanceof Error ? e.message : e }, "chat: spawn failed");
            ws.send(JSON.stringify({ type: "error", message: "spawn_failed" }));
            ws.close();
          }
          return;
        }

        if (!handle) return;

        // Raw keystrokes from xterm (arrows, ctrl-keys, plain chars, etc.)
        // are forwarded byte-for-byte. No `\n` injection — xterm sends
        // the actual key including the CR when the user presses Enter.
        if (msg.type === "stdin") handle.write(msg.data);

        // Legacy line-buffered protocol kept while we migrate clients.
        if (msg.type === "user_input" && msg.data) handle.write(`${msg.data}\n`);

        if (msg.type === "oauth_response" && msg.code) handle.write(`${msg.code}\n`);

        // Live resize not supported by util-linux script(1). Recorded for
        // the next spawn — clients that really need a different size
        // should reconnect (closing + reopening the WS).
        if (msg.type === "resize") {
          log.info({ cols: msg.cols, rows: msg.rows }, "chat: resize requested (deferred)");
        }

        if (msg.type === "stdin" || msg.type === "user_input" || msg.type === "oauth_response") {
          await db.insert(chatMessages).values({
            sessionId,
            role: msg.type === "oauth_response" ? "oauth_response" : "user",
            content: msg.type === "oauth_response" ? msg.code : msg.data,
          });
        }
      },

      async onClose() {
        handle?.kill();
        await db
          .update(chatSessions)
          .set({ status: "closed", endedAt: new Date() })
          .where(eq(chatSessions.id, sessionId));
      },
    };
  }),
);

// --- Login WS routes: drive `claude setup-token` or `gh auth login` ---------
//
// Both reuse the same PTY + URL-detector machinery. `?provider=…` picks
// the command, server streams stdout, surfaces OAuth URLs via the same
// `oauth_url` message, forwards `oauth_response` codes to the child's
// stdin. Sessions are not persisted to chat_sessions — these are
// short-lived auth flows.

type LoginProvider = "claude" | "github" | "sentry" | "mcp";

function loginSpawn(provider: LoginProvider): PtyHandle {
  if (provider === "claude") {
    // `claude setup-token` is the CLI's non-interactive OAuth entry point —
    // prints "Browser didn't open? Use the URL below" + URL, then waits on
    // stdin for the pasted auth code. `claude /login` is a TUI slash command
    // gated behind the first-run theme picker and is not callable headlessly.
    return spawnPtyCommand({
      cmd: "claude",
      args: ["setup-token"],
      cwd: process.cwd(),
    });
  }
  if (provider === "github") {
    // `gh auth login --web` prints a one-time device code + URL.
    return spawnPtyCommand({
      cmd: "gh",
      args: ["auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"],
      cwd: process.cwd(),
    });
  }
  if (provider === "mcp") {
    // Read-only probe — show what claude thinks of every configured MCP
    // server so the operator can debug a "Missing: …" line on the wizard.
    return spawnPtyCommand({
      cmd: "claude",
      args: ["mcp", "list"],
      cwd: process.cwd(),
    });
  }
  // sentry — runs the interactive setup script that prompts for token +
  // org slug, validates against the Sentry API, writes to the env file.
  return spawnPtyCommand({
    cmd: "bun",
    args: ["run", `${process.cwd()}/apps/server/src/cli/sentry-setup.ts`],
    cwd: process.cwd(),
  });
}

const VALID_PROVIDERS = new Set<LoginProvider>(["claude", "github", "sentry", "mcp"]);

chatWs.get(
  "/api/login/:provider",
  upgradeWebSocket((c) => {
    const providerRaw = c.req.param("provider");
    const provider: LoginProvider = VALID_PROVIDERS.has(providerRaw as LoginProvider)
      ? (providerRaw as LoginProvider)
      : "claude";
    let handle: PtyHandle | null = null;
    let outBuffer = "";

    return {
      onOpen(_evt, ws) {
        try {
          handle = loginSpawn(provider);
        } catch (e) {
          log.error({ err: e instanceof Error ? e.message : e }, "login: spawn failed");
          ws.send(JSON.stringify({ type: "error", message: "spawn_failed" }));
          ws.close();
          return;
        }

        handle.proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          outBuffer += text;
          if (outBuffer.length > 32_000) outBuffer = outBuffer.slice(-16_000);
          ws.send(JSON.stringify({ type: "stdout", data: text }));
          const oauth = detectOAuthPrompt(outBuffer);
          if (oauth) {
            ws.send(JSON.stringify({ type: "oauth_url", url: oauth.url, provider }));
            outBuffer = "";
          }
        });
        handle.proc.stderr.on("data", (chunk: Buffer) => {
          ws.send(JSON.stringify({ type: "stdout", data: chunk.toString("utf8") }));
        });
        handle.proc.on("exit", (code) => {
          ws.send(JSON.stringify({ type: "exit", code }));
        });
      },

      onMessage(evt, _ws) {
        const msg = parseClientMsg(evt.data as ArrayBuffer | string);
        if (!msg || !handle) return;
        if (msg.type === "stdin") handle.write(msg.data);
        if (msg.type === "user_input" && msg.data) handle.write(`${msg.data}\n`);
        if (msg.type === "oauth_response" && msg.code) handle.write(`${msg.code}\n`);
      },

      onClose() {
        handle?.kill();
      },
    };
  }),
);

export { websocket };
