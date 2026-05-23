import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CtxField, CtxStore } from "./types";

export const DEFAULT_CAP_BYTES: Record<CtxField, number> = {
  trigger: 16 * 1024,
  alert: 64 * 1024,
  event_detail: 128 * 1024,
  triage: 16 * 1024,
  budget: 4 * 1024,
  workspace: 4 * 1024,
  agent_transcript: 200 * 1024,
  agent_output: 64 * 1024,
  secret_scan: 16 * 1024,
  test_result: 32 * 1024,
  diff: 64 * 1024,
  pr: 8 * 1024,
  review: 32 * 1024,
  follow_up: 32 * 1024,
  notifications: 32 * 1024,
  // P3c.3: reviewer's /alertforge (or legacy /sfb) comment payload for
  // the followup pipeline. GitHub trims comments to 64KB on the wire so
  // the cap mirrors that (real reviewer instructions are rarely > a
  // few hundred bytes).
  instruction: 64 * 1024,
};

const LOG_FIELDS: ReadonlySet<CtxField> = new Set<CtxField>(["agent_transcript"]);

function isLogField(field: CtxField): boolean {
  return LOG_FIELDS.has(field);
}

function fileNameFor(field: CtxField): string {
  if (field === "agent_transcript") return "agent_transcript.log";
  if (field === "diff") return "diff.patch";
  return `${field}.json`;
}

export class DiskCtxStore implements CtxStore {
  readonly runId: string;
  readonly dir: string;

  private constructor(runId: string, dir: string) {
    this.runId = runId;
    this.dir = dir;
  }

  static async create(runId: string, runsRoot = "/var/lib/alertforge/runs"): Promise<DiskCtxStore> {
    const dir = join(runsRoot, runId, "ctx");
    await mkdir(dir, { recursive: true });
    return new DiskCtxStore(runId, dir);
  }

  private pathFor(field: CtxField): string {
    return join(this.dir, fileNameFor(field));
  }

  private flagPathFor(field: CtxField): string {
    return `${this.pathFor(field)}.truncated.flag`;
  }

  async read<T>(field: CtxField): Promise<T | null> {
    const path = this.pathFor(field);
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const text = await file.text();
    if (isLogField(field)) return text as unknown as T;
    return JSON.parse(text) as T;
  }

  async write<T>(field: CtxField, value: T, opts?: { capBytes?: number }): Promise<void> {
    const text = isLogField(field) ? (value as unknown as string) : JSON.stringify(value, null, 2);
    const cap = opts?.capBytes ?? DEFAULT_CAP_BYTES[field];
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > cap) {
      const truncated = new TextDecoder().decode(bytes.slice(0, cap));
      await Bun.write(this.pathFor(field), truncated);
      await Bun.write(this.flagPathFor(field), "");
    } else {
      await Bun.write(this.pathFor(field), text);
    }
  }

  async append(field: CtxField, chunk: string): Promise<void> {
    if (!isLogField(field)) {
      throw new Error(`append() not supported on non-log field: ${field}`);
    }
    const path = this.pathFor(field);
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : "";
    const cap = DEFAULT_CAP_BYTES[field];
    const combined = existing + chunk;
    const bytes = new TextEncoder().encode(combined);
    if (bytes.length > cap) {
      const sliced = new TextDecoder().decode(bytes.slice(bytes.length - cap));
      await Bun.write(path, sliced);
      await Bun.write(this.flagPathFor(field), "");
    } else {
      await Bun.write(path, combined);
    }
  }

  async exists(field: CtxField): Promise<boolean> {
    return await Bun.file(this.pathFor(field)).exists();
  }

  async size(field: CtxField): Promise<number> {
    const path = this.pathFor(field);
    try {
      const s = await stat(path);
      return s.size;
    } catch {
      return 0;
    }
  }

  async truncatedFields(): Promise<CtxField[]> {
    const fields: CtxField[] = [];
    for (const field of Object.keys(DEFAULT_CAP_BYTES) as CtxField[]) {
      if (await Bun.file(this.flagPathFor(field)).exists()) fields.push(field);
    }
    return fields;
  }
}
