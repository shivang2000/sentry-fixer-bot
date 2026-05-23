import { env } from "@alertforge/env/web";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "sonner";

import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";

type ServerMessage =
  | { type: "ready"; sessionId: string }
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
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ws = new WebSocket(wsUrlFor(sessionId));
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      // Tell the server what size the terminal is right now. The server
      // spawns claude with `stty cols X rows Y` so the TUI renders at the
      // right width from the first byte.
      const size = termRef.current?.size() ?? { cols: 140, rows: 36 };
      ws.send(JSON.stringify({ type: "init", cols: size.cols, rows: size.rows }));
      termRef.current?.focus();
    };

    ws.onmessage = (evt) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : "") as ServerMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          // Server is up; the actual claude spawn fires after our init.
          break;
        case "stdout":
          termRef.current?.write(msg.data);
          break;
        case "oauth_url":
          onOAuthPrompt(msg.url);
          break;
        case "exit":
          termRef.current?.writeln(`\r\n\x1b[33m●\x1b[0m Session ended (exit ${msg.code}).`);
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

  // Forward EVERY keystroke from xterm directly to the server as a
  // stdin message. Arrow keys, Ctrl-C, Esc, Tab, plain chars — all of
  // them arrive in `data` already encoded the way the terminal wants
  // them on the wire.
  const handleInput = (data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "stdin", data }));
  };

  useImperativeHandle(
    ref,
    () => ({
      sendOAuthCode(code: string) {
        wsRef.current?.send(JSON.stringify({ type: "oauth_response", code }));
      },
      endSession() {
        wsRef.current?.close();
      },
    }),
    [],
  );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <XtermPanel
        ref={termRef}
        rows={36}
        onInput={handleInput}
        initialBanner=""
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0a] p-2"
      />
      {!connected ? <div className="px-1 pt-1 text-xs text-zinc-500">Disconnected.</div> : null}
    </div>
  );
});
