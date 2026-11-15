import { beforeEach, vi } from "vitest";
import { applyUiLanguage, UI_LANGUAGE_STORAGE_KEY } from "./i18n";

// CodeMirror measures laid-out DOM that jsdom never lays out. These inert
// stand-ins keep editor construction and keystroke handling testable.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Range !== "undefined") {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => null;
}
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// App registers native drag/drop on mount. jsdom has no Tauri window metadata;
// keep this platform boundary inert rather than bypassing App's real effects.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async () => () => {},
  }),
}));

beforeEach(async () => {
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
  await applyUiLanguage("zh-CN", { persistHint: false });
});
