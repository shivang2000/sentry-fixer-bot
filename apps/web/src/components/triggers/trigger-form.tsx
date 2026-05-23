import { Button } from "@sentry-fixer-bot/ui/components/button";
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
import { useId, useState } from "react";
import { toast } from "sonner";

import { AdvancedToggles, type AdvancedTogglesValue } from "@/components/triggers/advanced-toggles";
import { ModelPicker } from "@/components/triggers/model-picker";
import { PresetSelector, type PresetValue } from "@/components/triggers/preset-selector";
import { trpc } from "@/utils/trpc";

export type TriggerFormInitial = {
  id: string;
  repoId: string;
  sourceType: string;
  sourceProject: string;
  name: string;
  preset: PresetValue;
  config: {
    toggles?: Partial<AdvancedTogglesValue>;
    models?: Partial<Record<"classify" | "fix" | "review" | "followUp", string>>;
    budget?: Partial<{ dailyTokens: number; dailyCostCents: number }>;
  };
};

type Props = {
  mode: "create" | "edit";
  initial?: TriggerFormInitial;
  /** When the create wizard pre-picks a source from the URL query. */
  initialSource?: string;
  onSuccess?: (id: string) => void;
  onCancel?: () => void;
};

const DEFAULT_MODELS = {
  classify: "claude-haiku-4-5",
  fix: "claude-opus-4-7",
  review: "claude-sonnet-4-6",
  followUp: "claude-sonnet-4-6",
};

const DEFAULT_TOGGLES: AdvancedTogglesValue = {
  autoReview: false,
  followUpLoop: false,
  secretScanStrict: "block",
};

export function TriggerForm({ mode, initial, initialSource, onSuccess, onCancel }: Props) {
  const qc = useQueryClient();
  const sources = useQuery(trpc.triggers.listSourceAdapters.queryOptions());
  const repos = useQuery(trpc.repos.list.queryOptions());

  const [sourceType, setSourceType] = useState<string>(initial?.sourceType ?? initialSource ?? "");
  const [sourceProject, setSourceProject] = useState<string>(initial?.sourceProject ?? "");
  const [repoId, setRepoId] = useState<string>(initial?.repoId ?? "");
  const [name, setName] = useState<string>(initial?.name ?? "");
  const [preset, setPreset] = useState<PresetValue>(initial?.preset ?? "auto_fix");
  const [models, setModels] = useState<typeof DEFAULT_MODELS>({
    ...DEFAULT_MODELS,
    ...initial?.config?.models,
  });
  const [toggles, setToggles] = useState<AdvancedTogglesValue>({
    ...DEFAULT_TOGGLES,
    ...initial?.config?.toggles,
  });
  const [dailyTokens, setDailyTokens] = useState<number>(
    initial?.config?.budget?.dailyTokens ?? 1_000_000,
  );
  const [dailyCostCents, setDailyCostCents] = useState<number>(
    initial?.config?.budget?.dailyCostCents ?? 2_500,
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: trpc.triggers.list.queryKey() });
    if (initial?.id) {
      qc.invalidateQueries({ queryKey: trpc.triggers.byId.queryKey({ id: initial.id }) });
    }
  };

  const create = useMutation(trpc.triggers.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.triggers.update.mutationOptions({ onSuccess: invalidate }));

  const sourceId = useId();
  const projectId = useId();
  const repoSelId = useId();
  const nameId = useId();

  // P6: the spec calls for these models to grey out under non-custom
  // presets (matches ADR-0005). UI keeps them editable in `custom` only.
  const isCustom = preset === "custom";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceType || !sourceProject.trim() || !repoId || !name.trim()) {
      toast.error("Source, project, repo, and name are required");
      return;
    }
    const config = {
      toggles,
      models,
      budget: { dailyTokens, dailyCostCents },
    };
    try {
      if (mode === "create") {
        const inserted = await create.mutateAsync({
          repoId,
          sourceType,
          sourceProject: sourceProject.trim(),
          name: name.trim(),
          preset,
          config,
        });
        toast.success("Trigger created");
        onSuccess?.(inserted?.id ?? "");
      } else {
        if (!initial) throw new Error("missing_initial");
        await update.mutateAsync({
          id: initial.id,
          name: name.trim(),
          preset,
          config,
        });
        toast.success("Trigger saved");
        onSuccess?.(initial.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={sourceId}>Source</Label>
          <Select
            value={sourceType}
            onValueChange={(v) => setSourceType(v ?? "")}
            disabled={mode === "edit" || sources.isLoading}
          >
            <SelectTrigger id={sourceId}>
              <SelectValue placeholder={sources.isLoading ? "Loading…" : "Pick a source"} />
            </SelectTrigger>
            <SelectContent>
              {(sources.data ?? []).map((s) => (
                <SelectItem key={s.type} value={s.type}>
                  {s.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mode === "edit" ? (
            <p className="text-[11px] text-zinc-500">Source is immutable after creation.</p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={projectId}>Source project</Label>
          <Input
            id={projectId}
            value={sourceProject}
            disabled={mode === "edit"}
            onChange={(e) => setSourceProject(e.target.value)}
            placeholder="backend-api"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={repoSelId}>Repo</Label>
          <Select
            value={repoId}
            onValueChange={(v) => setRepoId(v ?? "")}
            disabled={mode === "edit"}
          >
            <SelectTrigger id={repoSelId}>
              <SelectValue placeholder="Pick a repo" />
            </SelectTrigger>
            <SelectContent>
              {(repos.data ?? []).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.github} <span className="ml-1 text-zinc-500">({r.sentryProject})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={nameId}>Display name</Label>
          <Input
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="backend-api alerts"
          />
        </div>
      </section>

      <section>
        <PresetSelector value={preset} onChange={setPreset} disabled={busy} />
      </section>

      <section className="space-y-4">
        <h2 className="font-medium text-sm">Models</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ModelPicker
            label="Classifier"
            value={models.classify}
            onChange={(v) => setModels({ ...models, classify: v })}
            disabled={busy || !isCustom}
            helperText={isCustom ? undefined : "Locked by preset"}
          />
          <ModelPicker
            label="Fix agent"
            value={models.fix}
            onChange={(v) => setModels({ ...models, fix: v })}
            disabled={busy || !isCustom}
            helperText={isCustom ? undefined : "Locked by preset"}
          />
          <ModelPicker
            label="Reviewer"
            value={models.review}
            onChange={(v) => setModels({ ...models, review: v })}
            disabled={busy || (!isCustom && preset !== "auto_fix_review")}
            helperText={
              preset === "auto_fix_review"
                ? "Active under Auto-fix + review"
                : isCustom
                  ? "Used when auto-review toggle is on"
                  : "Disabled by preset"
            }
          />
          <ModelPicker
            label="Follow-up agent"
            value={models.followUp}
            onChange={(v) => setModels({ ...models, followUp: v })}
            disabled={busy || !isCustom}
            helperText={
              isCustom ? "Used when follow-up /sfb loop toggle is on" : "Disabled by preset"
            }
          />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="font-medium text-sm">Budget</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="daily-tokens">Daily token cap</Label>
            <Input
              id="daily-tokens"
              type="number"
              value={dailyTokens}
              onChange={(e) => setDailyTokens(Number(e.target.value))}
              disabled={busy}
              min={0}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="daily-cost">Daily cost cap (USD)</Label>
            <Input
              id="daily-cost"
              type="number"
              step="0.5"
              value={(dailyCostCents / 100).toFixed(2)}
              onChange={(e) => setDailyCostCents(Math.round(Number(e.target.value) * 100))}
              disabled={busy}
              min={0}
            />
          </div>
        </div>
      </section>

      <section>
        <AdvancedToggles
          value={toggles}
          onChange={setToggles}
          disabled={busy || !isCustom}
          defaultOpen={isCustom}
        />
      </section>

      <div className="flex justify-end gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : mode === "create" ? "Create trigger" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
