import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { namespaces, resources } from "./locales/resources";
import type { UiLanguage } from "./types";

export const DEFAULT_UI_LANGUAGE: UiLanguage = "zh-CN";
export const UI_LANGUAGE_STORAGE_KEY = "agentport-ui-language";
export const SUPPORTED_UI_LANGUAGES = ["zh-CN", "en-US"] as const;

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === "en-US" ? "en-US" : DEFAULT_UI_LANGUAGE;
}

function readLanguageHint(): UiLanguage {
  if (typeof window === "undefined") return DEFAULT_UI_LANGUAGE;
  try {
    return normalizeUiLanguage(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

function writeLanguageHint(language: UiLanguage) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // The SQLite setting remains authoritative when storage is unavailable.
  }
}

function syncDocumentLanguage(language: UiLanguage) {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

const initialLanguage = readLanguageHint();
syncDocumentLanguage(initialLanguage);

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: DEFAULT_UI_LANGUAGE,
  supportedLngs: [...SUPPORTED_UI_LANGUAGES],
  ns: [...namespaces],
  defaultNS: "common",
  initAsync: false,
  returnNull: false,
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

export async function applyUiLanguage(
  value: unknown,
  options: { persistHint?: boolean } = {},
): Promise<UiLanguage> {
  const language = normalizeUiLanguage(value);
  await i18n.changeLanguage(language);
  syncDocumentLanguage(language);
  if (options.persistHint !== false) writeLanguageHint(language);
  return language;
}

export function currentUiLanguage(): UiLanguage {
  return normalizeUiLanguage(i18n.resolvedLanguage ?? i18n.language);
}

export { i18n };
