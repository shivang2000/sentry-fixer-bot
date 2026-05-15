import { createDb } from "@sentry-fixer-bot/db";
import { chatMessages, chatSessions } from "@sentry-fixer-bot/db/schema/admin";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { spawnClaudeInteractive } from "../chat/pty-runner";
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
    let handle: ReturnType<typeof spawnClaudeInteractive> | null = null;
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

export { websocket };
