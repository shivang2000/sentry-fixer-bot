export type Role = "instance_admin" | "member";
export type CheckResult = "ok" | "forbidden" | "unauthorized";

export function checkRole(input: { required: Role; actual: Role | null }): CheckResult {
  if (input.actual === null) return "unauthorized";
  if (input.required === "instance_admin" && input.actual !== "instance_admin") return "forbidden";
  return "ok";
}
