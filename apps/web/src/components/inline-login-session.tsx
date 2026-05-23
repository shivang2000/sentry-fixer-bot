import { env } from "@alertforge/env/web";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { OAuthCard } from "@/components/oauth-card";
import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";

type LoginMessage =
  | { type: "stdout"; data: string }
  | { type: "oauth_url"; url: string; provider: string }
  | { type: "device_code"; code: string; provider: string }
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
  const [deviceCode, setDeviceCode] = useState<string | null>(null);

  // Stash callbacks in refs so the WebSocket effect only depends on
  // `provider`. Without this, a parent re-render creates a new
  // onComplete reference → useEffect re-fires → WS closes + reopens →
  // gh / claude / sentry get re-spawned every render → device codes
  // regenerate in a loop. That's the bug the operator hit on gh.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

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
        case "device_code":
          setDeviceCode(msg.code);
          // gh / sentry don't expect a stdin paste-back; ensure the card
          // surfaces even if it was dismissed earlier.
          setOauthUrl((prev) => prev ?? "");
          break;
        case "exit":
          termRef.current?.writeln(`\r\n\x1b[33m●\x1b[0m Login flow ended (exit ${msg.code}).`);
          if (msg.code === 0) {
            toast.success(`${provider} login complete`);
            onCompleteRef.current?.();
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
  }, [provider]);

  return (
    <div className="space-y-3">
      {oauthUrl !== null ? (
        <OAuthCard
          url={oauthUrl}
          deviceCode={deviceCode}
          provider={provider}
          onSubmit={(code) => {
            wsRef.current?.send(JSON.stringify({ type: "oauth_response", code }));
            setOauthUrl(null);
          }}
          onCancel={() => {
            setOauthUrl(null);
            setDeviceCode(null);
            wsRef.current?.close();
            onCancel?.();
          }}
        />
      ) : null}
      <XtermPanel
        ref={termRef}
        rows={rows}
        initialBanner={`▶ Starting ${provider} login…`}
        onInput={(data) => {
          // Forward every xterm keystroke (typed chars, arrows, Ctrl-C,
          // Enter as \r) straight to the child's stdin. Required for the
          // sentry-setup interactive script + `gh auth login` device-code
          // confirmations + any future provider that wants to read raw
          // stdin. Claude's setup-token also doesn't object — it ignores
          // bytes outside the OAuth-code paste.
          const ws = wsRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "stdin", data }));
        }}
        className="overflow-hidden rounded-md border border-zinc-800 bg-[#0a0a0a] p-2"
      />
    </div>
  );
}
