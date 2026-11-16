// Explicit remote-device connection registry. A device enters this registry
// only through a user action (switch, manual connect, opening one of its
// panes) and stays connected until an explicit disconnect, device removal or
// app exit. Startup restores the persisted set; unexpected transport loss only
// marks the device disconnected and never auto-reconnects.

import { useSyncExternalStore } from "react";
import { deviceCommandError } from "./devicesStore";
import { dropRemoteBackend, remoteBackendFor } from "./remote/runtime";
import type { RemoteHello } from "./remote/types";
import { LOCAL_DEVICE_KEY } from "./sessionIdentity";

export const CONNECTED_DEVICES_STORAGE_KEY =
  "agentport-connected-device-ids:v1";

export type DeviceConnectionPhase =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface RemoteDeviceConnection {
  phase: DeviceConnectionPhase;
  error: string | null;
  hello: RemoteHello | null;
}

export interface DeviceConnectionsState {
  connections: Record<string, RemoteDeviceConnection>;
  /** Remote device ids the user explicitly connected, persisted across runs. */
  explicitDeviceIds: string[];
}

function readPersistedDeviceIds(): string[] {
  try {
    const raw = window.localStorage.getItem(CONNECTED_DEVICES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string"))];
  } catch {
    return [];
  }
}

function persistDeviceIds(ids: readonly string[]) {
  try {
    window.localStorage.setItem(
      CONNECTED_DEVICES_STORAGE_KEY,
      JSON.stringify([...new Set(ids)].sort()),
    );
  } catch {
    // Explicit connections remain usable for this run without storage.
  }
}

let state: DeviceConnectionsState = {
  connections: {},
  explicitDeviceIds: readPersistedDeviceIds(),
};
const listeners = new Set<() => void>();
const pendingConnects = new Map<string, Promise<RemoteHello>>();
/** Per-device attempt fence. Disconnect/forget invalidates an in-flight dial. */
const connectGenerations = new Map<string, number>();

function invalidatePendingConnect(deviceId: string) {
  connectGenerations.set(deviceId, (connectGenerations.get(deviceId) ?? 0) + 1);
  pendingConnects.delete(deviceId);
}

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<DeviceConnectionsState>) {
  state = { ...state, ...patch };
  emit();
}

function setConnection(deviceId: string, patch: Partial<RemoteDeviceConnection>) {
  const current = state.connections[deviceId] ?? {
    phase: "disconnected" as const,
    error: null,
    hello: null,
  };
  setState({
    connections: {
      ...state.connections,
      [deviceId]: { ...current, ...patch },
    },
  });
}

function rememberExplicit(deviceId: string) {
  if (state.explicitDeviceIds.includes(deviceId)) return;
  const explicitDeviceIds = [...state.explicitDeviceIds, deviceId];
  persistDeviceIds(explicitDeviceIds);
  setState({ explicitDeviceIds });
}

export function getDeviceConnectionsState(): DeviceConnectionsState {
  return state;
}

export function subscribeDeviceConnections(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceConnections(): DeviceConnectionsState;
export function useDeviceConnections<T>(
  selector: (snapshot: DeviceConnectionsState) => T,
): T;
export function useDeviceConnections<T>(
  selector?: (snapshot: DeviceConnectionsState) => T,
): DeviceConnectionsState | T {
  if (selector) {
    return useSyncExternalStore(
      subscribeDeviceConnections,
      () => selector(state),
    );
  }
  return useSyncExternalStore(subscribeDeviceConnections, getDeviceConnectionsState);
}

export function isLocalDevice(deviceId: string): boolean {
  return deviceId === LOCAL_DEVICE_KEY;
}

/** Local sessions are always available; remote devices need a live transport. */
export function isDeviceConnected(deviceId: string): boolean {
  if (isLocalDevice(deviceId)) return true;
  return state.connections[deviceId]?.phase === "connected";
}

export function deviceConnectionFor(
  deviceId: string,
): RemoteDeviceConnection {
  if (isLocalDevice(deviceId)) {
    return { phase: "connected", error: null, hello: null };
  }
  return (
    state.connections[deviceId] ?? {
      phase: "disconnected",
      error: null,
      hello: null,
    }
  );
}

export function isExplicitlyConnected(deviceId: string): boolean {
  return isLocalDevice(deviceId) || state.explicitDeviceIds.includes(deviceId);
}

/**
 * Connect one remote device. Concurrent callers share one dial. Success adds
 * the device to the explicit set; failure is recorded and never auto-retried.
 */
export function connectDevice(deviceId: string): Promise<RemoteHello> {
  if (isLocalDevice(deviceId)) {
    return Promise.reject(new Error("the local device is always connected"));
  }
  const existing = state.connections[deviceId];
  if (existing?.phase === "connected" && existing.hello) {
    rememberExplicit(deviceId);
    return Promise.resolve(existing.hello);
  }
  const pending = pendingConnects.get(deviceId);
  if (pending) return pending;

  setConnection(deviceId, { phase: "connecting", error: null });
  const backend = remoteBackendFor(deviceId);
  const generation = (connectGenerations.get(deviceId) ?? 0) + 1;
  connectGenerations.set(deviceId, generation);
  let attempt!: Promise<RemoteHello>;
  attempt = backend.client.connect().then(
    (hello) => {
      if (pendingConnects.get(deviceId) === attempt) {
        pendingConnects.delete(deviceId);
      }
      if (connectGenerations.get(deviceId) !== generation) {
        // The user disconnected/removed the device while the dial was in
        // flight. Do not resurrect it or persist it as explicitly connected.
        void backend.client.disconnect().catch(() => undefined);
        return hello;
      }
      setConnection(deviceId, { phase: "connected", error: null, hello });
      rememberExplicit(deviceId);
      return hello;
    },
    (cause) => {
      if (pendingConnects.get(deviceId) === attempt) {
        pendingConnects.delete(deviceId);
      }
      if (connectGenerations.get(deviceId) === generation) {
        setConnection(deviceId, {
          phase: "error",
          error: deviceCommandError(cause).message,
          hello: null,
        });
      }
      throw cause;
    },
  );
  pendingConnects.set(deviceId, attempt);
  return attempt;
}

/** Explicit disconnect: release the transport and forget the explicit set. */
export async function disconnectDevice(deviceId: string): Promise<void> {
  if (isLocalDevice(deviceId)) return;
  invalidatePendingConnect(deviceId);
  const backend = remoteBackendFor(deviceId);
  try {
    await backend.client.disconnect();
  } catch {
    // The transport may already be gone; the local registry must still clear.
  } finally {
    dropRemoteBackend(deviceId);
    setConnection(deviceId, {
      phase: "disconnected",
      error: null,
      hello: null,
    });
    const explicitDeviceIds = state.explicitDeviceIds.filter(
      (id) => id !== deviceId,
    );
    persistDeviceIds(explicitDeviceIds);
    setState({ explicitDeviceIds });
  }
}

/**
 * Transport loss discovered by a request/attach failure. Keeps the device in
 * the explicit set so the next launch can retry, but never auto-reconnects in
 * this run; panes show a reconnect entry.
 */
export function markDeviceDisconnected(deviceId: string, error?: string): void {
  if (isLocalDevice(deviceId)) return;
  const current = state.connections[deviceId];
  if (current?.phase === "disconnected" && !error) return;
  invalidatePendingConnect(deviceId);
  const backend = remoteBackendFor(deviceId);
  void backend.client.disconnect().catch(() => undefined);
  dropRemoteBackend(deviceId);
  setConnection(deviceId, {
    phase: error ? "error" : "disconnected",
    error: error ?? null,
    hello: null,
  });
}

/** Remove every trace of a deleted device profile. */
export function forgetDeviceConnection(deviceId: string): void {
  if (isLocalDevice(deviceId)) return;
  invalidatePendingConnect(deviceId);
  void remoteBackendFor(deviceId).client.disconnect().catch(() => undefined);
  dropRemoteBackend(deviceId);
  const connections = { ...state.connections };
  delete connections[deviceId];
  const explicitDeviceIds = state.explicitDeviceIds.filter(
    (id) => id !== deviceId,
  );
  persistDeviceIds(explicitDeviceIds);
  setState({ connections, explicitDeviceIds });
}

/**
 * Reconnect the persisted explicit set. Call after the device registry is
 * available so deleted profiles are not dialed. Failures stay visible per
 * device; startup never invents a connection.
 */
export async function restoreExplicitConnections(
  validDeviceIds?: ReadonlySet<string>,
): Promise<void> {
  const ids = state.explicitDeviceIds.filter(
    (id) => !validDeviceIds || validDeviceIds.has(id),
  );
  if (ids.length !== state.explicitDeviceIds.length) {
    persistDeviceIds(ids);
    setState({ explicitDeviceIds: ids });
  }
  await Promise.allSettled(ids.map((id) => connectDevice(id)));
}

/** Test hook: clear in-memory and persisted state. */
export function resetDeviceConnectionsForTests(persist = false): void {
  pendingConnects.clear();
  connectGenerations.clear();
  state = {
    connections: {},
    explicitDeviceIds: persist ? readPersistedDeviceIds() : [],
  };
  emit();
}
