import { describe, expect, it } from "bun:test";
import { dedupKey } from "./dedup";

describe("dedupKey", () => {
  it("returns the same key for identical (project, fingerprint) tuples", () => {
    expect(dedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" })).toBe(
      dedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" }),
    );
  });

  it("differs when the project differs", () => {
    expect(dedupKey({ project: "a", fingerprint: "f", codeVersion: "v1" })).not.toBe(
      dedupKey({ project: "b", fingerprint: "f", codeVersion: "v1" }),
    );
  });

  it("differs when the fingerprint differs", () => {
    expect(dedupKey({ project: "p", fingerprint: "f1", codeVersion: "v1" })).not.toBe(
      dedupKey({ project: "p", fingerprint: "f2", codeVersion: "v1" }),
    );
  });

  it("differs when the codeVersion differs (separate fix per release)", () => {
    expect(dedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" })).not.toBe(
      dedupKey({ project: "p", fingerprint: "f", codeVersion: "v2" }),
    );
  });

  it("treats missing codeVersion as a distinct partition", () => {
    expect(dedupKey({ project: "p", fingerprint: "f", codeVersion: undefined })).not.toBe(
      dedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" }),
    );
  });

  it("returns a hex string", () => {
    expect(dedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" })).toMatch(/^[0-9a-f]+$/);
  });
});
