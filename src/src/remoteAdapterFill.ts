// Background remote adapter refresh. The interactive bridge is shared with
// session I/O, so this never runs agent probes: it only reads the install
// records the remote Host already cached. Explicit "check again" actions run
// the real probes on demand.

import {
  rememberRemoteAdapters,
  remoteAdaptersStale,
} from "./remoteAdapterCache";
import { remoteBackendFor } from "./remote/runtime";
import { getState, setState } from "./store";

const REMOTE_ADAPTER_MAX_AGE_MS = 2 * 60_000;
const remoteAdapterFills = new Map<string, Promise<void>>();

/**
 * Refresh the active remote device's adapter list from the Host cache. The
 * request is a fast metadata read (agent.supported), so terminal input is not
 * queued behind multi-second probing.
 */
export function refreshActiveRemoteAdaptersIfStale(
  maxAgeMs = REMOTE_ADAPTER_MAX_AGE_MS,
): void {
  const state = getState();
  if (state.activeDevice.kind !== "remote") return;
  const deviceId = state.activeDevice.deviceId;
  if (!remoteAdaptersStale(deviceId, maxAgeMs)) return;
  if (remoteAdapterFills.has(deviceId)) return;

  const run = (async () => {
    const installs = await remoteBackendFor(deviceId)
      .listCachedAdapterInstalls()
      .catch(() => null);
    if (!installs?.length) return;
    const current = getState().activeDevice;
    if (current.kind !== "remote" || current.deviceId !== deviceId) return;
    rememberRemoteAdapters(deviceId, installs);
    setState({ adapters: installs });
  })();

  remoteAdapterFills.set(deviceId, run);
  void run.finally(() => {
    if (remoteAdapterFills.get(deviceId) === run) {
      remoteAdapterFills.delete(deviceId);
    }
  });
}

/** Test hook: drop in-flight fill bookkeeping. */
export function resetRemoteAdapterFillForTests(): void {
  remoteAdapterFills.clear();
}
