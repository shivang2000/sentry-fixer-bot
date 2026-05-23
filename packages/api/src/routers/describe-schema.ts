/**
 * Walk a zod (v4) schema and produce a JSON-shape the UI can render as
 * a dynamic form. We unwrap optional / default / nullable so the UI
 * sees the underlying primitive. Falls back to `unknown` for shapes the
 * renderer does not yet support (record, union, lazy, etc.) — those
 * fields render as a textarea-with-JSON-validation in the UI.
 *
 * Zod v4 (post-mini rewrite) exposes:
 *   - schema.def.type — discriminator: "string" | "number" | "boolean"
 *                       | "enum" | "object" | "array" | "optional"
 *                       | "default" | "nullable" | "literal" | "union"
 *   - schema.def.shape — object's keys → child schemas (object)
 *   - schema.def.element — array's element schema
 *   - schema.def.innerType — optional/default/nullable wrapper inner
 *   - schema.def.defaultValue — literal default (no longer a thunk)
 *   - schema.def.entries — enum keys/values
 *   - on the instance: minLength/maxLength, minValue/maxValue, format
 *     (rolled-up convenience accessors that look through wrappers)
 *
 * Extracted to its own module so the unit tests don't have to drag in
 * the full tRPC router context.
 */
export type FieldDescriptor =
  | { kind: "string"; format?: "url" | "email"; optional: boolean; default?: string }
  | { kind: "number"; optional: boolean; default?: number; min?: number; max?: number }
  | { kind: "boolean"; optional: boolean; default?: boolean }
  | { kind: "enum"; values: string[]; optional: boolean; default?: string }
  | { kind: "stringArray"; optional: boolean; min?: number; max?: number }
  | { kind: "unknown"; optional: boolean };

export type SchemaShape = Record<string, FieldDescriptor>;

type CheckNode = {
  _zod?: {
    def?: {
      check?: string;
      minimum?: number;
      maximum?: number;
      value?: number;
      format?: string;
    };
  };
};

type V4Node = {
  def?: {
    type?: string;
    innerType?: unknown;
    defaultValue?: unknown;
    element?: unknown;
    entries?: Record<string, string>;
    shape?: Record<string, unknown>;
    checks?: CheckNode[];
  };
  // Convenience accessors zod v4 exposes on the schema instance.
  format?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  options?: unknown[];
};

/** Read array min/max bounds out of the checks array. */
function readArrayBounds(node: V4Node): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {};
  for (const c of node.def?.checks ?? []) {
    const cd = c?._zod?.def;
    if (!cd) continue;
    if (cd.check === "min_length" && typeof cd.minimum === "number") out.min = cd.minimum;
    if (cd.check === "max_length" && typeof cd.maximum === "number") out.max = cd.maximum;
  }
  return out;
}

/** Read number min/max bounds from greater_than / less_than checks. */
function readNumberBounds(node: V4Node): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {};
  for (const c of node.def?.checks ?? []) {
    const cd = c?._zod?.def;
    if (!cd) continue;
    if (cd.check === "greater_than" && typeof cd.value === "number") out.min = cd.value;
    if (cd.check === "less_than" && typeof cd.value === "number") out.max = cd.value;
  }
  return out;
}

function describeFieldImpl(
  zod: unknown,
  optional: boolean,
  defaultValue: unknown,
): FieldDescriptor {
  const node = zod as V4Node;
  const def = node.def;
  if (!def) return { kind: "unknown", optional };
  const tn = def.type;

  if (tn === "optional" || tn === "nullable") {
    return describeFieldImpl(def.innerType, true, defaultValue);
  }
  if (tn === "default") {
    return describeFieldImpl(def.innerType, optional, def.defaultValue);
  }
  if (tn === "readonly" || tn === "branded" || tn === "pipe") {
    return describeFieldImpl(def.innerType, optional, defaultValue);
  }
  if (tn === "string") {
    const fmt = (node.format ?? null) as string | null;
    const format =
      fmt === "url" ? ("url" as const) : fmt === "email" ? ("email" as const) : undefined;
    return {
      kind: "string",
      optional,
      ...(format ? { format } : {}),
      ...(typeof defaultValue === "string" ? { default: defaultValue } : {}),
    };
  }
  if (tn === "number") {
    const fromInstance = {
      min: node.minValue ?? undefined,
      max: node.maxValue ?? undefined,
    };
    const fromChecks = readNumberBounds(node);
    const min = fromInstance.min ?? fromChecks.min;
    const max = fromInstance.max ?? fromChecks.max;
    return {
      kind: "number",
      optional,
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
      ...(typeof defaultValue === "number" ? { default: defaultValue } : {}),
    };
  }
  if (tn === "boolean") {
    return {
      kind: "boolean",
      optional,
      ...(typeof defaultValue === "boolean" ? { default: defaultValue } : {}),
    };
  }
  if (tn === "enum") {
    // entries is { "label": "value" } in v4; the values array is on
    // `.options`. Coerce to string[] for the UI.
    const options = Array.isArray(node.options)
      ? node.options.map((v) => String(v))
      : Object.values(def.entries ?? {}).map((v) => String(v));
    return {
      kind: "enum",
      values: options,
      optional,
      ...(typeof defaultValue === "string" ? { default: defaultValue } : {}),
    };
  }
  if (tn === "array") {
    const inner = describeFieldImpl(def.element, true, undefined);
    if (inner.kind === "string") {
      const bounds = readArrayBounds(node);
      return {
        kind: "stringArray",
        optional,
        ...(typeof bounds.min === "number" ? { min: bounds.min } : {}),
        ...(typeof bounds.max === "number" ? { max: bounds.max } : {}),
      };
    }
    return { kind: "unknown", optional };
  }
  return { kind: "unknown", optional };
}

export function describeZodObject(schema: unknown): SchemaShape {
  const s = schema as V4Node;
  if (!s?.def || s.def.type !== "object" || !s.def.shape) {
    return {};
  }
  const out: SchemaShape = {};
  for (const [key, value] of Object.entries(s.def.shape)) {
    out[key] = describeFieldImpl(value, false, undefined);
  }
  return out;
}
