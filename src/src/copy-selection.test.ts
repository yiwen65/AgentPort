// Copy-selection resolution for live-TUI sessions (mouse reporting owned by
// the application): xterm drops a selection as soon as a redraw touches it,
// so the context menu falls back to the freshest captured selection within a
// bounded TTL. Also pins the macOS force-selection xterm option — without it
// no modifier could form a selection at all in those sessions.

// @ts-expect-error Vitest executes this regression test in Node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COPY_SELECTION_CAPTURE_TTL_MS,
  resolveCopySelection,
} from "./copySelection";
import type { TermHandle } from "./terminals";

function handleWith(live: string, captured: string | null, capturedAt = 0) {
  return {
    term: { getSelection: () => live },
    lastSelectionText: captured,
    lastSelectionAt: capturedAt,
  } as unknown as TermHandle;
}

describe("resolveCopySelection", () => {
  it("prefers the live selection", () => {
    const now = Date.now();
    expect(resolveCopySelection(handleWith("live", "stale", now - 1), now)).toBe("live");
  });

  it("falls back to a fresh captured selection after a redraw wiped the live one", () => {
    const now = Date.now();
    expect(
      resolveCopySelection(handleWith("", "captured-text", now - 3_000), now),
    ).toBe("captured-text");
  });

  it("expires the captured selection past the TTL", () => {
    const now = Date.now();
    expect(
      resolveCopySelection(
        handleWith("", "old-text", now - COPY_SELECTION_CAPTURE_TTL_MS - 1),
        now,
      ),
    ).toBe("");
  });

  it("returns empty without a handle or any selection", () => {
    expect(resolveCopySelection(undefined)).toBe("");
    expect(resolveCopySelection(handleWith("", null))).toBe("");
  });
});

describe("xterm macOS force-selection option", () => {
  it("lets Option+drag select while a TUI owns the mouse", () => {
    const source = readFileSync("src/terminals.ts", "utf8");
    // macOptionClickForcesSelection defaults to false; with mouse reporting
    // active (fullscreen agents) no modifier could then form a selection on
    // macOS and Copy stayed disabled (xterm SelectionService.shouldForceSelection
    // requires altKey && macOptionClickForcesSelection on Mac).
    expect(source).toContain("macOptionClickForcesSelection: true");
  });
});
