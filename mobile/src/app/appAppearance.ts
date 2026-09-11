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
    "--bg": dark ? "#101c15" : "#f2f7f1",
    "--panel": dark ? "#101c15" : "#ffffff",
    "--panel-strong": dark ? "#18271d" : "#e7efe5",
    "--text": dark ? "#f1f6ef" : "#16281b",
    "--muted": dark ? "#b1c1b2" : "#4c6251",
    "--tertiary-text": dark ? "#b1c1b2" : "#4c6251",
    "--line": dark ? "#58735f" : "#768b78",
    "--line-soft": dark ? "#2b4132" : "#cedbcb",
    "--fill": dark ? "#14241a" : "#e7efe5",
    "--fill-strong": dark ? "#223b2a" : "#d7e7d2",
    "--accent": dark ? "#9aef75" : "#28642c",
    "--accent-strong": dark ? "#d0fa59" : "#245626",
    "--primary-start": "#55d94c",
    "--primary-end": "#d0fa59",
    "--primary-fg": "#10230e",
    "--folder-glow": dark ? "#c4f47c" : "#28642c",
    "--launcher-glow": dark ? "#8ff076" : "#28642c",
    "--success": dark ? "#8bddab" : "#176b42",
    "--warning": dark ? "#ffd166" : "#6f4b00",
    "--danger": dark ? "#ff9a96" : "#b4232f",
    "--danger-fill": "#b4232f",
    "--nav-glass": dark ? "#101c15f5" : "#ffffffed",
    "--content-active": dark ? "#223b2a" : "#d7e7d2",
    "--content-active-ring": dark ? "#9aef75" : "#28642c",
    "--content-highlight": dark ? "#f1f6ef12" : "#16281b0a",
    "--ambient": dark ? "#9aef750a" : "#28642c08",
    "--status-waiting-bg": dark ? "#18271d" : "#e7efe5",
    "--status-error-bg": dark ? "#18271d" : "#e7efe5",
    "--modal-scrim": dark ? "#00000099" : "#10230e55",
    "--mark-cyan": dark ? "#9aef75" : "#28642c",
    "--mark-blue": dark ? "#9aef75" : "#28642c",
    "--mark-violet": dark ? "#b7dca0" : "#496735",
    "--mark-dot": dark ? "#d0fa59" : "#28642c",
    "--shadow": dark ? "0 16px 40px #00000040" : "0 12px 32px #10230e18",
  };
}

export function useApplyAppAppearance() {
  const [, , mode] = useAppAppearance();
  useLayoutEffect(() => {
    const root = document.documentElement;
    const variables = getAppThemeVariables(mode);
    const previous = Object.keys(variables).map(key => [key, root.style.getPropertyValue(key)] as const);
    root.dataset.appTheme = mode;
    root.dataset.themeFamily = "forest";
    Object.entries(variables).forEach(([key, value]) => root.style.setProperty(key, value));
    return () => {
      previous.forEach(([key, value]) => value ? root.style.setProperty(key, value) : root.style.removeProperty(key));
      delete root.dataset.appTheme;
      delete root.dataset.themeFamily;
    };
  }, [mode]);
}
