export const LOCAL_BOARD_ID = "local-board";
export const LOCAL_BOARD_EMAIL = "local-board@sfb.local";

export type DeploymentMode = "local_trusted" | "authenticated";

export function shouldSeedLocalBoard(input: {
  deploymentMode: DeploymentMode;
  existingLocalBoard: boolean;
}): boolean {
  if (input.deploymentMode !== "local_trusted") return false;
  if (input.existingLocalBoard) return false;
  return true;
}
