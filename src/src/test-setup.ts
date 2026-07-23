import { beforeEach } from "vitest";
import { applyUiLanguage, UI_LANGUAGE_STORAGE_KEY } from "./i18n";

beforeEach(async () => {
  window.localStorage.removeItem(UI_LANGUAGE_STORAGE_KEY);
  await applyUiLanguage("zh-CN", { persistHint: false });
});
