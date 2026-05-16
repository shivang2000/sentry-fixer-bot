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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sentry-fixer-bot/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sentry-fixer-bot/ui/components/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { CommandRunner } from "@/components/command-runner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { XtermPanel, type XtermPanelHandle } from "@/components/xterm-panel";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/skills")({
  component: SkillsPage,
});

function SkillsPage() {
  const qc = useQueryClient();
  const catalog = useQuery(trpc.skills.catalog.queryOptions());
  const installed = useQuery(trpc.skills.list.queryOptions());

  const invalidateList = () => qc.invalidateQueries({ queryKey: trpc.skills.list.queryKey() });

  const installBuiltin = useMutation(
    trpc.skills.installBuiltin.mutationOptions({ onSuccess: invalidateList }),
  );
  const installCustom = useMutation(
    trpc.skills.installCustom.mutationOptions({ onSuccess: invalidateList }),
  );
  const uninstall = useMutation(
    trpc.skills.uninstall.mutationOptions({ onSuccess: invalidateList }),
  );

  const termRef = useRef<XtermPanelHandle>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [shQuery, setShQuery] = useState("");
  const shList = useQuery({
    ...trpc.skills.shList.queryOptions({ q: shQuery }),
    enabled: false, // explicit refetch only
  });

  const handleInstallBuiltin = async (catalogId: string, name: string) => {
    termRef.current?.clear();
    termRef.current?.writeln(`\x1b[36m▶\x1b[0m Installing built-in: \x1b[1m${name}\x1b[0m`);
    try {
      await installBuiltin.mutateAsync({ catalogId, scope: "global" });
      termRef.current?.writeln("\x1b[32m✓\x1b[0m Installed.");
      toast.success(`${name} installed`);
    } catch (err) {
      const m = err instanceof Error ? err.message : "install_failed";
      termRef.current?.writeln(`\x1b[31m✗\x1b[0m Failed: ${m}`);
      toast.error(m);
    }
  };

  const handleCustomUpload = async (file: File) => {
    termRef.current?.clear();
    termRef.current?.writeln(`\x1b[36m▶\x1b[0m Uploading \x1b[1m${file.name}\x1b[0m...`);
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
    const base64 = btoa(bin);
    try {
      await installCustom.mutateAsync({
        name: file.name.replace(/\.zip$/i, ""),
        scope: "global",
        filename: file.name,
        base64Zip: base64,
      });
      termRef.current?.writeln("\x1b[32m✓\x1b[0m Installed.");
      toast.success("Custom skill installed");
    } catch (err) {
      const m = err instanceof Error ? err.message : "install_failed";
      termRef.current?.writeln(`\x1b[31m✗\x1b[0m Failed: ${m}`);
      toast.error(m);
    }
  };

  return (
    <div className="p-6">
      <h1 className="mb-4 font-semibold text-2xl">Skills</h1>
      <Tabs defaultValue="builtin">
        <TabsList>
          <TabsTrigger value="builtin">Built-in</TabsTrigger>
          <TabsTrigger value="custom">Custom upload</TabsTrigger>
          <TabsTrigger value="sh">skills.sh</TabsTrigger>
          <TabsTrigger value="git">Git URL</TabsTrigger>
          <TabsTrigger value="installed">
            Installed{installed.data ? ` (${installed.data.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builtin" className="mt-4 space-y-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {(catalog.data ?? []).map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle>{s.name}</CardTitle>
                  <CardDescription>{s.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {s.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </CardContent>
                <CardFooter>
                  <Button
                    className="w-full"
                    disabled={installBuiltin.isPending}
                    onClick={() => handleInstallBuiltin(s.id, s.name)}
                  >
                    Install
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
          <SharedLog termRef={termRef} />
        </TabsContent>

        <TabsContent value="custom" className="mt-4 space-y-4">
          <CustomUpload busy={installCustom.isPending} onUpload={handleCustomUpload} />
          <SharedLog termRef={termRef} />
        </TabsContent>

        <TabsContent value="sh" className="mt-4 space-y-4">
          <div className="flex gap-2">
            <Input
              value={shQuery}
              onChange={(e) => setShQuery(e.target.value)}
              placeholder="Search skills.sh…"
              onKeyDown={(e) => {
                if (e.key === "Enter") shList.refetch();
              }}
            />
            <Button onClick={() => shList.refetch()} disabled={shList.isFetching}>
              {shList.isFetching ? "Searching…" : "Search"}
            </Button>
          </div>
          {!shList.data ? (
            <p className="text-sm text-zinc-500">Search the public skills.sh catalog.</p>
          ) : !shList.data.ok ? (
            <div className="rounded-md border border-dashed p-6 text-sm">
              <p className="mb-3 text-zinc-400">skills.sh API is not reachable right now.</p>
              <a
                href="https://skills.sh"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-indigo-400 hover:underline"
              >
                Browse skills.sh in a new tab <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              {shList.data.results.length} result(s). (Render TBD when API contract is firm.)
            </p>
          )}
        </TabsContent>

        <TabsContent value="git" className="mt-4 space-y-4">
          <GitInstallForm
            onInstalled={() => {
              qc.invalidateQueries({ queryKey: trpc.skills.list.queryKey() });
            }}
          />
          <CommandRunner
            title="Run a command on the state volume"
            description="Allowlisted: npm / npx / pnpm / bun / git clone. Use this for one-off installs that don't fit the form above."
            placeholder="git clone --depth 1 https://github.com/obra/superpowers"
            onSuccess={() => qc.invalidateQueries({ queryKey: trpc.skills.list.queryKey() })}
          />
        </TabsContent>

        <TabsContent value="installed" className="mt-4">
          {(installed.data ?? []).length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-zinc-500">
              No skills installed yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(installed.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.name}</TableCell>
                    <TableCell className="font-mono text-xs">{s.sourceType}</TableCell>
                    <TableCell>{s.scope}</TableCell>
                    <TableCell>{s.repo ?? "—"}</TableCell>
                    <TableCell>{s.enabled ? "✓" : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Uninstall"
                        onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Uninstall ${deleteTarget?.name ?? ""}?`}
        description="This removes the skill from disk; agent runs will no longer see it."
        confirmLabel="Uninstall"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await uninstall.mutateAsync({ id: deleteTarget.id });
          toast.success("Uninstalled");
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function CustomUpload({
  busy,
  onUpload,
}: {
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hover, setHover] = useState(false);

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!file.name.endsWith(".zip")) {
      toast.error("Only .zip files accepted");
      return;
    }
    onUpload(file);
  };

  return (
    <section
      aria-label="Upload skill zip"
      className={`rounded-md border-2 border-dashed p-8 text-center transition-colors ${
        hover ? "border-indigo-500 bg-indigo-500/5" : "border-zinc-700"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        handleFile(e.dataTransfer.files[0] ?? null);
      }}
    >
      <Upload className="mx-auto mb-2 h-8 w-8 text-zinc-500" />
      <Label htmlFor="custom-zip" className="cursor-pointer text-sm">
        Drop a .zip here or click to upload (max 5MB)
      </Label>
      <Input
        ref={inputRef}
        id="custom-zip"
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
      />
      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Choose file"}
        </Button>
      </div>
    </section>
  );
}

function SharedLog({ termRef }: { termRef: React.RefObject<XtermPanelHandle | null> }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Install log</Label>
      <XtermPanel ref={termRef} rows={8} initialBanner="Ready.\r\n" />
    </div>
  );
}

function GitInstallForm({ onInstalled }: { onInstalled: () => void }) {
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const mutate = useMutation(
    trpc.skills.installFromGit.mutationOptions({
      onSuccess: () => {
        toast.success("Skill cloned");
        setUrl("");
        setRef("");
        setName("");
        onInstalled();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Install from a git URL</CardTitle>
        <CardDescription>
          Shallow-clones the repo into the state volume's skills dir and registers an install row.
          Only https://github.com/ and https://gitlab.com/ URLs are accepted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="git-url">Repository URL</Label>
          <Input
            id="git-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/obra/superpowers"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="git-ref">Ref (optional)</Label>
            <Input
              id="git-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="main"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="git-name">Display name (optional)</Label>
            <Input
              id="git-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="superpowers"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            disabled={!url.trim() || mutate.isPending}
            onClick={() =>
              mutate.mutate({
                url: url.trim(),
                ref: ref.trim() || undefined,
                name: name.trim() || undefined,
                scope: "global",
              })
            }
          >
            {mutate.isPending ? "Cloning…" : "Install"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
