import { describe, expect, it } from "vitest";
import { selectionMenuPosition } from "./selectionMenu";

const section = { left: 0, top: 60, width: 390, height: 600 };
const screen = { left: 16, top: 62, width: 360, height: 560 };
const menu = { width: 170, height: 46 };
const position = (start: { x: number; y: number }, end: { x: number; y: number }, viewport = 100) =>
  selectionMenuPosition({ start, end }, viewport, 36, 28, screen, section, menu);

describe("selection menu anchoring", () => {
  it("centers above the selected text, not at a fixed screen corner", () => {
    expect(position({ x: 10, y: 110 }, { x: 20, y: 110 })).toEqual({ left: 81, top: 148 });
    expect(position({ x: 10, y: 115 }, { x: 20, y: 115 })?.top).toBe(248);
  });
  it("flips below a selection at the top edge and clamps both horizontal edges", () => {
    expect(position({ x: 0, y: 100 }, { x: 2, y: 100 })).toEqual({ left: 8, top: 30 });
    expect(position({ x: 33, y: 100 }, { x: 36, y: 100 })?.left).toBe(212);
  });
  it("follows scrolling and handles multiline, exclusive-end and offscreen ranges", () => {
    expect(position({ x: 10, y: 110 }, { x: 20, y: 110 }, 105)?.top).toBe(48);
    expect(position({ x: 10, y: 110 }, { x: 0, y: 111 })).toEqual({ left: 161, top: 148 });
    expect(position({ x: 10, y: 110 }, { x: 20, y: 112 })?.left).toBe(111);
    expect(position({ x: 0, y: 99 }, { x: 0, y: 100 })).toBeUndefined();
    expect(position({ x: 0, y: 128 }, { x: 10, y: 128 })).toBeUndefined();
  });
  it("keeps a large selection menu inside the visible keyboard viewport", () => {
    const result = selectionMenuPosition({ start: { x: 0, y: 100 }, end: { x: 20, y: 127 } }, 100,
      36, 28, screen, section, menu)!;
    expect(result.top + menu.height).toBeLessThanOrEqual(screen.top - section.top + screen.height);
  });
});
