import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sentry-fixer-bot/ui/components/dialog";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sentry-fixer-bot/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";
import { trpc } from "@/utils/trpc";

type EnvSpec = { required: boolean; secret: boolean; description: string };
type Catalog = {
  id: string;
  name: string;
  description: string;
  envSchema: Record<string, EnvSpec>;
};

type Props = {
  catalog: Catalog | null;
  onOpenChange: (open: boolean) => void;
};

export function McpInstallDialog({ catalog, onOpenChange }: Props) {
  const qc = useQueryClient();
  const termRef = useRef<XtermPanelHandle>(null);

  const repos = useQuery(trpc.repos.list.queryOptions());
  const install = useMutation(
    trpc.mcps.install.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.mcps.installed.queryKey() }),
    }),
  );

  const [scope, setScope] = useState<"global" | "repo">("global");
  const [repo, setRepo] = useState<string>("");
  const [envValues, setEnvValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (catalog) {
      setEnvValues({});
      setScope("global");
      setRepo("");
    }
  }, [catalog]);

  if (!catalog) return null;
  const envKeys = Object.entries(catalog.envSchema);

  const handleSubmit = async () => {
    const missing = envKeys.filter(([k, s]) => s.required && !envValues[k]?.trim());
    if (missing.length > 0) {
      toast.error(`Required: ${missing.map(([k]) => k).join(", ")}`);
      return;
    }
    if (scope === "repo" && !repo) {
      toast.error("Pick a repo for repo scope");
      return;
    }
    setBusy(true);
    const term = termRef.current;
    term?.clear();
    term?.writeln(`\x1b[36m▶\x1b[0m Installing \x1b[1m${catalog.name}\x1b[0m...`);
    term?.writeln(`  scope=${scope}${scope === "repo" ? ` repo=${repo}` : ""}`);
    if (envKeys.some(([_, s]) => s.secret)) {
      term?.writeln("  writing secrets to /etc/sfb/env...");
    }
    try {
      await install.mutateAsync({
        catalogId: catalog.id,
        scope,
        repo: scope === "repo" ? repo : undefined,
        envValues,
      });
      term?.writeln("  reloading systemd services...");
      term?.writeln("\x1b[32m✓\x1b[0m Installed.");
      toast.success(`${catalog.name} installed`);
      setTimeout(() => onOpenChange(false), 1200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "install_failed";
      term?.writeln(`\x1b[31m✗\x1b[0m Failed: ${msg}`);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={catalog !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install {catalog.name}</DialogTitle>
          <DialogDescription>{catalog.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scope">Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as "global" | "repo")}>
                <SelectTrigger id="scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global">Global</SelectItem>
                  <SelectItem value="repo">Per-repo</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {scope === "repo" ? (
              <div className="space-y-1.5">
                <Label htmlFor="repo">Repo</Label>
                <Select value={repo} onValueChange={(v) => setRepo(v ?? "")}>
                  <SelectTrigger id="repo">
                    <SelectValue placeholder="Pick a repo" />
                  </SelectTrigger>
                  <SelectContent>
                    {(repos.data ?? []).map((r) => (
                      <SelectItem key={r.id} value={r.sentryProject}>
                        {r.sentryProject}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>

          {envKeys.length > 0 ? (
            <div className="space-y-3">
              <h3 className="font-medium text-sm">Environment</h3>
              {envKeys.map(([key, spec]) => (
                <div key={key} className="space-y-1.5">
                  <Label htmlFor={key} className="font-mono text-xs">
                    {key} {spec.required ? <span className="text-red-500">*</span> : null}
                  </Label>
                  <Input
                    id={key}
                    type={spec.secret ? "password" : "text"}
                    value={envValues[key] ?? ""}
                    onChange={(e) => setEnvValues((v) => ({ ...v, [key]: e.target.value }))}
                    placeholder={spec.description}
                  />
                  <p className="text-xs text-zinc-500">{spec.description}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No env vars needed for this MCP.</p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Install log</Label>
            <XtermPanel ref={termRef} rows={8} initialBanner="Ready.\r\n" />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={handleSubmit}>
              {busy ? "Installing…" : "Install"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
