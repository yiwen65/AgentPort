import { beforeEach, vi } from "vitest";
import { applyUiLanguage, UI_LANGUAGE_STORAGE_KEY } from "./i18n";

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
