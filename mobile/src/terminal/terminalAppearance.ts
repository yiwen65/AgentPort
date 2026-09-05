import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadMobileTerminalAppearance,
  MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY,
  saveMobileTerminalAppearance,
  type MobileTerminalAppearance,
} from "./terminalThemes";

const CHANGE_EVENT = "agentport-mobile-terminal-appearance-change";

/** Read on mount, not module import: storage may change between app lifetimes. */
export function useMobileTerminalAppearance() {
  const [appearance, setAppearance] = useState(loadMobileTerminalAppearance);
  const current = useRef(appearance);

  useEffect(() => {
    const apply = (next: MobileTerminalAppearance) => {
      current.current = next;
      setAppearance((previous) => previous.theme === next.theme && previous.mode === next.mode ? previous : next);
    };
    const onChange = (event: Event) => apply((event as CustomEvent<MobileTerminalAppearance>).detail);
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === MOBILE_TERMINAL_APPEARANCE_STORAGE_KEY) apply(loadMobileTerminalAppearance());
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    apply(loadMobileTerminalAppearance());
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const updateAppearance = useCallback((patch: Partial<MobileTerminalAppearance>) => {
    const next = { ...current.current, ...patch };
    // Explicit edits only: mounting a consumer must never overwrite persistence.
    saveMobileTerminalAppearance(next);
    // Native storage events don't fire in this document. Carry the value so
    // mounted consumers still update when persistence is unavailable.
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
  }, []);

  return [appearance, updateAppearance] as const;
}
