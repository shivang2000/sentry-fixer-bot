import { Button } from "@sentry-fixer-bot/ui/components/button";
import { Checkbox } from "@sentry-fixer-bot/ui/components/checkbox";
import { Input } from "@sentry-fixer-bot/ui/components/input";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sentry-fixer-bot/ui/components/select";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";

import { trpc } from "@/utils/trpc";

const Severity = z.enum(["low", "medium", "high", "critical"]);

const FormSchema = z.object({
  sentryProject: z.string().min(1, "Required"),
  github: z.string().regex(/^[^/]+\/[^/]+$/, "Expected owner/name"),
  defaultBranch: z.string().min(1, "Required"),
  // Optional. Empty → server auto-detects from the repo's tooling
  // markers (package.json, pyproject.toml, pom.xml, etc).
  testCommand: z.string(),
  prReviewersCsv: z.string(),
  dailyTokenCap: z.number().int().positive("Must be > 0"),
  dailyCostCapDollars: z.number().positive("Must be > 0"),
  minSeverityToFix: Severity,
  enabled: z.boolean(),
});

type FormValues = z.infer<typeof FormSchema>;

export type RepoInitial = {
  id: string;
  sentryProject: string;
  github: string;
  defaultBranch: string;
  testCommand: string;
  prReviewers: string[];
  dailyTokenCap: number;
  dailyCostCapCents: number;
  minSeverityToFix: "low" | "medium" | "high" | "critical";
  enabled: boolean;
};

const EMPTY_DEFAULTS: FormValues = {
  sentryProject: "",
  github: "",
  defaultBranch: "main",
  testCommand: "",
  prReviewersCsv: "",
  dailyTokenCap: 1_000_000,
  dailyCostCapDollars: 25,
  minSeverityToFix: "medium",
  enabled: true,
};

function valuesFrom(initial?: RepoInitial): FormValues {
  if (!initial) return EMPTY_DEFAULTS;
  return {
    sentryProject: initial.sentryProject,
    github: initial.github,
    defaultBranch: initial.defaultBranch,
    testCommand: initial.testCommand,
    prReviewersCsv: initial.prReviewers.join(", "),
    dailyTokenCap: initial.dailyTokenCap,
    dailyCostCapDollars: Math.round(initial.dailyCostCapCents) / 100,
    minSeverityToFix: initial.minSeverityToFix,
    enabled: initial.enabled,
  };
}

type Props = {
  mode: "create" | "edit";
  initial?: RepoInitial;
  onSuccess?: () => void;
  onCancel?: () => void;
};

export function RepoForm({ mode, initial, onSuccess, onCancel }: Props) {
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const invalidateList = () => qc.invalidateQueries({ queryKey: trpc.repos.list.queryKey() });
  const create = useMutation(trpc.repos.create.mutationOptions({ onSuccess: invalidateList }));
  const update = useMutation(trpc.repos.update.mutationOptions({ onSuccess: invalidateList }));

  const form = useForm({
    defaultValues: valuesFrom(initial),
    onSubmit: async ({ value }) => {
      setSubmitting(true);
      try {
        const payload = {
          sentryProject: value.sentryProject.trim(),
          github: value.github.trim(),
          defaultBranch: value.defaultBranch.trim(),
          testCommand: value.testCommand.trim(),
          prReviewers: value.prReviewersCsv
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          dailyTokenCap: value.dailyTokenCap,
          dailyCostCapCents: Math.round(value.dailyCostCapDollars * 100),
          minSeverityToFix: value.minSeverityToFix,
          enabled: value.enabled,
        };
        if (mode === "create") {
          await create.mutateAsync(payload);
          toast.success("Repo created");
        } else {
          if (!initial) throw new Error("missing_initial");
          await update.mutateAsync({ id: initial.id, ...payload });
          toast.success("Repo saved");
        }
        onSuccess?.();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      } finally {
        setSubmitting(false);
      }
    },
    validators: { onSubmit: FormSchema },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <form.Field name="sentryProject">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Sentry project</Label>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="backend-api"
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="github">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>GitHub repo</Label>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="acme-corp/api"
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="defaultBranch">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Default branch</Label>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="testCommand">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Test command (optional)</Label>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="auto-detect from package.json / pom.xml / pyproject.toml / …"
              />
              <p className="text-[11px] text-zinc-500">
                Leave blank to auto-detect. Override only if your CI uses a non-standard command,
                e.g.{" "}
                <code className="rounded bg-zinc-800 px-1">npm ci && npm run test:coverage</code>.
              </p>
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="prReviewersCsv">
          {(field) => (
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={field.name}>PR reviewers (comma-separated)</Label>
              <Input
                id={field.name}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder="@acme-corp/backend, alice"
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="dailyTokenCap">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Daily token cap</Label>
              <Input
                id={field.name}
                type="number"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(Number(e.target.value))}
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="dailyCostCapDollars">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Daily cost cap (USD)</Label>
              <Input
                id={field.name}
                type="number"
                step="0.5"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(Number(e.target.value))}
              />
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="minSeverityToFix">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor={field.name}>Min severity to fix</Label>
              <Select
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as FormValues["minSeverityToFix"])}
              >
                <SelectTrigger id={field.name}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="medium">medium</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                  <SelectItem value="critical">critical</SelectItem>
                </SelectContent>
              </Select>
              <FieldErrors errors={field.state.meta.errors} />
            </div>
          )}
        </form.Field>

        <form.Field name="enabled">
          {(field) => (
            <div className="flex items-center gap-2 pt-6">
              <Checkbox
                id={field.name}
                checked={field.state.value}
                onCheckedChange={(c) => field.handleChange(c === true)}
              />
              <Label htmlFor={field.name}>Enabled</Label>
            </div>
          )}
        </form.Field>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : mode === "create" ? "Create repo" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function FieldErrors({ errors }: { errors: Array<{ message?: string } | undefined> }) {
  const list = errors.filter((e): e is { message?: string } => Boolean(e));
  if (list.length === 0) return null;
  return (
    <p className="text-red-500 text-xs">{list.map((e) => e?.message ?? "Invalid").join(", ")}</p>
  );
}
