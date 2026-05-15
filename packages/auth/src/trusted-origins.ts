export type Bind = "loopback" | "lan" | "tailnet" | "custom";
export type DeploymentMode = "local_trusted" | "authenticated";

export type ResolveInput = {
  bind: Bind;
  port: number;
  publicBaseUrl: string | undefined;
  deploymentMode: DeploymentMode;
};

export function resolveTrustedOrigins(input: ResolveInput): string[] {
  if (input.deploymentMode === "local_trusted") return [];

  const out = new Set<string>();

  if (input.publicBaseUrl) {
    try {
      out.add(new URL(input.publicBaseUrl).origin);
    } catch {
      // ignore malformed publicBaseUrl
    }
  }

  if (input.bind === "loopback") {
    out.add(`http://localhost:${input.port}`);
    out.add(`http://127.0.0.1:${input.port}`);
  }

  return Array.from(out);
}
