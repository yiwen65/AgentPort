import { describe, expect, it } from "vitest";
import { isVisiblePiTimelineEvent, parseReplay } from "./PiStructuredTimeline";

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

  it("preserves Unicode when a replay chunk splits a UTF-8 code point", () => {
    const expected = { type: "message", text: "中文 😀" };
    const bytes = new TextEncoder().encode(`${JSON.stringify(expected)}\n`);

    for (let split = 1; split < bytes.length; split += 1) {
      const decoder = new TextDecoder();
      const first = parseReplay(bytes.subarray(0, split), "", decoder);
      const second = parseReplay(bytes.subarray(split), first.remainder, decoder);
      expect([...first.events, ...second.events], `split byte ${split}`).toEqual([expected]);
    }
  });
});
