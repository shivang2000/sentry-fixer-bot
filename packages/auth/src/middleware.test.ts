import { describe, expect, it } from "bun:test";
import { checkRole } from "./middleware-logic";

describe("checkRole", () => {
  it("allows admin to access admin-only routes", () => {
    expect(checkRole({ required: "instance_admin", actual: "instance_admin" })).toBe("ok");
  });

  it("denies member from admin-only routes", () => {
    expect(checkRole({ required: "instance_admin", actual: "member" })).toBe("forbidden");
  });

  it("allows admin to access member routes", () => {
    expect(checkRole({ required: "member", actual: "instance_admin" })).toBe("ok");
  });

  it("allows member to access member routes", () => {
    expect(checkRole({ required: "member", actual: "member" })).toBe("ok");
  });

  it("returns 'unauthorized' when user is null", () => {
    expect(checkRole({ required: "member", actual: null })).toBe("unauthorized");
    expect(checkRole({ required: "instance_admin", actual: null })).toBe("unauthorized");
  });
});
