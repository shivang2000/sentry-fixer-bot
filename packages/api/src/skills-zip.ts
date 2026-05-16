import { resolve } from "node:path";
import AdmZip from "adm-zip";

export const MAX_ZIP_BYTES = 5 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 50;

export type ZipValidationError =
  | { kind: "too_large"; size: number }
  | { kind: "too_many_entries"; count: number }
  | { kind: "path_escape"; entry: string }
  | { kind: "symlink"; entry: string };

export function validateZipBuffer(
  buf: Buffer,
): { ok: true; zip: AdmZip } | { ok: false; error: ZipValidationError } {
  if (buf.length > MAX_ZIP_BYTES) {
    return { ok: false, error: { kind: "too_large", size: buf.length } };
  }
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    return { ok: false, error: { kind: "too_many_entries", count: entries.length } };
  }
  for (const entry of entries) {
    if (entry.entryName.includes("..")) {
      return { ok: false, error: { kind: "path_escape", entry: entry.entryName } };
    }
    if ((entry.header as { attr?: number }).attr === 0xa1ed0000) {
      return { ok: false, error: { kind: "symlink", entry: entry.entryName } };
    }
  }
  return { ok: true, zip };
}

export function isPathSafe(target: string, entryName: string): boolean {
  if (entryName.includes("..")) return false;
  const resolvedTarget = resolve(target);
  const dest = resolve(target, entryName);
  return dest === resolvedTarget || dest.startsWith(resolvedTarget + "/");
}

export function safeExtractZip(zip: AdmZip, target: string): void {
  for (const entry of zip.getEntries()) {
    if (!isPathSafe(target, entry.entryName)) {
      throw new Error(`zip_path_escape:${entry.entryName}`);
    }
  }
  zip.extractAllTo(target, true);
}
