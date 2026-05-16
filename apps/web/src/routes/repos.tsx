import { Button } from "@sentry-fixer-bot/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@sentry-fixer-bot/ui/components/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sentry-fixer-bot/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add repo
        </Button>
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
    </div>
  );
}
