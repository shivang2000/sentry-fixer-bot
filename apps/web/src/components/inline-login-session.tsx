import { env } from "@sentry-fixer-bot/env/web";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { OAuthCard } from "@/components/oauth-card";
import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";

type LoginMessage =
  | { type: "stdout"; data: string }
  | { type: "oauth_url"; url: string; provider: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type LoginProvider = "claude" | "github" | "sentry" | "mcp";

function wsUrlFor(provider: LoginProvider): string {
  const http = env.VITE_SERVER_URL;
  const ws = http.replace(/^http/, "ws");
  return `${ws}/api/login/${provider}`;
}

type Props = {
  /**
   * Maps to the server's loginSpawn switch in chat-ws.ts. Adding a new
   * provider here also requires a corresponding branch on the server.
   */
  provider: LoginProvider;
  /**
   * Fired when the server reports `exit code 0` so the caller can refetch
   * the wizard's setup.status query and flip the step pill green.
   */
  onComplete?: () => void;
  /**
   * Fired when the user clicks the OAuthCard's Cancel button. Useful for
   * collapsing the inline-shell panel.
   */
  onCancel?: () => void;
  rows?: number;
};

/**
 * Single source of truth for the cloud-login flow. Mounts an xterm tied
 * to `/api/login/:provider`, surfaces OAuth URLs through the existing
 * OAuthCard, and forwards the pasted code back to the child's stdin.
 *
 * Reused by both /settings (the original "Cloud logins" card) and the
 * onboarding wizard at / (per-step "Open shell" button).
 */
export function InlineLoginSession({ provider, onComplete, onCancel, rows = 14 }: Props) {
  const termRef = useRef<XtermPanelHandle>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  useEffect(() => {
    const ws = new WebSocket(wsUrlFor(provider));
    wsRef.current = ws;
    ws.onmessage = (evt) => {
      let msg: LoginMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : "") as LoginMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "stdout":
          termRef.current?.write(msg.data);
          break;
        case "oauth_url":
          setOauthUrl(msg.url);
          break;
        case "exit":
          termRef.current?.writeln(`\r\n\x1b[33m●\x1b[0m Login flow ended (exit ${msg.code}).`);
          if (msg.code === 0) {
            toast.success(`${provider} login complete`);
            onComplete?.();
          }
          break;
        case "error":
          toast.error(msg.message);
          break;
      }
    };
    ws.onerror = () => toast.error("WebSocket error");
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [provider, onComplete]);

  return (
    <div className="space-y-3">
      {oauthUrl ? (
        <OAuthCard
          url={oauthUrl}
          onSubmit={(code) => {
            wsRef.current?.send(JSON.stringify({ type: "oauth_response", code }));
            setOauthUrl(null);
          }}
          onCancel={() => {
            setOauthUrl(null);
            wsRef.current?.close();
            onCancel?.();
          }}
        />
      ) : null}
      <XtermPanel
        ref={termRef}
        rows={rows}
        initialBanner={`▶ Starting ${provider} login…`}
        className="overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0a] p-2"
      />
    </div>
  );
}
