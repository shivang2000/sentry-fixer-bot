import { Button } from "@alertforge/ui/components/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, Zap } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ManualUrlTrigger } from "@/components/triggers/manual-url-trigger";
import { TriggerCard } from "@/components/triggers/trigger-card";
import { trpc } from "@/utils/trpc";

export const Route = createFileRoute("/triggers/")({
  component: TriggersPage,
});

function TriggersPage() {
  const qc = useQueryClient();
  const list = useQuery(trpc.triggers.list.queryOptions());
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.triggers.list.queryKey() });

  const update = useMutation(trpc.triggers.update.mutationOptions({ onSuccess: invalidate }));
  const del = useMutation(trpc.triggers.delete.mutationOptions({ onSuccess: invalidate }));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-semibold text-2xl">
            <Zap className="h-5 w-5" /> Triggers
          </h1>
          <p className="text-sm text-zinc-500">
            Pipeline configs that bind an alert source (Sentry / PostHog / PagerDuty) to a repo with
            a preset + per-step model picks.
          </p>
        </div>
        <Link to="/triggers/new">
          <Button>
            <Plus className="mr-1.5 h-4 w-4" />
            New trigger
          </Button>
        </Link>
      </header>

      <ManualUrlTrigger compact />

      {list.isLoading ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : list.error ? (
        <p className="text-red-300 text-sm">{list.error.message}</p>
      ) : (list.data ?? []).length === 0 ? (
        <div className="rounded-md border border-zinc-800 border-dashed p-8 text-center">
          <p className="text-sm text-zinc-400">No triggers yet.</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            Triggers attach a pipeline config to a (source, project, repo) tuple. Click{" "}
            <strong>New trigger</strong> to wire your first one up.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(list.data ?? []).map((row) => (
            <TriggerCard
              key={row.trigger.id}
              row={row}
              onToggleEnabled={(id, next) => {
                update.mutate({ id, enabled: next });
              }}
              onDelete={(id, name) => setDeleteTarget({ id, name })}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        title={`Delete trigger ${deleteTarget?.name ?? ""}?`}
        description="Channels attached to this trigger are removed too. Past runs and PRs stay in history."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          await del.mutateAsync({ id: deleteTarget.id });
          toast.success("Trigger deleted");
          setDeleteTarget(null);
        }}
      />
    </div>
  );
}
