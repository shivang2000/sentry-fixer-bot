import { Button } from "@alertforge/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@alertforge/ui/components/card";
import { useMutation } from "@tanstack/react-query";
import { Play, Terminal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { trpc } from "@/utils/trpc";

type RunResult = {
  cmd: string;
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

type Props = {
  title?: string;
  description?: string;
  placeholder?: string;
  onSuccess?: () => void;
};

export function CommandRunner({
  title = "Run a command",
  description = "Allowed prefixes: npm, npx, pnpm, bun, git clone. Output is capped at 64 KB. 5-minute timeout.",
  placeholder = "npx -y @sentry/mcp-server --help",
  onSuccess,
}: Props) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const run = useMutation(
    trpc.system.runCommand.mutationOptions({
      onSuccess: (r) => {
        setResult(r);
        if (r.exitCode === 0) {
          toast.success("Command succeeded");
          onSuccess?.();
        } else {
          toast.error(`Exit ${r.exitCode}`);
        }
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Terminal className="h-4 w-4" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        <div className="flex justify-end">
          <Button
            disabled={!command.trim() || run.isPending}
            onClick={() => run.mutate({ command: command.trim() })}
          >
            <Play className="mr-1.5 h-4 w-4" />
            {run.isPending ? "Running…" : "Run"}
          </Button>
        </div>
        {result ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span
                className={
                  result.exitCode === 0
                    ? "rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-emerald-400"
                    : "rounded-md bg-red-500/10 px-1.5 py-0.5 text-red-400"
                }
              >
                exit {result.exitCode}
              </span>
              <span className="font-mono text-zinc-500">
                {result.cmd} {result.args.join(" ")}
              </span>
              {result.truncated ? (
                <span className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                  truncated
                </span>
              ) : null}
            </div>
            {result.stdout ? (
              <pre className="max-h-72 overflow-auto rounded-md border border-zinc-800 bg-[#0a0a0a] p-2 font-mono text-xs text-zinc-200">
                {result.stdout}
              </pre>
            ) : null}
            {result.stderr ? (
              <pre className="max-h-48 overflow-auto rounded-md border border-red-900/40 bg-red-950/20 p-2 font-mono text-red-300 text-xs">
                {result.stderr}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
