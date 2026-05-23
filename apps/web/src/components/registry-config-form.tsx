import { Checkbox } from "@alertforge/ui/components/checkbox";
import { Input } from "@alertforge/ui/components/input";
import { Label } from "@alertforge/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@alertforge/ui/components/select";
import { useId } from "react";

/**
 * A descriptor for a single field as walked from a zod schema on the
 * server (see channels.ts `describeZodObject`). The dynamic form reads
 * this shape and renders one input per key — string/number/boolean/
 * enum/stringArray. Anything else falls back to a JSON textarea.
 *
 * This same component is intended to power BOTH:
 *   - AddChannelDialog → renders a channel adapter's configSchema
 *   - (future) source adapter project-config form in TriggerForm
 *   - (refactor target) McpInstallDialog → envSchema-style maps to
 *     a simple Record<key, string> shape; not migrated in P6 to avoid
 *     touching unrelated UI semantics in this single PR. Keep that
 *     as a follow-up.
 */
export type FieldDescriptor =
  | { kind: "string"; format?: "url" | "email"; optional: boolean; default?: string }
  | { kind: "number"; optional: boolean; default?: number; min?: number; max?: number }
  | { kind: "boolean"; optional: boolean; default?: boolean }
  | { kind: "enum"; values: string[]; optional: boolean; default?: string }
  | { kind: "stringArray"; optional: boolean; min?: number; max?: number }
  | { kind: "unknown"; optional: boolean };

export type SchemaShape = Record<string, FieldDescriptor>;

type Props = {
  schema: SchemaShape;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Disable every field — used while a mutation is in flight. */
  disabled?: boolean;
};

export function RegistryConfigForm({ schema, value, onChange, disabled }: Props) {
  const setField = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-4">
      {Object.entries(schema).map(([key, field]) => (
        <FieldRow
          key={key}
          fieldKey={key}
          field={field}
          value={value[key]}
          disabled={disabled}
          onChange={(v) => setField(key, v)}
        />
      ))}
      {Object.keys(schema).length === 0 ? (
        <p className="text-sm text-zinc-500">No configuration required.</p>
      ) : null}
    </div>
  );
}

function FieldRow({
  fieldKey,
  field,
  value,
  disabled,
  onChange,
}: {
  fieldKey: string;
  field: FieldDescriptor;
  value: unknown;
  disabled?: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const label = humanize(fieldKey);

  if (field.kind === "string") {
    const v = typeof value === "string" ? value : (field.default ?? "");
    const type = field.format === "email" ? "email" : field.format === "url" ? "url" : "text";
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {!field.optional ? <span className="ml-1 text-red-500">*</span> : null}
        </Label>
        <Input
          id={id}
          type={type}
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.format ?? ""}
          aria-required={!field.optional}
        />
      </div>
    );
  }

  if (field.kind === "number") {
    const v = typeof value === "number" ? value : (field.default ?? 0);
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {!field.optional ? <span className="ml-1 text-red-500">*</span> : null}
        </Label>
        <Input
          id={id}
          type="number"
          value={v}
          min={field.min}
          max={field.max}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-required={!field.optional}
        />
      </div>
    );
  }

  if (field.kind === "boolean") {
    const v = typeof value === "boolean" ? value : (field.default ?? false);
    return (
      <div className="flex items-center gap-2">
        <Checkbox
          id={id}
          checked={v}
          disabled={disabled}
          onCheckedChange={(c) => onChange(c === true)}
        />
        <Label htmlFor={id}>{label}</Label>
      </div>
    );
  }

  if (field.kind === "enum") {
    const v = typeof value === "string" ? value : (field.default ?? field.values[0] ?? "");
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {!field.optional ? <span className="ml-1 text-red-500">*</span> : null}
        </Label>
        <Select value={v} onValueChange={(next) => onChange(next ?? "")} disabled={disabled}>
          <SelectTrigger id={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.values.map((val) => (
              <SelectItem key={val} value={val}>
                {val}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (field.kind === "stringArray") {
    // Chip input: comma-separated text; we split on save. Keeps the
    // dependency surface zero (no chip-input library) and matches the
    // PR-reviewers CSV pattern in repo-form.tsx.
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>
          {label}
          {!field.optional ? <span className="ml-1 text-red-500">*</span> : null}
          <span className="ml-2 text-[11px] text-zinc-500">(comma-separated)</span>
        </Label>
        <Input
          id={id}
          value={arr.join(", ")}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          aria-required={!field.optional}
        />
      </div>
    );
  }

  // Unknown shape — fall back to JSON textarea so power users can
  // still set the value, even when the schema walker didn't have a
  // recipe for the shape.
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={typeof value === "string" ? value : JSON.stringify(value ?? "")}
        disabled={disabled}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            onChange(e.target.value);
          }
        }}
        placeholder="(advanced)"
      />
    </div>
  );
}

function humanize(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}
