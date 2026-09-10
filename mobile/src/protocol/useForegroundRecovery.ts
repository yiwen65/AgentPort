import { useEffect, useRef } from "react";
import type { RemoteClient } from "./remoteClient";
import { checkConnection, recoverConnection } from "./connectionRecovery";

/** iOS may suspend event delivery; do not require a missed disconnect event. */
export function useForegroundRecovery(client: RemoteClient, profileId: string, active: boolean, callbacks: {
  onChecking?: () => void;
  onStart: () => void; onRecovered: () => void; onError: (error: unknown) => void;
}) {
  const latest = useRef({ active, callbacks });
  latest.current = { active, callbacks };
  useEffect(() => {
    let cancelled = false;
    let hidden = document.visibilityState === "hidden";
    let generation = 0;
    const changed = () => {
      if (document.visibilityState === "hidden") { hidden = true; generation++; return; }
      if (!hidden) return;
      hidden = false;
      if (!profileId || !latest.current.active) return;
      const attempt = ++generation;
      const current = () => !cancelled && attempt === generation && latest.current.active && document.visibilityState !== "hidden";
      latest.current.callbacks.onChecking?.();
      void checkConnection(client, profileId).then(async healthy => {
        if (!current()) return;
        if (!healthy) {
          latest.current.callbacks.onStart();
          await recoverConnection(client, profileId);
        }
        if (current()) latest.current.callbacks.onRecovered();
      }).catch(error => { if (current()) latest.current.callbacks.onError(error); });
    };
    document.addEventListener("visibilitychange", changed);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", changed); };
  }, [client, profileId]);
}
