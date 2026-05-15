import { describe, expect, it } from "bun:test";
import { LOCAL_BOARD_EMAIL, LOCAL_BOARD_ID, shouldSeedLocalBoard } from "./bootstrap-logic";

describe("shouldSeedLocalBoard", () => {
  it("returns true when in local_trusted mode and local-board row does not exist", () => {
    expect(
      shouldSeedLocalBoard({ deploymentMode: "local_trusted", existingLocalBoard: false }),
    ).toBe(true);
  });

  it("returns false when not in local_trusted mode", () => {
    expect(
      shouldSeedLocalBoard({ deploymentMode: "authenticated", existingLocalBoard: false }),
    ).toBe(false);
  });

  it("returns false when local-board row already exists (idempotent)", () => {
    expect(
      shouldSeedLocalBoard({ deploymentMode: "local_trusted", existingLocalBoard: true }),
    ).toBe(false);
  });
});

describe("LOCAL_BOARD constants", () => {
  it("exports a fixed sentinel id and email", () => {
    expect(LOCAL_BOARD_ID).toBe("local-board");
    expect(LOCAL_BOARD_EMAIL).toBe("local-board@sfb.local");
  });
});
