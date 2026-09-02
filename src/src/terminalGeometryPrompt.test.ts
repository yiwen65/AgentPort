import { describe, expect, it } from "vitest";
import {
  shouldPublishAutomaticDesktopResize,
  terminalGeometryPromptState,
} from "./terminalGeometryPrompt";
import type { TerminalGeometry } from "./types";

const MOBILE: TerminalGeometry = {
  runId: "run-1",
  runOrdinal: 1,
  cols: 48,
  rows: 40,
  sourceKind: "mobile",
  sourceDeviceId: "phone-1",
  attachmentId: 7,
  orientation: "portrait",
  revision: 3,
  updatedAt: "2026-09-02T10:00:00Z",
};

describe("terminal geometry prompt state", () => {
  it("shows only the current mobile-owned revision", () => {
    expect(terminalGeometryPromptState(MOBILE, null)).toEqual({
      visible: true,
      revision: 3,
    });
    expect(terminalGeometryPromptState(MOBILE, 3).visible).toBe(false);
    expect(
      terminalGeometryPromptState({ ...MOBILE, revision: 4 }, 3).visible,
    ).toBe(true);
  });

  it("hides desktop and invalid geometries", () => {
    expect(
      terminalGeometryPromptState({ ...MOBILE, sourceKind: "desktop" }, null)
        .visible,
    ).toBe(false);
    expect(
      terminalGeometryPromptState({ ...MOBILE, cols: 0 }, null).visible,
    ).toBe(false);
  });

  it("blocks passive PTY resize while mobile owns geometry", () => {
    expect(shouldPublishAutomaticDesktopResize(MOBILE)).toBe(false);
    expect(
      shouldPublishAutomaticDesktopResize({ ...MOBILE, sourceKind: "desktop" }),
    ).toBe(true);
    expect(shouldPublishAutomaticDesktopResize(null)).toBe(true);
  });
});
