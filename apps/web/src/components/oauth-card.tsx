import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import { ExternalLink, KeyRound } from "lucide-react";
import { useState } from "react";

type Props = {
  url: string;
  onSubmit: (code: string) => void;
  onCancel: () => void;
};

export function OAuthCard({ url, onSubmit, onCancel }: Props) {
  const [code, setCode] = useState("");
  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-300">
          <KeyRound className="h-4 w-4" />
          Claude wants you to authenticate
        </CardTitle>
        <CardDescription>
          Open the URL below in your browser, complete the flow, and paste the returned code here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 break-all rounded-md border border-amber-500/30 bg-zinc-900/60 px-3 py-2 font-mono text-amber-200 text-xs hover:bg-zinc-900"
        >
          {url}
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
        </a>
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
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!code.trim()} onClick={() => onSubmit(code.trim())}>
          Submit
        </Button>
      </CardFooter>
    </Card>
  );
}
