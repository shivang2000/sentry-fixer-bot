import { Button } from "@alertforge/ui/components/button";
import { Checkbox } from "@alertforge/ui/components/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@alertforge/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@alertforge/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GitBranchPlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { RepoForm } from "@/components/repo-form";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/repos")({
  component: ReposPage,
});

function ReposPage() {
  const qc = useQueryClient();
  const list = useQuery(trpc.repos.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const del = useMutation(
    trpc.repos.delete.mutationOptions({
      onSuccess: () => qc.invalidateQueries({ queryKey: trpc.repos.list.queryKey() }),
    }),
  );

  if (list.isLoading) return <div className="p-6">Loading…</div>;
  if (list.error) return <div className="p-6 text-red-600">{list.error.message}</div>;
  const rows = list.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-semibold text-2xl">Repos</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setPickerOpen(true)}>
            <GitBranchPlus className="mr-1.5 h-4 w-4" />
            From GitHub
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add repo
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-center text-sm text-zinc-500">
          No repos configured yet. Click <strong>Add repo</strong> to register the first one.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sentry project</TableHead>
              <TableHead>GitHub</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead className="text-right">Daily cost</TableHead>
              <TableHead>Min severity</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">{r.sentryProject}</TableCell>
                <TableCell>{r.github}</TableCell>
                <TableCell>{r.defaultBranch}</TableCell>
                <TableCell className="text-right">
                  ${(r.dailyCostCapCents / 100).toFixed(2)}
                </TableCell>
                <TableCell>{r.minSeverityToFix}</TableCell>
                <TableCell>{r.enabled ? "✓" : "—"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Link to="/repos/$id" params={{ id: r.id }}>
                      <Button variant="ghost" size="icon" aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete"
                      onClick={() => setDeleteTarget({ id: r.id, name: r.sentryProject })}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add repo</DialogTitle>
          </DialogHeader>
          <RepoForm
            mode="create"
            onCancel={() => setCreateOpen(false)}
            onSuccess={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? ""}?`}
        description="This removes the repo configuration. Runs and PRs already created stay in history."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await del.mutateAsync({ id: deleteTarget.id });
          toast.success("Repo deleted");
          setDeleteTarget(null);
        }}
      />

      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import repos from GitHub</DialogTitle>
          </DialogHeader>
          <GhRepoPicker
            onDone={() => {
              setPickerOpen(false);
              qc.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function GhRepoPicker({ onDone }: { onDone: () => void }) {
  const auth = useQuery(trpc.gh.authStatus.queryOptions());
  const repos = useQuery({
    ...trpc.gh.listRepos.queryOptions(),
    enabled: !!auth.data?.authenticated,
  });
  const add = useMutation(
    trpc.gh.addRepos.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `Imported ${r.inserted} repo${r.inserted === 1 ? "" : "s"}` +
            (r.skipped > 0 ? ` (${r.skipped} already configured)` : ""),
        );
        onDone();
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allReposShown = useMemo(() => repos.data ?? [], [repos.data]);

  if (auth.isLoading) {
    return <p className="text-sm text-zinc-500">Checking gh auth…</p>;
  }
  if (!auth.data?.authenticated) {
    return (
      <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-amber-200 text-sm">
        gh is not logged in. Open{" "}
        <Link to="/settings" className="underline">
          /settings
        </Link>{" "}
        and run the <strong>Log in to GitHub</strong> flow first.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">
        Signed in as <span className="font-mono">{auth.data.account ?? "github user"}</span>. Pick
        the repos to register; defaults (<code>bun test</code>, $5/day cap) can be edited later from
        the row.
      </p>
      {repos.isLoading ? (
        <p className="text-sm text-zinc-500">Loading repos…</p>
      ) : repos.error ? (
        <p className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-red-300 text-sm">
          {repos.error.message}
        </p>
      ) : (
        <div className="max-h-80 space-y-1 overflow-auto rounded-md border border-zinc-800 p-2">
          {allReposShown.map((r) => {
            const toggle = () => {
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(r.nameWithOwner)) next.delete(r.nameWithOwner);
                else next.add(r.nameWithOwner);
                return next;
              });
            };
            return (
              <button
                type="button"
                key={r.nameWithOwner}
                onClick={toggle}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-800/50"
              >
                <Checkbox
                  checked={selected.has(r.nameWithOwner)}
                  onCheckedChange={toggle}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-sm">
                    {r.nameWithOwner}
                    {r.isPrivate ? (
                      <span className="rounded-md bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        private
                      </span>
                    ) : null}
                  </div>
                  {r.description ? (
                    <div className="truncate text-xs text-zinc-500">{r.description}</div>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={selected.size === 0 || add.isPending}
          onClick={() =>
            add.mutate({
              repos: allReposShown
                .filter((r) => selected.has(r.nameWithOwner))
                .map((r) => ({ nameWithOwner: r.nameWithOwner, defaultBranch: r.defaultBranch })),
            })
          }
        >
          {add.isPending ? "Importing…" : `Import ${selected.size}`}
        </Button>
      </div>
    </div>
  );
}
