// Shared subscription to the Rust-owned update state. Two surfaces read it
// (the consent card and the Settings entry), and a GUI reload can miss the
// events that led to the current phase, so the command reply is the resync
// source — without ever overwriting a newer event that already arrived.

import { useEffect, useState } from "react";
import { api, onUpdateState, type UpdateSnapshot } from "./api";

export function useUpdateState(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void onUpdateState((next) => {
      if (!active) return;
      setSnapshot(next);
    })
      .then((off) => {
        if (active) unlisten = off;
        else off();
      })
      .catch(() => undefined);
    void api
      .updateStatus()
      .then((initial) => {
        if (!active) return;
        setSnapshot((current) => current ?? initial);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return snapshot;
}
