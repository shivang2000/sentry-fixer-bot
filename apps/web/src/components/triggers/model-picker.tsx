import { Label } from "@sentry-fixer-bot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sentry-fixer-bot/ui/components/select";
import { useId } from "react";

// V1 set of Anthropic models the agent supports. Order = surface order
// in the dropdown. Keep haiku at the top for the classifier — that's
// what the recommended preset picks.
export const MODEL_CHOICES = [
  { value: "claude-haiku-4-5", label: "Haiku 4.5", costPerAlert: "$0.001" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", costPerAlert: "$0.15–$0.30" },
  { value: "claude-opus-4-7", label: "Opus 4.7", costPerAlert: "$1.00–$1.50" },
] as const;

type Props = {
  label: string;
  value: string;
  onChange: (next: string) => void;
  helperText?: string;
  disabled?: boolean;
};

export function ModelPicker({ label, value, onChange, helperText, disabled }: Props) {
  const id = useId();
  // Selected model's cost-per-alert label, surfaced inline so operators
  // see the cost delta as they swap models.
  const selected = MODEL_CHOICES.find((m) => m.value === value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v ?? "")} disabled={disabled}>
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODEL_CHOICES.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label} <span className="ml-2 text-[10px] text-zinc-500">~{m.costPerAlert}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {helperText ? <p className="text-[11px] text-zinc-500">{helperText}</p> : null}
      {selected ? (
        <p className="text-[11px] text-zinc-500">
          est. cost / alert: <span className="font-mono">~{selected.costPerAlert}</span>
        </p>
      ) : null}
    </div>
  );
}
