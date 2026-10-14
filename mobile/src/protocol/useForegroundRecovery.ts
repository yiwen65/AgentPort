import { useEffect, useRef } from "react";
import type { ConnectionState, RemoteClient, Unsubscribe } from "./remoteClient";
import { checkConnection, recoverConnection } from "./connectionRecovery";

/** iOS may suspend event delivery; do not require a missed disconnect event. */
export function useForegroundRecovery(client: RemoteClient, profileId: string, active: boolean, callbacks: {
  onChecking?: () => void;
  onStart: () => void; onRecovered: () => void; onError: (error: unknown) => void;
}) {
  const latest = useRef({ active, callbacks });
  const reconcileNative = useRef<() => void>(() => undefined);
  latest.current = { active, callbacks };
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    let hidden = document.visibilityState === "hidden";
    let foregroundPending = hidden;
    let generation = 0;
    let phase: ConnectionState | undefined;
    let connectionVersion = 0;
    let completedCheck: { attempt: number; version: number } | undefined;
    let checkingAttempt: number | undefined;
    let waitingForNative: number | undefined;
    let unsubscribe: Unsubscribe | undefined;
    const current = (attempt: number) => !cancelled && attempt === generation && latest.current.active && document.visibilityState !== "hidden";
    const joinNative = (attempt: number) => {
      if (waitingForNative === attempt) return;
      waitingForNative = attempt;
      latest.current.callbacks.onStart();
      // Resume an existing retry owner even after a long background outage;
      // joining must not inherit its remaining exponential-backoff sleep.
      void client.resumeConnection?.(profileId).catch(() => {});
    };
    const settleNative = () => {
      const attempt = waitingForNative;
      if (attempt === undefined || !current(attempt) || !phase || !["connected", "failed", "disconnected"].includes(phase)) return;
      waitingForNative = undefined;
      checkingAttempt = undefined;
      generation++; // Ignore any pending old-transport probe completion.
      if (phase === "connected") latest.current.callbacks.onRecovered();
      else latest.current.callbacks.onError(new Error("Automatic connection recovery ended before the transport became usable"));
    };
    void client.onConnectionState(event => {
      if (cancelled || event.profileId !== profileId) return;
      phase = event.state;
      connectionVersion++;
      // A failed probe belongs to the old reader. Do not cancel a native
      // reconnect that started meanwhile, or retire its healthy replacement.
      if ((phase === "connecting" || phase === "reconnecting") && checkingAttempt !== undefined && current(checkingAttempt)) {
        joinNative(checkingAttempt);
      }
      settleNative();
    }).then(value => { if (cancelled) void value(); else unsubscribe = value; }).catch(() => {
      // Listener setup failure leaves the existing bounded probe/recovery path.
    });
    const checkForeground = () => {
      if (!latest.current.active || document.visibilityState === "hidden") return;
      foregroundPending = false;
      completedCheck = undefined;
      const attempt = ++generation;
      latest.current.callbacks.onChecking?.();
      if (phase === "connecting" || phase === "reconnecting") {
        joinNative(attempt);
        return;
      }
      checkingAttempt = attempt;
      const probeVersion = connectionVersion;
      void checkConnection(client, profileId).then(async healthy => {
        if (!current(attempt)) {
          if (healthy && !cancelled && attempt === generation && waitingForNative === undefined) {
            checkingAttempt = undefined;
            completedCheck = { attempt, version: probeVersion };
          }
          return;
        }
        if (waitingForNative === attempt) return;
        if (connectionVersion !== probeVersion && phase === "connected") {
          // The old probe is not evidence about a replacement whose prior
          // reconnect event was missed. Recheck it rather than disconnect it.
          checkForeground();
          return;
        }
        checkingAttempt = undefined;
        if (!healthy) {
          latest.current.callbacks.onStart();
          await recoverConnection(client, profileId);
        }
        if (current(attempt)) latest.current.callbacks.onRecovered();
        else if (!cancelled && attempt === generation) {
          if (phase && phase !== "connected") foregroundPending = true;
          else completedCheck = { attempt, version: connectionVersion };
        }
      }).catch(error => {
        if (current(attempt)) latest.current.callbacks.onError(error);
        else if (!cancelled && attempt === generation) foregroundPending = true;
      });
    };
    const changed = () => {
      if (document.visibilityState === "hidden") {
        hidden = true; foregroundPending = true; generation++; completedCheck = undefined; checkingAttempt = undefined; waitingForNative = undefined; return;
      }
      if (!hidden) return;
      hidden = false;
      checkForeground();
    };
    // A retained view may be inactive through both completion and another
    // visibility cycle. On return, settle its join or run the skipped check;
    // never leave a consumer's onChecking gate permanently occupied.
    reconcileNative.current = () => {
      if (completedCheck && current(completedCheck.attempt) && completedCheck.version === connectionVersion) {
        completedCheck = undefined;
        generation++;
        latest.current.callbacks.onRecovered();
      } else if (foregroundPending || completedCheck || (checkingAttempt !== undefined && waitingForNative === undefined)) checkForeground();
      else settleNative();
    };
    document.addEventListener("visibilitychange", changed);
    return () => { cancelled = true; reconcileNative.current = () => undefined; document.removeEventListener("visibilitychange", changed); if (unsubscribe) void unsubscribe(); };
  }, [client, profileId]);
  useEffect(() => { if (active) reconcileNative.current(); }, [active]);
}
