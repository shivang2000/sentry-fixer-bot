import { mkdir } from "node:fs/promises";
import { createDb } from "@alertforge/db";
import { chatMessages, chatSessions } from "@alertforge/db/schema/admin";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { type PtyHandle, spawnClaudeInteractive, spawnPtyCommand } from "../chat/pty-runner";
import { detectDeviceCode, detectOAuthPrompt } from "../chat/url-detector";
import { log } from "../log";

const { upgradeWebSocket, websocket } = createBunWebSocket();

export const chatWs = new Hono();

// Chat sessions all share a single persistent dev folder on the state
// volume. Operators clone repos into /alertforge/state/dev, run things across
// sessions, and the work survives session.end / container restart. Per-
// session isolation belongs to agent runs (which still use WORK_DIR =
// /alertforge/state/work/<runId>) — chat is for humans, not the bot.
function workDirFor(_sessionId: string): string {
  return (
    process.env.ALERTFORGE_CHAT_DIR ??
    `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/dev`
  );
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

        if (msg.type === "oauth_response" && msg.code) {
          // Forward exactly what the user pasted, no terminator. Some
          // CLIs (claude setup-token) reject the input when an extra
          // \n / \r is appended; let the operator type Enter inside
          // the xterm if their CLI actually needs a line terminator.
          const cleaned = msg.code.replace(/[\r\n\s]+$/g, "").replace(/^\s+/, "");
          log.info(
            { len: cleaned.length, head: cleaned.slice(0, 6), tail: cleaned.slice(-4) },
            "login: oauth_response forwarded",
          );
          // Real xterm Enter on a PTY sends CR (\r), which the kernel
          // line discipline converts to \n before the reader sees it.
          // We're writing into the PTY master, so emit \r exactly like
          // a keyboard would — the ICRNL termios bit on the slave side
          // turns it into the \n claude's readline waits for.
          handle.write(`${cleaned}\r`);
        }

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
  // HOME must point at the state volume so every CLI's dotfiles
  // (.claude/, .config/gh/, .sentry/, .sentryclirc) persist across
  // container recreations. bun's inherited process.env.HOME is /root
  // (runuser populates HOME from /etc/passwd in container mode), so we
  // can't fall back to it — always compute from ALERTFORGE_STATE_DIR.
  const stateHome = `${process.env.ALERTFORGE_STATE_DIR ?? "/alertforge/state"}/home`;

  if (provider === "claude") {
    // `claude auth login` is the CLI's documented user-facing OAuth
    // entry point. Prints the URL, the user opens it externally,
    // pastes the returned code back into stdin. Persists creds to
    // ~/.claude/.credentials.json (we pin HOME so that lands on the
    // state volume). `claude setup-token` is the older flow and has
    // proven flaky to drive headlessly.
    return spawnPtyCommand({
      cmd: "claude",
      args: ["auth", "login"],
      cwd: process.cwd(),
      env: { HOME: stateHome },
    });
  }
  if (provider === "github") {
    // `gh auth login --web` prints a one-time device code + URL. The
    // --git-protocol arg pre-answers gh's "Choose default git protocol"
    // prompt so the user only has to hit Enter on the device-code page.
    return spawnPtyCommand({
      cmd: "gh",
      args: ["auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"],
      cwd: process.cwd(),
      env: { HOME: stateHome },
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
  // sentry — installs sentry-cli onto the state volume (if missing),
  // runs `sentry-cli login` for the official OAuth flow, then hands off
  // to a bun shim that writes the token + org slug into the env file.
  return spawnPtyCommand({
    cmd: "bash",
    args: [`${process.cwd()}/apps/server/src/cli/sentry-setup.sh`],
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

        let sentDeviceCode: string | null = null;
        let sentOauthUrl: string | null = null;
        handle.proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          outBuffer += text;
          if (outBuffer.length > 32_000) outBuffer = outBuffer.slice(-16_000);
          ws.send(JSON.stringify({ type: "stdout", data: text }));
          const oauth = detectOAuthPrompt(outBuffer);
          if (oauth && oauth.url !== sentOauthUrl) {
            sentOauthUrl = oauth.url;
            ws.send(JSON.stringify({ type: "oauth_url", url: oauth.url, provider }));
            // Don't reset outBuffer — device code often appears *after*
            // the URL (gh) or in the URL itself (sentry-cli). Dedup is
            // handled by the sentOauthUrl guard above; without it the
            // OAuthCard re-mounts with the same URL on every stdout
            // chunk, making the operator think the submit looped.
          }
          // Claude is paste-back; it has no device code. Skip the
          // detector entirely to avoid false positives matching parts
          // of the OAuth URL's state parameter.
          const code = provider === "claude" ? null : detectDeviceCode(outBuffer);
          if (code && code !== sentDeviceCode) {
            sentDeviceCode = code;
            ws.send(JSON.stringify({ type: "device_code", code, provider }));
            // gh + sentry-cli both pause after printing the device code
            // with a "Press Enter to open the URL in your browser…"
            // prompt. Auto-press Enter so the CLI flips into polling.
            // claude is paste-back, NOT device-code, so don't auto-Enter
            // for it — the operator's Submit on the OAuthCard sends the
            // code itself; an unrequested Enter just kicks off a
            // second blank-line prompt that confuses readline.
            if (handle && provider !== "claude") handle.write("\r");
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
        if (msg.type === "oauth_response" && msg.code) {
          // Forward exactly what the user pasted, no terminator. Some
          // CLIs (claude setup-token) reject the input when an extra
          // \n / \r is appended; let the operator type Enter inside
          // the xterm if their CLI actually needs a line terminator.
          const cleaned = msg.code.replace(/[\r\n\s]+$/g, "").replace(/^\s+/, "");
          log.info(
            { len: cleaned.length, head: cleaned.slice(0, 6), tail: cleaned.slice(-4) },
            "login: oauth_response forwarded",
          );
          // Split the write: code first, then \r as a separate chunk
          // 50ms later. Some readers see one big blob and ignore the
          // trailing terminator. Splitting mimics a human typing then
          // hitting Enter. \r goes through PTY ICRNL → \n for the
          // reader, matching what an xterm Enter keypress would do.
          handle.write(cleaned);
          const h = handle;
          setTimeout(() => {
            try {
              h.write("\r");
            } catch {
              // proc already exited
            }
          }, 50);
        }
      },

      onClose() {
        handle?.kill();
      },
    };
  }),
);

export { websocket };
