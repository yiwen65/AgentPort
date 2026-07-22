import { describe, expect, it } from "vitest";
import { isVisiblePiTimelineEvent } from "./PiStructuredTimeline";

describe("Pi structured timeline bootstrap filtering", () => {
  it("hides only successful get_state startup validation", () => {
    expect(isVisiblePiTimelineEvent({
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "native-pi-session" },
    })).toBe(false);
    expect(isVisiblePiTimelineEvent({
      type: "response",
      command: "get_state",
      success: false,
      error: "authentication failed",
    })).toBe(true);
  });

  it("hides Pi's known first-private-session notice but keeps diagnostics", () => {
    expect(isVisiblePiTimelineEvent({
      type: "diagnostic",
      message: "Warning: No project session found with id 'native-pi-session'; creating a new session with that id.",
    })).toBe(false);
    expect(isVisiblePiTimelineEvent({
      type: "diagnostic",
      message: "Error: provider authentication failed",
    })).toBe(true);
  });
});
