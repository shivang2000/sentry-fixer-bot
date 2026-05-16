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

chatWs.get(
  "/api/chat/:sessionId",
  upgradeWebSocket((c) => {
    const sessionIdRaw = c.req.param("sessionId");
    if (!sessionIdRaw) throw new Error("sessionId required");
    const sessionId: string = sessionIdRaw;
    let handle: PtyHandle | null = null;
    let outBuffer = "";
    const db = createDb();

    return {
      async onOpen(_evt, ws) {
        try {
          handle = spawnClaudeInteractive({ cwd: process.cwd(), prompt: "" });
        } catch (e) {
          log.error({ err: e instanceof Error ? e.message : e }, "chat: spawn failed");
          ws.send(JSON.stringify({ type: "error", message: "spawn_failed" }));
          ws.close();
          return;
        }

        await db
          .update(chatSessions)
          .set({ status: "running", pid: handle.proc.pid ?? null })
          .where(eq(chatSessions.id, sessionId));

        handle.proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          outBuffer += text;
          ws.send(JSON.stringify({ type: "stdout", data: text }));
          const oauth = detectOAuthPrompt(outBuffer);
          if (oauth) {
            ws.send(JSON.stringify({ type: "oauth_url", url: oauth.url, sessionId }));
            outBuffer = "";
          }
        });
        handle.proc.stderr.on("data", (chunk: Buffer) => {
          ws.send(JSON.stringify({ type: "stdout", data: chunk.toString("utf8") }));
        });
        handle.proc.on("exit", async (code) => {
          ws.send(JSON.stringify({ type: "exit", code }));
          await db
            .update(chatSessions)
            .set({ status: "exited", endedAt: new Date() })
            .where(eq(chatSessions.id, sessionId));
        });
      },

      async onMessage(evt, _ws) {
        if (!handle) return;
        const raw =
          typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
        const msg = JSON.parse(raw) as { type: string; data?: string; code?: string };
        if (msg.type === "user_input" && msg.data) handle.write(`${msg.data}\n`);
        if (msg.type === "oauth_response" && msg.code) handle.write(`${msg.code}\n`);
        await db.insert(chatMessages).values({
          sessionId,
          role: msg.type === "oauth_response" ? "oauth_response" : "user",
          content: msg.data ?? msg.code ?? "",
        });
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

// --- Login WS routes: drive `claude /login` or `gh auth login` ---------------
//
// Both reuse the same PTY + URL-detector machinery. Clients pass `?provider=…`
// in the URL; the handler picks the command, streams stdout, surfaces OAuth
// URLs via the same `oauth_url` message, and forwards `oauth_response` codes
// to the child's stdin. Sessions are not persisted to chat_sessions — these
// are short-lived auth flows.

function loginSpawn(provider: "claude" | "github"): PtyHandle {
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
  // `gh auth login --web` prints a one-time device code + URL.
  return spawnPtyCommand({
    cmd: "gh",
    args: ["auth", "login", "--web", "--git-protocol", "https", "--hostname", "github.com"],
    cwd: process.cwd(),
  });
}

chatWs.get(
  "/api/login/:provider",
  upgradeWebSocket((c) => {
    const providerRaw = c.req.param("provider");
    const provider: "claude" | "github" = providerRaw === "github" ? "github" : "claude";
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
        if (!handle) return;
        const raw =
          typeof evt.data === "string"
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
        const msg = JSON.parse(raw) as { type: string; data?: string; code?: string };
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
