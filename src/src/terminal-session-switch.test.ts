import { describe, expect, it } from "vitest";
import { shouldShowTerminalAttachOverlay } from "./terminalAttachVisibility";

const attaching = {
  attaching: true,
  attached: false,
  replayDone: false,
  startupPending: false,
};

describe("warm Session switch attach visibility", () => {
  it("shows the existing terminal checkpoint while reconnecting in the background", () => {
    expect(shouldShowTerminalAttachOverlay(attaching, true)).toBe(false);
  });

  it("keeps the solid veil for a cold attach without a displayable checkpoint", () => {
    expect(shouldShowTerminalAttachOverlay(attaching, false)).toBe(true);
  });

  it("keeps restarted Pi startup covered even when an old checkpoint exists", () => {
    expect(
      shouldShowTerminalAttachOverlay(
        { ...attaching, startupPending: true },
        true,
      ),
    ).toBe(true);
  });

  it("removes the overlay after replay has parsed", () => {
    expect(
      shouldShowTerminalAttachOverlay(
        { ...attaching, attaching: false, attached: true, replayDone: true },
        false,
      ),
    ).toBe(false);
  });
});
