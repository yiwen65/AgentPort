import { useEffect, useState, useSyncExternalStore } from "react";
import {
  loadMobileTerminalAppearance,
  MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY,
  saveMobileTerminalAppearance,
  type MobileTerminalAppearance,
} from "./terminalThemes";

let snapshot: MobileTerminalAppearance | undefined;
const listeners = new Set<() => void>();
function apply(next: MobileTerminalAppearance) {
  if (snapshot?.theme === next.theme && snapshot.mode === next.mode) return;
  snapshot = next;
  listeners.forEach(listener => listener());
}
function getSnapshot() {
  // First consumer of a new app lifetime reads storage. Later consumers share
  // the live choice, including edits that could not be persisted.
  if (!listeners.size || !snapshot) {
    const stored = loadMobileTerminalAppearance();
    if (snapshot?.theme !== stored.theme || snapshot.mode !== stored.mode) snapshot = stored;
  }
  return snapshot!;
}
function onStorage(event: StorageEvent) {
  if (event.key === null || event.key === MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY) apply(loadMobileTerminalAppearance());
}
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", onStorage);
  };
}
function updateAppearance(patch: Partial<MobileTerminalAppearance>) {
  const next = { ...getSnapshot(), ...patch };
  saveMobileTerminalAppearance(next);
  apply(next);
}

/** Persisted terminal and immersive Session theme, independent of the main interface. */
export function useMobileTerminalAppearance() {
  const appearance = useSyncExternalStore(subscribe, getSnapshot);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const changed = () => setSystemDark(media?.matches ?? false);
    changed();
    media?.addEventListener("change", changed);
    return () => media?.removeEventListener("change", changed);
  }, []);
  const resolvedMode = appearance.mode === "system" ? (systemDark ? "dark" : "light") : appearance.mode;
  return [appearance, updateAppearance, resolvedMode] as const;
}
