import { describe, expect, it } from "bun:test";
import { resolveTrustedOrigins } from "./trusted-origins";

describe("resolveTrustedOrigins", () => {
  it("returns loopback origins for SERVER_BIND=loopback in authenticated mode", () => {
    const out = resolveTrustedOrigins({
      bind: "loopback",
      port: 3000,
      publicBaseUrl: undefined,
      deploymentMode: "authenticated",
    });
    expect(out).toContain("http://localhost:3000");
    expect(out).toContain("http://127.0.0.1:3000");
  });

  it("includes the public base URL origin when provided", () => {
    const out = resolveTrustedOrigins({
      bind: "loopback",
      port: 443,
      publicBaseUrl: "https://sfb.example.com",
      deploymentMode: "authenticated",
    });
    expect(out).toContain("https://sfb.example.com");
  });

  it("returns no origins in local_trusted mode (auth disabled)", () => {
    const out = resolveTrustedOrigins({
      bind: "loopback",
      port: 3000,
      publicBaseUrl: undefined,
      deploymentMode: "local_trusted",
    });
    expect(out).toEqual([]);
  });

  it("includes only the public base URL for lan/tailnet/custom binds (loopback URLs not auto-added)", () => {
    const out = resolveTrustedOrigins({
      bind: "lan",
      port: 3000,
      publicBaseUrl: "https://sfb.internal",
      deploymentMode: "authenticated",
    });
    expect(out).toEqual(["https://sfb.internal"]);
  });

  it("deduplicates origins when publicBaseUrl is itself loopback", () => {
    const out = resolveTrustedOrigins({
      bind: "loopback",
      port: 3000,
      publicBaseUrl: "http://localhost:3000",
      deploymentMode: "authenticated",
    });
    const localhost = out.filter((o) => o === "http://localhost:3000");
    expect(localhost.length).toBe(1);
  });
});
