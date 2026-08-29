// Ctrl/⌘ +/- font zoom for the two reading surfaces: the terminal area
// (xterm panes and the pi timeline) and the document viewer body. The zoom is
// transient (not persisted to settings) and applies to whichever surface last
// had focus, so the two areas scale independently.

import { getState, setState } from "./store";
import { applyTerminalSettings } from "./terminals";

export type ZoomArea = "terminal" | "doc";

export const MIN_FONT_SCALE = 0.6;
export const MAX_FONT_SCALE = 2;
export const FONT_SCALE_STEP = 0.1;

/** Last area that saw a `focusin`; buttons/menus do not steal the target. */
let lastArea: ZoomArea = "terminal";
let initialized = false;

export function clampFontScale(scale: number): number {
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, scale));
}

/** Round to one decimal so repeated ±0.1 steps stay on clean values. */
export function nextFontScale(scale: number, delta: number): number {
  return clampFontScale(Math.round((scale + delta) * 10) / 10);
}

/** The document viewer only counts when it is actually on screen. */
export function resolveZoomArea(docPanelVisible: boolean): ZoomArea {
  return docPanelVisible ? lastArea : "terminal";
}

/** Test hook: reset the tracked focus area between cases. */
export function resetFontZoomFocus(): void {
  lastArea = "terminal";
}

function applyAreaScale(area: ZoomArea, scale: number): void {
  if (area === "doc") {
    setState({ docFontScale: scale });
    document.documentElement.style.setProperty("--doc-font-scale", String(scale));
  } else {
    setState({ termFontScale: scale });
    document.documentElement.style.setProperty("--term-font-scale", String(scale));
    applyTerminalSettings();
  }
}

/** Adjust the focused surface's font zoom. Delta 0 resets to 100%. */
export function adjustFontZoom(delta: number): void {
  const s = getState();
  const docPanelVisible = s.openDocument !== null || s.explorerOpen;
  const area = resolveZoomArea(docPanelVisible);
  const current = area === "doc" ? s.docFontScale : s.termFontScale;
  const next = delta === 0 ? 1 : nextFontScale(current, delta);
  if (next === current) return;
  applyAreaScale(area, next);
}

/** Handles Ctrl/⌘ + =/+/-/_, and 0 (reset). Returns true when consumed. */
export function handleFontZoomKey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  const key = event.key;
  if (key === "=" || key === "+") {
    adjustFontZoom(FONT_SCALE_STEP);
  } else if (key === "-" || key === "_") {
    adjustFontZoom(-FONT_SCALE_STEP);
  } else if (key === "0") {
    adjustFontZoom(0);
  } else {
    return false;
  }
  return true;
}

/** Classify the interaction target into a zoom area. */
function classifyTarget(el: HTMLElement | null): void {
  if (!el || typeof el.closest !== "function") return;
  if (el.closest(".doc-panel")) {
    lastArea = "doc";
  } else if (el.closest(".workspace")) {
    // Covers xterm (.term-body) and pi timeline (.pi-rpc-workspace) — the
    // timeline replaces .term-body for json_rpc sessions.
    lastArea = "terminal";
  }
}

/** Track the focus area once; the keydown side lives in App's hotkey hook. */
export function initFontZoom(): () => void {
  if (initialized) return () => {};
  initialized = true;
  // focusin covers keyboard navigation and the focusable raw-editor textarea,
  // but NOT the preview: plain divs never receive focus, so clicking the
  // preview used to leave the area stuck on "terminal". pointerdown closes
  // that gap — clicking anywhere in a surface (preview, header, tree) marks
  // it as the active zoom target.
  const onFocusIn = (event: FocusEvent) =>
    classifyTarget(event.target as HTMLElement | null);
  const onPointerDown = (event: PointerEvent) =>
    classifyTarget(event.target as HTMLElement | null);
  window.addEventListener("focusin", onFocusIn, true);
  window.addEventListener("pointerdown", onPointerDown, true);
  return () => {
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("pointerdown", onPointerDown, true);
    initialized = false;
  };
}
