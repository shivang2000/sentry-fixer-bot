import { describe, expect, it } from "bun:test";
import { TRPCError } from "@trpc/server";
import { assertAllowed, tokenize } from "./npm-runner";

describe("tokenize", () => {
  it("splits plain words on whitespace", () => {
    expect(tokenize("npm install foo")).toEqual(["npm", "install", "foo"]);
  });

  it("preserves double-quoted strings as one arg", () => {
    expect(tokenize('npm i "my package"')).toEqual(["npm", "i", "my package"]);
  });

  it("preserves single-quoted strings as one arg", () => {
    expect(tokenize("npm i 'hello world'")).toEqual(["npm", "i", "hello world"]);
  });

  it("handles backslash-escapes inside double quotes", () => {
    expect(tokenize('npm i "a\\"b"')).toEqual(["npm", "i", 'a"b']);
  });

  it("rejects an unterminated quote", () => {
    expect(() => tokenize('npm i "oops')).toThrow();
  });

  it("collapses runs of whitespace", () => {
    expect(tokenize("npm    i    foo")).toEqual(["npm", "i", "foo"]);
  });

  it("treats shell metacharacters as literal text", () => {
    expect(tokenize("npm i pkg;rm")).toEqual(["npm", "i", "pkg;rm"]);
  });
});

describe("assertAllowed", () => {
  it("accepts npm / npx / pnpm / bun", () => {
    expect(() => assertAllowed(["npm", "i", "x"])).not.toThrow();
    expect(() => assertAllowed(["npx", "-y", "x"])).not.toThrow();
    expect(() => assertAllowed(["pnpm", "add", "x"])).not.toThrow();
    expect(() => assertAllowed(["bun", "add", "x"])).not.toThrow();
  });

  it("accepts git only when subcommand is clone", () => {
    expect(() => assertAllowed(["git", "clone", "https://x"])).not.toThrow();
    expect(() => assertAllowed(["git", "pull"])).toThrow(TRPCError);
  });

  it("rejects bash / sh / curl / anything else", () => {
    for (const c of ["bash", "sh", "curl", "wget", "rm", "node", "python3"]) {
      expect(() => assertAllowed([c, "anything"])).toThrow(TRPCError);
    }
  });

  it("rejects an empty argv", () => {
    expect(() => assertAllowed([])).toThrow(TRPCError);
  });
});
