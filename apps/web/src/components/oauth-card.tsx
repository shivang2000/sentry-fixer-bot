import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import { Input } from "@alertforge/ui/components/input";
import { Label } from "@alertforge/ui/components/label";
import { ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";

type Props = {
  url: string;
  deviceCode?: string | null;
  /** Provider-aware copy. Defaults to Claude wording. */
  provider?: "claude" | "github" | "sentry" | "mcp";
  onSubmit: (code: string) => void;
  onCancel: () => void;
};

function copyText(
  provider: Props["provider"],
  hasDeviceCode: boolean,
): {
  title: string;
  description: string;
  pasteHint: boolean;
} {
  if (provider === "github") {
    return {
      title: "GitHub wants you to authenticate",
      description: hasDeviceCode
        ? "Open the URL below, enter the one-time code, then come back here — gh polls automatically."
        : "Open the URL below and authorize the device. gh will detect the result automatically.",
      pasteHint: false,
    };
  }
  if (provider === "sentry") {
    return {
      title: "Sentry wants you to authenticate",
      description:
        "Open the URL below, confirm the code on sentry.io, then return here — sentry-cli polls for the result.",
      pasteHint: false,
    };
  }
  return {
    title: "Claude wants you to authenticate",
    description:
      "Open the URL in your browser, complete the flow, and paste the returned code here.",
    pasteHint: true,
  };
}

export function OAuthCard({ url, deviceCode, provider, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState("");
  const copy = copyText(provider, !!deviceCode);
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-300">
          <KeyRound className="h-4 w-4" />
          {copy.title}
        </CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-start gap-1.5 break-all rounded-md border border-amber-500/30 bg-zinc-900/60 px-3 py-2 font-mono text-amber-200 text-xs hover:bg-zinc-900"
        >
          <span className="min-w-0 flex-1 break-all">{url}</span>
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
        </a>
        {deviceCode ? (
          <div className="space-y-1.5">
            <Label className="text-xs">One-time device code</Label>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(deviceCode)}
              className="w-full select-all rounded-md border border-amber-500/40 bg-zinc-900/80 px-4 py-3 text-center font-mono text-amber-200 text-xl tracking-widest hover:bg-zinc-900"
              title="Click to copy"
            >
              {deviceCode}
            </button>
            <p className="text-[11px] text-zinc-500">
              Type or paste this code on the page above. Click the box to copy.
            </p>
          </div>
        ) : null}
        {copy.pasteHint ? (
          <div className="space-y-1.5">
            <Label htmlFor="oauth-code">Auth code</Label>
            <Input
              id="oauth-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste here"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && code.trim()) onSubmit(code.trim());
              }}
            />
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          {copy.pasteHint ? "Cancel" : "Close"}
        </Button>
        {copy.pasteHint ? (
          <Button disabled={!code.trim()} onClick={() => onSubmit(code.trim())}>
            Submit
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
