import { env } from "@sentry-fixer-bot/env/web";
import { Button } from "@sentry-fixer-bot/ui/components/button";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Send } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";

import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";

type ServerMessage =
  | { type: "stdout"; data: string }
  | { type: "oauth_url"; url: string; sessionId: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type ChatTerminalHandle = {
  sendOAuthCode: (code: string) => void;
  endSession: () => void;
};

type Props = {
  sessionId: string;
  onOAuthPrompt: (url: string) => void;
  onExit: (code: number) => void;
};

function wsUrlFor(sessionId: string): string {
  const http = env.VITE_SERVER_URL;
  const ws = http.replace(/^http/, "ws");
  return `${ws}/api/chat/${sessionId}`;
}

export const ChatTerminal = forwardRef<ChatTerminalHandle, Props>(function ChatTerminal(
  { sessionId, onOAuthPrompt, onExit },
  ref,
) {
  const termRef = useRef<XtermPanelHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [input, setInput] = useState("");
  const [waitingOAuth, setWaitingOAuth] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = wsUrlFor(sessionId);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      termRef.current?.writeln(`\x1b[36m▶\x1b[0m Connected to session ${sessionId.slice(0, 8)}…`);
    };

    ws.onmessage = (evt) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : "") as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "stdout":
          termRef.current?.write(msg.data);
          break;
        case "oauth_url":
          setWaitingOAuth(true);
          onOAuthPrompt(msg.url);
          break;
        case "exit":
          termRef.current?.writeln(`\r\n\x1b[33m●\x1b[0m Session ended (exit code ${msg.code}).`);
          setConnected(false);
          onExit(msg.code);
          break;
        case "error":
          toast.error(msg.message);
          break;
      }
    };

    ws.onerror = () => toast.error("WebSocket error");
    ws.onclose = () => setConnected(false);

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, onOAuthPrompt, onExit]);

  useImperativeHandle(
    ref,
    () => ({
      sendOAuthCode(code: string) {
        wsRef.current?.send(JSON.stringify({ type: "oauth_response", code }));
        setWaitingOAuth(false);
      },
      endSession() {
        wsRef.current?.close();
      },
    }),
    [],
  );

  const send = () => {
    const text = input.trim();
    if (!text || !connected || waitingOAuth) return;
    wsRef.current?.send(JSON.stringify({ type: "user_input", data: text }));
    termRef.current?.writeln(`\x1b[2m> ${text}\x1b[0m`);
    setInput("");
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <XtermPanel
        ref={termRef}
        rows={24}
        initialBanner=""
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0a] p-2"
      />
      <div className="flex items-center gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            waitingOAuth
              ? "Waiting on OAuth response…"
              : connected
                ? "Message Claude…"
                : "Disconnected"
          }
          disabled={!connected || waitingOAuth}
        />
        <Button onClick={send} disabled={!connected || waitingOAuth || !input.trim()}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});
