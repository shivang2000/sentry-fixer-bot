import { Label } from "@sentry-fixer-bot/ui/components/label";
import { useId } from "react";

/**
 * Four-radio preset selector with inline cost-estimate copy per ADR-0005.
 * Uses a native `<input type="radio">` over a custom RadioGroup primitive
 * so VoiceOver / keyboard nav work out of the box, matching the spec's
 * a11y note for the preset selector.
 *
 * Cost estimates are hard-coded today; ${"-"}/usage page will derive these
 * from real usage data in a follow-up.
 */
type Preset = {
  value: "auto_fix" | "triage_only" | "auto_fix_review" | "custom";
  label: string;
  costEstimate: string;
  description: string;
  recommended?: boolean;
};

export const PRESETS: readonly Preset[] = [
  {
    value: "auto_fix",
    label: "Auto-fix",
    costEstimate: "$1.00–$1.50 / alert",
    recommended: true,
    description: "Classify → fix → open PR. Default.",
  },
  {
    value: "triage_only",
    label: "Triage-only",
    costEstimate: "$0.001 / alert",
    description: "Classify the alert; never open a PR. Cheapest baseline.",
  },
  {
    value: "auto_fix_review",
    label: "Auto-fix + review",
    costEstimate: "$1.50–$2.50 / alert",
    description: "Auto-fix, then a reviewer pass that can downgrade PR to draft.",
  },
  {
    value: "custom",
    label: "Custom",
    costEstimate: "varies",
    description: "Pick advanced toggles individually.",
  },
];

export type PresetValue = Preset["value"];

type Props = {
  value: PresetValue;
  onChange: (next: PresetValue) => void;
  disabled?: boolean;
};

export function PresetSelector({ value, onChange, disabled }: Props) {
  const groupName = useId();
  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="mb-1 font-medium text-sm">Mode</legend>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {PRESETS.map((p) => {
          const id = `${groupName}-${p.value}`;
          const isSelected = value === p.value;
          return (
            <label
              key={p.value}
              htmlFor={id}
              className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${
                isSelected
                  ? "border-indigo-500 bg-indigo-500/5"
                  : "border-zinc-800 hover:border-zinc-600"
              }`}
            >
              <input
                id={id}
                type="radio"
                name={groupName}
                className="mt-1 h-4 w-4"
                value={p.value}
                checked={isSelected}
                onChange={() => onChange(p.value)}
                disabled={disabled}
              />
              <div className="flex-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={id} className="font-medium">
                    {p.label}
                    {p.recommended ? (
                      <span className="ml-2 rounded-full bg-emerald-500/10 px-1.5 py-0.5 font-medium text-[10px] text-emerald-300">
                        recommended
                      </span>
                    ) : null}
                  </Label>
                  <span className="text-[11px] text-zinc-500">{p.costEstimate}</span>
                </div>
                {p.description ? (
                  <p className="mt-0.5 text-xs text-zinc-500">{p.description}</p>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
