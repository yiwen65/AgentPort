import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export const APP_APPEARANCE_KEY = "agentport-mobile-v2:app-appearance";
export const APP_APPEARANCES = ["light", "dark", "system"] as const;
export type AppAppearance = typeof APP_APPEARANCES[number];
const CHANGE_EVENT = "agentport-mobile-app-appearance-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const valid = (value: unknown): value is AppAppearance => APP_APPEARANCES.includes(value as AppAppearance);

export function loadAppAppearance(): AppAppearance {
  try {
    const value = localStorage.getItem(APP_APPEARANCE_KEY);
    return valid(value) ? value : "system";
  } catch { return "system"; }
}

/** Independent from terminal appearance. Same-document events keep retained views in sync. */
export function useAppAppearance() {
  const [preference, setPreference] = useState(loadAppAppearance);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    const systemChanged = () => setSystemDark(media?.matches ?? false);
    const changed = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (valid(value)) setPreference(value);
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === APP_APPEARANCE_KEY || event.key === null) setPreference(loadAppAppearance());
    };
    systemChanged();
    media?.addEventListener("change", systemChanged);
    window.addEventListener(CHANGE_EVENT, changed);
    window.addEventListener("storage", storageChanged);
    return () => {
      media?.removeEventListener("change", systemChanged);
      window.removeEventListener(CHANGE_EVENT, changed);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  const update = useCallback((value: AppAppearance) => {
    try { localStorage.setItem(APP_APPEARANCE_KEY, value); } catch { /* live edits still work */ }
    setPreference(value);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
  }, []);
  return { preference, update, resolved: preference === "system" ? (systemDark ? "dark" : "light") : preference };
}

export function useApplyAppAppearance() {
  const { resolved } = useAppAppearance();
  useLayoutEffect(() => {
    document.documentElement.dataset.appTheme = resolved;
    return () => { delete document.documentElement.dataset.appTheme; };
  }, [resolved]);
}
