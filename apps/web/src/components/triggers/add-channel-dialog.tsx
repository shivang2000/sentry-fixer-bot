import { Button } from "@sentry-fixer-bot/ui/components/button";
import { Checkbox } from "@sentry-fixer-bot/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@sentry-fixer-bot/ui/components/dialog";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sentry-fixer-bot/ui/components/select";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { RegistryConfigForm, type SchemaShape } from "@/components/registry-config-form";
import { trpc } from "@/utils/trpc";

type Props = {
  triggerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const NOTIFY_OPTIONS = [
  { value: "pr_opened", label: "PR opened" },
  { value: "triage_only", label: "Triage-only result" },
  { value: "failed", label: "Pipeline failure" },
  { value: "budget_blocked", label: "Budget blocked" },
  { value: "duplicate_pr", label: "Duplicate PR" },
  { value: "digest", label: "Daily digest" },
] as const;

export function AddChannelDialog({ triggerId, open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const adapters = useQuery(trpc.channels.listAdapters.queryOptions());
  const [type, setType] = useState<string>("");
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [notifyOn, setNotifyOn] = useState<string[]>(["pr_opened", "failed"]);
  const labelId = useId();

  // Reset state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setType("");
      setConfig({});
      setNotifyOn(["pr_opened", "failed"]);
    }
  }, [open]);

  const selectedAdapter = useMemo(
    () => (adapters.data ?? []).find((a) => a.type === type),
    [adapters.data, type],
  );

  const schema: SchemaShape = (selectedAdapter?.configSchema as SchemaShape | undefined) ?? {};

  const create = useMutation(
    trpc.channels.create.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.triggers.byId.queryKey({ id: triggerId }) });
        toast.success("Channel added");
        onOpenChange(false);
      },
      onError: (err) => toast.error(err.message),
    }),
  );

  const toggleNotify = (val: string) => {
    setNotifyOn((cur) => (cur.includes(val) ? cur.filter((v) => v !== val) : [...cur, val]));
  };

  const handleSave = () => {
    if (!type) {
      toast.error("Pick a channel type");
      return;
    }
    if (notifyOn.length === 0) {
      toast.error("Pick at least one notify-on status");
      return;
    }
    create.mutate({
      triggerId,
      channelType: type,
      notifyOn: notifyOn as Array<
        "pr_opened" | "triage_only" | "failed" | "budget_blocked" | "duplicate_pr" | "digest"
      >,
      config,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add channel</DialogTitle>
          <DialogDescription>
            Notifications fire when the pipeline reaches one of the selected statuses.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={labelId}>Channel type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v ?? "")}
              disabled={adapters.isLoading}
            >
              <SelectTrigger id={labelId}>
                <SelectValue placeholder={adapters.isLoading ? "Loading…" : "Pick a channel"} />
              </SelectTrigger>
              <SelectContent>
                {(adapters.data ?? []).map((a) => (
                  <SelectItem key={a.type} value={a.type}>
                    {a.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedAdapter ? (
              <p className="text-[11px] text-zinc-500">
                {selectedAdapter.catalogEntry.description}
              </p>
            ) : null}
          </div>

          {selectedAdapter ? (
            <>
              {Object.keys(selectedAdapter.requiresEnvKeysPresent ?? {}).length > 0 ? (
                <div className="rounded-md border border-zinc-800 p-2 text-[11px]">
                  {Object.entries(selectedAdapter.requiresEnvKeysPresent).map(([k, ok]) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className={ok ? "text-emerald-300" : "text-amber-300"}>
                        {ok ? "✓" : "•"}
                      </span>
                      <span className="font-mono">{k}</span>
                      <span className="text-zinc-500">
                        {ok ? "present in env" : "missing — set in /etc/alertforge/env"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              <RegistryConfigForm
                schema={schema}
                value={config}
                onChange={setConfig}
                disabled={create.isPending}
              />

              <fieldset className="space-y-2">
                <legend className="font-medium text-sm">Notify on</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {NOTIFY_OPTIONS.map((n) => {
                    const id = `${labelId}-notify-${n.value}`;
                    return (
                      <div key={n.value} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={notifyOn.includes(n.value)}
                          onCheckedChange={() => toggleNotify(n.value)}
                          disabled={create.isPending}
                        />
                        <Label htmlFor={id} className="font-normal">
                          {n.label}{" "}
                          <span className="ml-1 font-mono text-[10px] text-zinc-500">
                            {n.value}
                          </span>
                        </Label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
            </>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button disabled={!type || create.isPending} onClick={handleSave}>
              {create.isPending ? "Saving…" : "Add channel"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
