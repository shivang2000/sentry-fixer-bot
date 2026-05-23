export type Bind = "loopback" | "lan" | "tailnet" | "custom";
export type DeploymentMode = "local_trusted" | "authenticated";

export function doctorVerdict(input: {
  deploymentMode: DeploymentMode;
  bind: Bind;
  publicBaseUrl: string | undefined;
  bootstrapAdminEmail: string | undefined;
  realAdminCount: number;
}): string | null {
  if (input.deploymentMode !== "authenticated") return null;

  if (!input.publicBaseUrl) {
    return "authenticated mode requires PUBLIC_BASE_URL (https://your.domain) so trusted origins are well-defined";
  }

  // Public binds need TLS; loopback is OK over plain http (assumed behind reverse proxy or local-only)
  if (input.bind !== "loopback" && !input.publicBaseUrl.startsWith("https://")) {
    return "public binds (lan/tailnet/custom) require https:// PUBLIC_BASE_URL";
  }

  // "Public-like" excludes loopback (assumed behind nginx) and tailnet (private mesh)
  const isPublicLike = input.bind !== "loopback" && input.bind !== "tailnet";
  if (isPublicLike && input.realAdminCount === 0 && !input.bootstrapAdminEmail) {
    return (
      "authenticated + public-like bind has no real admin and no ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL. " +
      "Either complete first-signup over a trusted channel first, set ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL, " +
      "or use the board-claim URL."
    );
  }

  return null;
}
