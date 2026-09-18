// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const applyMock = vi.hoisted(() => ({ apply: vi.fn() }));
vi.mock("./terminals", () => ({ applyTerminalSettings: applyMock.apply }));

import { openDocumentTarget } from "./documents";
import { getState, setState } from "./store";
import {
  MAX_FONT_SCALE,
  MIN_FONT_SCALE,
  adjustFontZoom,
  clampFontScale,
  handleFontZoomKey,
  initFontZoom,
  nextFontScale,
  resetFontZoomFocus,
} from "./fontZoom";

function zoomKey(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", { key, ctrlKey: true, ...init });
}

describe("font zoom scale math", () => {
  it("steps by 0.1 and stays on clean decimals", () => {
    expect(nextFontScale(1, 0.1)).toBe(1.1);
    expect(nextFontScale(1.1, -0.1)).toBe(1);
    expect(nextFontScale(0.7, -0.1)).toBe(0.6);
  });

  it("clamps to the min/max bounds", () => {
    expect(clampFontScale(0.1)).toBe(MIN_FONT_SCALE);
    expect(clampFontScale(5)).toBe(MAX_FONT_SCALE);
    expect(nextFontScale(MAX_FONT_SCALE, 0.1)).toBe(MAX_FONT_SCALE);
    expect(nextFontScale(MIN_FONT_SCALE, -0.1)).toBe(MIN_FONT_SCALE);
  });
});

describe("font zoom key handling", () => {
  let dispose: () => void;
  beforeAll(() => {
    dispose = initFontZoom();
  });
  afterAll(() => dispose());

  beforeEach(() => {
    vi.clearAllMocks();
    resetFontZoomFocus();
    setState({
      termFontScale: 1,
      docFontScale: 1,
      docGroups: [],
      explorerOpen: false,
    });
    document.documentElement.style.removeProperty("--doc-font-scale");
    document.documentElement.style.removeProperty("--term-font-scale");
    document.body.innerHTML = "";
  });

  it("zooms the terminal area by default and applies it to xterm", () => {
    expect(handleFontZoomKey(zoomKey("="))).toBe(true);
    expect(getState().termFontScale).toBe(1.1);
    expect(getState().docFontScale).toBe(1);
    expect(
      document.documentElement.style.getPropertyValue("--term-font-scale"),
    ).toBe("1.1");
    expect(applyMock.apply).toHaveBeenCalledTimes(1);
  });

  it("ignores keys without Ctrl/⌘ and unrelated combos", () => {
    expect(handleFontZoomKey(zoomKey("=", { ctrlKey: false }))).toBe(false);
    expect(handleFontZoomKey(zoomKey("x"))).toBe(false);
    expect(handleFontZoomKey(zoomKey("=", { altKey: true }))).toBe(false);
    expect(getState().termFontScale).toBe(1);
  });

  it("zooms the document viewer when it last had focus", () => {
    const panel = document.createElement("div");
    panel.className = "doc-panel";
    const inner = document.createElement("div");
    panel.appendChild(inner);
    document.body.appendChild(panel);
    inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    openDocumentTarget({ path: "/tmp/a.md", line: null });
    expect(handleFontZoomKey(zoomKey("-"))).toBe(true);
    expect(getState().docFontScale).toBe(0.9);
    expect(getState().termFontScale).toBe(1);
    expect(applyMock.apply).not.toHaveBeenCalled();
    expect(
      document.documentElement.style.getPropertyValue("--doc-font-scale"),
    ).toBe("0.9");
  });

  it("treats a preview click as document focus (non-focusable surface)", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace";
    const panel = document.createElement("aside");
    panel.className = "doc-panel";
    const preview = document.createElement("div");
    preview.className = "doc-preview-host";
    panel.appendChild(preview);
    workspace.appendChild(panel);
    document.body.appendChild(workspace);

    // Preview divs never fire focusin; the pointerdown must classify them.
    openDocumentTarget({ path: "/tmp/a.md", line: null });
    preview.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(handleFontZoomKey(zoomKey("="))).toBe(true);
    expect(getState().docFontScale).toBe(1.1);
    expect(getState().termFontScale).toBe(1);
  });

  it("treats a workspace click as terminal focus", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace";
    const timeline = document.createElement("div");
    timeline.className = "pi-rpc-workspace";
    workspace.appendChild(timeline);
    document.body.appendChild(workspace);

    openDocumentTarget({ path: "/tmp/a.md", line: null });
    timeline.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    adjustFontZoom(0.1);
    expect(getState().termFontScale).toBe(1.1);
    expect(getState().docFontScale).toBe(1);
  });

  it("falls back to the terminal when the document viewer is closed", () => {
    const panel = document.createElement("div");
    panel.className = "doc-panel";
    const inner = document.createElement("div");
    panel.appendChild(inner);
    document.body.appendChild(panel);
    inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    // Doc panel closed: even with doc focus, zoom targets the terminal.
    expect(handleFontZoomKey(zoomKey("="))).toBe(true);
    expect(getState().termFontScale).toBe(1.1);
    expect(getState().docFontScale).toBe(1);
  });

  it("switches back to the terminal after terminal focus", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace";
    const timeline = document.createElement("div");
    timeline.className = "pi-rpc-workspace";
    const inner = document.createElement("div");
    timeline.appendChild(inner);
    workspace.appendChild(timeline);
    document.body.appendChild(workspace);

    openDocumentTarget({ path: "/tmp/a.md", line: null });
    inner.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    adjustFontZoom(0.1);
    expect(getState().termFontScale).toBe(1.1);
    expect(getState().docFontScale).toBe(1);
  });

  it("resets the focused area to 100% on Ctrl+0", () => {
    setState({ termFontScale: 1.5 });
    expect(handleFontZoomKey(zoomKey("0"))).toBe(true);
    expect(getState().termFontScale).toBe(1);
  });

  it("stops applying once at the bound (no redundant xterm refits)", () => {
    setState({ termFontScale: MAX_FONT_SCALE });
    expect(handleFontZoomKey(zoomKey("="))).toBe(true);
    expect(applyMock.apply).not.toHaveBeenCalled();
  });
});
