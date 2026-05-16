import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@sentry-fixer-bot/ui/components/card";
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
import { ExternalLink, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { McpInstallDialog } from "@/components/mcp-install-dialog";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/mcps")({
  component: McpsPage,
});

type Catalog = {
  id: string;
  name: string;
  description: string;
  envSchema: Record<string, { required: boolean; secret: boolean; description: string }>;
  tags: string[];
  homepage: string;
};

function McpsPage() {
  const qc = useQueryClient();
  const catalog = useQuery(trpc.mcps.catalog.queryOptions());
  const installed = useQuery(trpc.mcps.installed.queryOptions());
  const [installing, setInstalling] = useState<Catalog | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const uninstall = useMutation(
    trpc.mcps.uninstall.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.mcps.installed.queryKey() }),
    }),
  );

  return (
    <div className="p-6">
      <h1 className="mb-4 font-semibold text-2xl">MCP servers</h1>
      <Tabs defaultValue="catalog">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="installed">
            Installed{installed.data ? ` (${installed.data.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="catalog" className="mt-4">
          {catalog.isLoading ? (
            <p className="text-sm text-zinc-500">Loading catalog…</p>
          ) : catalog.error ? (
            <p className="text-red-500 text-sm">{catalog.error.message}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {(catalog.data ?? []).map((entry) => (
                <Card key={entry.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <CardTitle>{entry.name}</CardTitle>
                      <a
                        href={entry.homepage}
                        target="_blank"
                        rel="noreferrer"
                        className="text-zinc-500 hover:text-zinc-300"
                        aria-label="Homepage"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </div>
                    <CardDescription>{entry.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1.5">
                      {entry.tags.map((t) => (
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
                    <Button className="w-full" onClick={() => setInstalling(entry as Catalog)}>
                      Install
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="installed" className="mt-4">
          {installed.isLoading ? (
            <p className="text-sm text-zinc-500">Loading…</p>
          ) : (installed.data ?? []).length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-zinc-500">
              No MCPs installed yet. Browse the catalog to add one.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Catalog</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(installed.data ?? []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{m.displayName}</TableCell>
                    <TableCell className="font-mono text-xs">{m.catalogId}</TableCell>
                    <TableCell>{m.scope}</TableCell>
                    <TableCell>{m.repo ?? "—"}</TableCell>
                    <TableCell>{m.enabled ? "✓" : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Uninstall"
                        onClick={() => setDeleteTarget({ id: m.id, name: m.displayName })}
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

      <McpInstallDialog
        catalog={installing}
        onOpenChange={(o) => {
          if (!o) setInstalling(null);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Uninstall ${deleteTarget?.name ?? ""}?`}
        description="Secrets in /etc/sfb/env are not removed. Remove them via the settings page."
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
