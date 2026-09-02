import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, type SupportedLanguage } from "./resources";

function detectedLanguage(): SupportedLanguage {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectedLanguage(),
  fallbackLng: "en-US",
  interpolation: { escapeValue: false },
  returnNull: false,
});

document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (language) => {
  document.documentElement.lang = language;
});

export { i18n };
