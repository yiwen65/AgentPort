import { useLayoutEffect, useSyncExternalStore, useEffect, useState } from "react";

export type AppAppearanceMode = "light" | "dark" | "system";
export const APP_APPEARANCE_STORAGE_KEY = "agentport-mobile-v3:interface-mode";
const listeners = new Set<() => void>();
let snapshot: AppAppearanceMode = "dark";
function load(): AppAppearanceMode {
  try { const value = localStorage.getItem(APP_APPEARANCE_STORAGE_KEY); return value === "light" || value === "system" ? value : "dark"; }
  catch { return "dark"; }
}
function getSnapshot() { if (!listeners.size) snapshot = load(); return snapshot; }
function notify() { listeners.forEach(listener => listener()); }
function storage(event: StorageEvent) { if (event.key === null || event.key === APP_APPEARANCE_STORAGE_KEY) { snapshot = load(); notify(); } }
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", storage);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener("storage", storage); };
}
function update(mode: AppAppearanceMode) {
  try { localStorage.setItem(APP_APPEARANCE_STORAGE_KEY, mode); } catch { /* Keep the live choice when storage is unavailable. */ }
  snapshot = mode; notify();
}
export function useAppAppearance() {
  const mode = useSyncExternalStore(subscribe, getSnapshot);
  const [dark, setDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const changed = () => setDark(media?.matches ?? false);
    changed(); media?.addEventListener("change", changed);
    return () => media?.removeEventListener("change", changed);
  }, []);
  return [mode, update, mode === "system" ? (dark ? "dark" : "light") : mode] as const;
}

/** Interface-only semantic tokens. No terminal palette imports or variables. */
export function getAppThemeVariables(mode: "light" | "dark"): Record<string, string> {
  const dark = mode === "dark";
  return {
    "--bg": dark ? "#080a10" : "#f5f6f2",
    "--panel": dark ? "#12151e" : "#ffffff",
    "--panel-strong": dark ? "#1b2030" : "#ecefe7",
    "--text": dark ? "#f4f1ea" : "#1b2130",
    "--muted": dark ? "#b4b7b0" : "#57615d",
    "--tertiary-text": dark ? "#b4b7b0" : "#57615d",
    "--line": dark ? "#646f78" : "#7d887f",
    "--line-soft": dark ? "#303742" : "#d3d9d0",
    "--fill": dark ? "#171c26" : "#ecefe7",
    "--fill-strong": dark ? "#263040" : "#dce3d6",
    "--accent": dark ? "#71e6d1" : "#20776e",
    "--accent-strong": dark ? "#9ff2c8" : "#175d58",
    "--primary-start": "#41d8bc",
    "--primary-end": "#a7f077",
    "--primary-fg": "#10230e",
    "--folder-glow": dark ? "#c8f16d" : "#63720d",
    "--success": dark ? "#8bddab" : "#176b42",
    "--warning": dark ? "#ffd166" : "#6f4b00",
    "--danger": dark ? "#ff9a96" : "#b4232f",
    "--danger-fill": "#b4232f",
    "--nav-glass": dark ? "#12151ef5" : "#fffffff0",
    "--content-active": dark ? "#263040" : "#dce3d6",
    "--content-active-ring": dark ? "#71e6d1" : "#20776e",
    "--content-highlight": dark ? "#f4f1ea12" : "#1b21300a",
    "--ambient": dark ? "#71e6d10a" : "#20776e08",
    "--status-waiting-bg": dark ? "#1b2030" : "#ecefe7",
    "--status-error-bg": dark ? "#1b2030" : "#ecefe7",
    "--modal-scrim": dark ? "#00000099" : "#1b213055",
    "--mark-cyan": dark ? "#71e6d1" : "#20776e",
    "--mark-blue": dark ? "#b5eb74" : "#63720d",
    "--mark-violet": dark ? "#a8b8ff" : "#5867b2",
    "--mark-dot": dark ? "#f7c66a" : "#936000",
    "--shadow": dark ? "0 16px 40px #00000040" : "0 12px 32px #1b213018",
  };
}

export function useApplyAppAppearance() {
  const [, , mode] = useAppAppearance();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const variables = getAppThemeVariables(mode);
    const previous = Object.keys(variables).map(key => [key, root.style.getPropertyValue(key)] as const);
    root.dataset.appTheme = mode;
    root.dataset.themeFamily = "mosaic";
    Object.entries(variables).forEach(([key, value]) => root.style.setProperty(key, value));
    return () => {
      previous.forEach(([key, value]) => value ? root.style.setProperty(key, value) : root.style.removeProperty(key));
      delete root.dataset.appTheme;
      delete root.dataset.themeFamily;
    };
  }, [mode]);
}
