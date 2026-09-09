import { useEffect, useRef } from "react";
import type { RemoteClient } from "./remoteClient";
import { recoverConnection } from "./connectionRecovery";

/** iOS may suspend event delivery; do not require a missed disconnect event. */
export function useForegroundRecovery(client: RemoteClient, profileId: string, active: boolean, callbacks: {
  onStart: () => void; onRecovered: () => void; onError: (error: unknown) => void;
}) {
  const latest = useRef({ active, callbacks });
  latest.current = { active, callbacks };
  useEffect(() => {
    let cancelled = false;
    let hidden = document.visibilityState === "hidden";
    const changed = () => {
      if (document.visibilityState === "hidden") { hidden = true; return; }
      if (!hidden) return;
      hidden = false;
      if (!profileId || !latest.current.active) return;
      latest.current.callbacks.onStart();
      void recoverConnection(client, profileId).then(() => {
        if (!cancelled) latest.current.callbacks.onRecovered();
      }).catch(error => { if (!cancelled) latest.current.callbacks.onError(error); });
    };
    document.addEventListener("visibilitychange", changed);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", changed); };
  }, [client, profileId]);
}
