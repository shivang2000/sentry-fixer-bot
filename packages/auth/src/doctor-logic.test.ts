import { describe, expect, it } from "bun:test";
import { doctorVerdict } from "./doctor-logic";

describe("doctorVerdict", () => {
  it("passes silently in local_trusted mode", () => {
    expect(
      doctorVerdict({
        deploymentMode: "local_trusted",
        bind: "loopback",
        publicBaseUrl: undefined,
        bootstrapAdminEmail: undefined,
        realAdminCount: 0,
      }),
    ).toBeNull();
  });

  it("rejects authenticated + missing PUBLIC_BASE_URL", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "lan",
        publicBaseUrl: undefined,
        bootstrapAdminEmail: undefined,
        realAdminCount: 1,
      }),
    ).toContain("PUBLIC_BASE_URL");
  });

  it("rejects authenticated + public-bind + http PUBLIC_BASE_URL", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "lan",
        publicBaseUrl: "http://insecure.example.com",
        bootstrapAdminEmail: undefined,
        realAdminCount: 1,
      }),
    ).toContain("https://");
  });

  it("rejects authenticated + public-like-bind + no real admin + no bootstrap email", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "lan",
        publicBaseUrl: "https://sfb.example.com",
        bootstrapAdminEmail: undefined,
        realAdminCount: 0,
      }),
    ).toContain("admin");
  });

  it("passes authenticated + lan + https + has admin", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "lan",
        publicBaseUrl: "https://sfb.example.com",
        bootstrapAdminEmail: undefined,
        realAdminCount: 1,
      }),
    ).toBeNull();
  });

  it("passes authenticated + loopback + http PUBLIC_BASE_URL (behind reverse proxy)", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "loopback",
        publicBaseUrl: "http://localhost:3000",
        bootstrapAdminEmail: undefined,
        realAdminCount: 1,
      }),
    ).toBeNull();
  });

  it("passes authenticated + public + no admin but bootstrap email set", () => {
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "lan",
        publicBaseUrl: "https://sfb.example.com",
        bootstrapAdminEmail: "ops@example.com",
        realAdminCount: 0,
      }),
    ).toBeNull();
  });

  it("passes authenticated + tailnet (private network) + no admin", () => {
    // tailnet bind is treated as not public-like; signup can complete safely there
    expect(
      doctorVerdict({
        deploymentMode: "authenticated",
        bind: "tailnet",
        publicBaseUrl: "https://sfb.tail.ts.net",
        bootstrapAdminEmail: undefined,
        realAdminCount: 0,
      }),
    ).toBeNull();
  });
});
