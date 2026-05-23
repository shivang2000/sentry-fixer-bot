import { Checkbox } from "@sentry-fixer-bot/ui/components/checkbox";
import { Label } from "@sentry-fixer-bot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@sentry-fixer-bot/ui/components/select";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";

export type AdvancedTogglesValue = {
  autoReview: boolean;
  followUpLoop: boolean;
  secretScanStrict: "block" | "warn";
};

type Props = {
  value: AdvancedTogglesValue;
  onChange: (next: AdvancedTogglesValue) => void;
  /**
   * When the preset is not `custom`, the toggles render disabled with
   * a "set by preset" indicator — matches ADR-0005's stance that
   * presets own the toggle state.
   */
  disabled?: boolean;
  defaultOpen?: boolean;
};

export function AdvancedToggles({ value, onChange, disabled, defaultOpen }: Props) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const idAuto = useId();
  const idLoop = useId();
  const idScan = useId();

  const set = <K extends keyof AdvancedTogglesValue>(k: K, v: AdvancedTogglesValue[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <div className="rounded-md border border-zinc-800">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-900/40"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          Advanced
        </span>
        {disabled ? (
          <span className="text-[11px] text-zinc-500">set by preset</span>
        ) : (
          <span className="text-[11px] text-zinc-500">{open ? "" : "expand"}</span>
        )}
      </button>
      {open ? (
        <div className="space-y-3 border-zinc-800 border-t px-3 py-3" aria-hidden={false}>
          <div className="flex items-center gap-2">
            <Checkbox
              id={idAuto}
              checked={value.autoReview}
              disabled={disabled}
              onCheckedChange={(c) => set("autoReview", c === true)}
            />
            <Label htmlFor={idAuto}>Override preset: auto-PR-review</Label>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={idLoop}
              checked={value.followUpLoop}
              disabled={disabled}
              onCheckedChange={(c) => set("followUpLoop", c === true)}
            />
            <Label htmlFor={idLoop}>Override preset: follow-up /sfb loop</Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={idScan}>Secret-scan strictness</Label>
            <Select
              value={value.secretScanStrict}
              onValueChange={(v) => set("secretScanStrict", (v ?? "block") as "block" | "warn")}
              disabled={disabled}
            >
              <SelectTrigger id={idScan}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="block">Block PR on secret-scan hit</SelectItem>
                <SelectItem value="warn">Warn-only (flag in PR description)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
    </div>
  );
}
