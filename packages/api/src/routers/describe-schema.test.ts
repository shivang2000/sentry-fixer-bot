import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { describeZodObject } from "./describe-schema";

describe("describeZodObject", () => {
  it("returns an empty shape when the schema is not an object", () => {
    expect(describeZodObject(z.string())).toEqual({});
    expect(describeZodObject(null)).toEqual({});
    expect(describeZodObject(undefined)).toEqual({});
  });

  it("describes a simple string field", () => {
    const schema = z.object({ name: z.string() });
    expect(describeZodObject(schema)).toEqual({
      name: { kind: "string", optional: false },
    });
  });

  it("flags optional fields", () => {
    const schema = z.object({ note: z.string().optional() });
    const out = describeZodObject(schema);
    expect(out.note?.optional).toBe(true);
  });

  it("picks up url and email formats", () => {
    const schema = z.object({
      webhookUrl: z.string().url(),
      from: z.string().email().optional(),
    });
    const out = describeZodObject(schema);
    expect(out.webhookUrl).toEqual({ kind: "string", optional: false, format: "url" });
    expect(out.from).toEqual({ kind: "string", optional: true, format: "email" });
  });

  it("describes booleans and numbers including min/max", () => {
    const schema = z.object({
      enabled: z.boolean(),
      count: z.number().min(0).max(100),
    });
    const out = describeZodObject(schema);
    expect(out.enabled).toEqual({ kind: "boolean", optional: false });
    expect(out.count).toEqual({ kind: "number", optional: false, min: 0, max: 100 });
  });

  it("describes enums", () => {
    const schema = z.object({
      severity: z.enum(["low", "medium", "high"]),
    });
    const out = describeZodObject(schema);
    expect(out.severity).toEqual({
      kind: "enum",
      values: ["low", "medium", "high"],
      optional: false,
    });
  });

  it("captures defaults from .default()", () => {
    const schema = z.object({
      level: z.enum(["a", "b"]).default("a"),
      ttl: z.number().default(30),
      on: z.boolean().default(true),
      name: z.string().default("hello"),
    });
    const out = describeZodObject(schema);
    expect(out.level).toMatchObject({ kind: "enum", default: "a" });
    expect(out.ttl).toMatchObject({ kind: "number", default: 30 });
    expect(out.on).toMatchObject({ kind: "boolean", default: true });
    expect(out.name).toMatchObject({ kind: "string", default: "hello" });
  });

  it("describes arrays of strings as stringArray with bounds", () => {
    const schema = z.object({
      mentions: z.array(z.string()).min(1).max(5).optional(),
    });
    const out = describeZodObject(schema);
    expect(out.mentions?.kind).toBe("stringArray");
    expect(out.mentions?.optional).toBe(true);
    if (out.mentions?.kind === "stringArray") {
      expect(out.mentions.min).toBe(1);
      expect(out.mentions.max).toBe(5);
    }
  });

  it("falls back to unknown for arrays of non-strings", () => {
    const schema = z.object({
      counts: z.array(z.number()),
    });
    expect(describeZodObject(schema).counts).toEqual({ kind: "unknown", optional: false });
  });

  it("walks the real slack channel schema cleanly", () => {
    const schema = z.object({
      webhookUrl: z.string().url(),
      channel: z.string().optional(),
      mentionUserIds: z.array(z.string()).optional(),
    });
    const out = describeZodObject(schema);
    expect(out.webhookUrl).toEqual({ kind: "string", optional: false, format: "url" });
    expect(out.channel).toEqual({ kind: "string", optional: true });
    expect(out.mentionUserIds).toMatchObject({ kind: "stringArray", optional: true });
  });

  it("walks the real email channel schema cleanly", () => {
    const schema = z.object({
      to: z.array(z.string().email()).min(1).max(20),
      from: z.string().email().optional(),
      notifyOnSeverityAtLeast: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    });
    const out = describeZodObject(schema);
    expect(out.to?.kind).toBe("stringArray");
    expect(out.from).toEqual({ kind: "string", optional: true, format: "email" });
    expect(out.notifyOnSeverityAtLeast).toMatchObject({
      kind: "enum",
      values: ["low", "medium", "high", "critical"],
      default: "medium",
    });
  });
});
