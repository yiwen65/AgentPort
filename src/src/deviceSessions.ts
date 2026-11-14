// Cross-device Session snapshots for the global Active view. The active
// device stays authoritative in store.projects; this module caches every other
// connected device (and the local device while a remote is active) without
// touching the active project tree.

import { useSyncExternalStore } from "react";
import { errorText } from "./api";
import { localDeviceApi } from "./deviceApi";
import {
  getDeviceConnectionsState,
  isDeviceConnected,
  markDeviceDisconnected,
} from "./deviceConnections";
import { getDevicesState } from "./devicesStore";
import { isRemoteRequestError } from "./remote/errors";
import { remoteBackendFor } from "./remote/runtime";
import {
  deviceKeyForContext,
  parseSessionKey,
  sessionKeyFor,
  LOCAL_DEVICE_KEY,
} from "./sessionIdentity";
import { getState, patchSession, type AppState } from "./store";
import type { ProjectView, SessionView, StatusEventView } from "./types";

export interface DeviceSessionSnapshot {
  deviceId: string;
  deviceName: string;
  transport: "local" | "ssh" | "relay";
  projects: ProjectView[];
  fetchedAt: number;
  /** When worktree metadata was last fetched with a full project pass. */
  metadataFetchedAt: number;
  loading: boolean;
  error: string | null;
}

export interface DeviceSessionsState {
  snapshots: Record<string, DeviceSessionSnapshot>;
  refreshing: boolean;
}

let state: DeviceSessionsState = { snapshots: {}, refreshing: false };
const listeners = new Set<() => void>();
const generations = new Map<string, number>();
let refreshingCount = 0;

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshots(snapshots: Record<string, DeviceSessionSnapshot>) {
  state = { ...state, snapshots };
  emit();
}

function setRefreshing(delta: number) {
  refreshingCount = Math.max(0, refreshingCount + delta);
  const refreshing = refreshingCount > 0;
  if (refreshing === state.refreshing) return;
  state = { ...state, refreshing };
  emit();
}

function publish(snapshot: DeviceSessionSnapshot) {
  setSnapshots({ ...state.snapshots, [snapshot.deviceId]: snapshot });
}

export function getDeviceSessionsState(): DeviceSessionsState {
  return state;
}

export function subscribeDeviceSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDeviceSessions(): DeviceSessionsState;
export function useDeviceSessions<T>(
  selector: (snapshot: DeviceSessionsState) => T,
): T;
export function useDeviceSessions<T>(
  selector?: (snapshot: DeviceSessionsState) => T,
): DeviceSessionsState | T {
  if (selector) {
    return useSyncExternalStore(subscribeDeviceSessions, () => selector(state));
  }
  return useSyncExternalStore(subscribeDeviceSessions, getDeviceSessionsState);
}

export function activeDeviceKeyOf(
  app: Pick<AppState, "activeDevice">,
): string {
  return deviceKeyForContext(app.activeDevice);
}

function deviceNameFor(deviceId: string, activeKey: string): string {
  if (deviceId === activeKey) {
    const active = getState().activeDevice;
    return active.kind === "remote" ? active.deviceName : LOCAL_DEVICE_KEY;
  }
  if (deviceId === LOCAL_DEVICE_KEY) return LOCAL_DEVICE_KEY;
  return (
    getDevicesState().devices?.find((device) => device.id === deviceId)?.name ??
    deviceId
  );
}

function transportFor(
  deviceId: string,
  activeKey: string,
): DeviceSessionSnapshot["transport"] {
  if (deviceId === LOCAL_DEVICE_KEY) return "local";
  if (deviceId === activeKey) {
    const active = getState().activeDevice;
    if (active.kind === "local") return "local";
  }
  return (
    getDevicesState().devices?.find((device) => device.id === deviceId)
      ?.transport ?? "relay"
  );
}

/**
 * Refresh one non-active device snapshot. The active device is served by
 * store.projects, so callers skip it; `force` is only for tests/migration.
 */
export async function refreshDeviceSnapshot(
  deviceId: string,
  options: { force?: boolean } = {},
): Promise<boolean> {
  const activeKey = activeDeviceKeyOf(getState());
  if (deviceId === activeKey && !options.force) return false;
  const generation = (generations.get(deviceId) ?? 0) + 1;
  generations.set(deviceId, generation);
  const previous = state.snapshots[deviceId];
  const snapshot: DeviceSessionSnapshot = {
    deviceId,
    deviceName: deviceNameFor(deviceId, activeKey),
    transport: transportFor(deviceId, activeKey),
    projects: previous?.projects ?? [],
    fetchedAt: previous?.fetchedAt ?? 0,
    metadataFetchedAt: previous?.metadataFetchedAt ?? 0,
    loading: true,
    error: null,
  };
  publish(snapshot);
  setRefreshing(1);
  try {
    let projects: ProjectView[];
    let metadataFetchedAt = snapshot.metadataFetchedAt;
    if (deviceId === LOCAL_DEVICE_KEY) {
      // Bypass the routed api: the active device may be remote, but this read
      // is explicitly about THIS computer.
      projects = await localDeviceApi().listProjects(null);
      metadataFetchedAt = Date.now();
    } else {
      if (!isDeviceConnected(deviceId)) {
        throw new Error(`device ${deviceId} is not connected`);
      }
      const backend = remoteBackendFor(deviceId);
      const needsMetadata =
        previous === undefined ||
        Date.now() - snapshot.metadataFetchedAt > 60_000;
      if (needsMetadata) {
        projects = await backend.listProjects(null);
        metadataFetchedAt = Date.now();
      } else {
        const fresh = await backend.listProjectSessions(null);
        const byId = new Map(
          previous.projects.map((project) => [project.id, project]),
        );
        // Worktree lists are expensive on the wire; reuse the last full pass.
        projects = fresh.map((project) => ({
          ...project,
          worktrees: byId.get(project.id)?.worktrees ?? [],
        }));
      }
    }
    if (generations.get(deviceId) !== generation) return false;
    publish({
      ...snapshot,
      projects: mergeSessionStates(projects, previous?.projects),
      fetchedAt: Date.now(),
      metadataFetchedAt,
      loading: false,
      error: null,
    });
    return true;
  } catch (cause) {
    if (generations.get(deviceId) !== generation) return false;
    if (
      isRemoteRequestError(cause) &&
      (cause.code === "not_connected" || cause.code === "transport_closed")
    ) {
      markDeviceDisconnected(deviceId, cause.message);
    }
    publish({
      ...snapshot,
      loading: false,
      error: errorText(cause),
    });
    return false;
  } finally {
    if (generations.get(deviceId) === generation) setRefreshing(-1);
  }
}

let connectedRefresh: Promise<void> | null = null;

/**
 * Refresh every connected device except the active one. The local device is
 * included when a remote device is active. Failures are isolated per device.
 */
export function refreshConnectedDeviceSnapshots(): Promise<void> {
  if (connectedRefresh) return connectedRefresh;
  connectedRefresh = refreshConnectedDeviceSnapshotsOnce().finally(() => {
    connectedRefresh = null;
  });
  return connectedRefresh;
}

async function refreshConnectedDeviceSnapshotsOnce(): Promise<void> {
  const app = getState();
  const activeKey = activeDeviceKeyOf(app);
  const targets = new Set<string>();
  if (activeKey !== LOCAL_DEVICE_KEY) targets.add(LOCAL_DEVICE_KEY);
  const connections = getDeviceConnectionsState();
  for (const deviceId of connections.explicitDeviceIds) {
    if (deviceId !== activeKey && isDeviceConnected(deviceId)) {
      targets.add(deviceId);
    }
  }
  for (const [deviceId, connection] of Object.entries(connections.connections)) {
    if (deviceId !== activeKey && connection.phase === "connected") {
      targets.add(deviceId);
    }
  }
  await Promise.allSettled(
    [...targets].map((deviceId) => refreshDeviceSnapshot(deviceId)),
  );
}

export function dropDeviceSnapshot(deviceId: string): void {
  generations.set(deviceId, (generations.get(deviceId) ?? 0) + 1);
  if (!(deviceId in state.snapshots)) return;
  const snapshots = { ...state.snapshots };
  delete snapshots[deviceId];
  setSnapshots(snapshots);
}

export function latestStatus(
  current: StatusEventView | null | undefined,
  incoming: StatusEventView | null | undefined,
): StatusEventView | null | undefined {
  if (incoming === undefined) return undefined;
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.runOrdinal < current.runOrdinal) return current;
  if (
    incoming.runOrdinal === current.runOrdinal &&
    (incoming.runId !== current.runId || incoming.sequence < current.sequence)
  ) {
    return current;
  }
  return incoming;
}

/** Never let a poll regress a status already delivered by a pane channel. */
function mergeSessionStates(
  projects: ProjectView[],
  previous: ProjectView[] | undefined,
): ProjectView[] {
  if (!previous?.length) return projects;
  const currentById = new Map<string, Map<string, SessionView>>();
  for (const project of previous) {
    currentById.set(
      project.id,
      new Map(project.sessions.map((session) => [session.id, session])),
    );
  }
  return projects.map((project) => {
    const currentSessions = currentById.get(project.id);
    if (!currentSessions) return project;
    return {
      ...project,
      sessions: project.sessions.map((session) => {
        const current = currentSessions.get(session.id);
        if (!current) return session;
        const status = latestStatus(current.status, session.status) ?? null;
        const stale = session.status && status !== session.status;
        return {
          ...session,
          status,
          ...(stale
            ? { lifecycle: current.lifecycle, hostAlive: current.hostAlive }
            : {}),
        };
      }),
    };
  });
}

export function deviceSnapshotFor(
  deviceId: string,
): DeviceSessionSnapshot | null {
  return state.snapshots[deviceId] ?? null;
}

/**
 * Capture the active device's project tree before it becomes a background
 * device. Without this seed, switching away would leave its still-mounted
 * panes unable to resolve their Sessions until the next Active-view poll.
 */
export function seedActiveDeviceSnapshot(): void {
  const app = getState();
  const activeKey = activeDeviceKeyOf(app);
  const activeName =
    app.activeDevice.kind === "remote"
      ? app.activeDevice.deviceName
      : LOCAL_DEVICE_KEY;
  publish({
    deviceId: activeKey,
    deviceName: activeName,
    transport:
      app.activeDevice.kind === "local"
        ? "local"
        : (getDevicesState().devices?.find(
            (device) => device.id === activeKey,
          )?.transport ?? "relay"),
    projects: app.projects,
    fetchedAt: Date.now(),
    metadataFetchedAt: Date.now(),
    loading: false,
    error: null,
  });
}

function projectsForDevice(
  app: Pick<AppState, "activeDevice" | "projects">,
  deviceId: string,
): ProjectView[] {
  return deviceId === activeDeviceKeyOf(app)
    ? app.projects
    : (state.snapshots[deviceId]?.projects ?? []);
}

export interface LocatedSession {
  deviceId: string;
  key: string;
  session: SessionView;
  project: ProjectView;
}

/** Resolve a stable Session key across the active tree and device snapshots. */
export function findSessionByKeyForState(
  app: Pick<AppState, "activeDevice" | "projects">,
  key: string | null,
): LocatedSession | null {
  if (!key) return null;
  const { deviceKey, sessionId } = parseSessionKey(key);
  const projects = projectsForDevice(app, deviceKey);
  for (const project of projects) {
    const session = project.sessions.find((entry) => entry.id === sessionId);
    if (session) return { deviceId: deviceKey, key, session, project };
  }
  return null;
}

export function findSessionByKey(key: string | null): LocatedSession | null {
  return findSessionByKeyForState(getState(), key);
}

export function findProjectByKey(key: string | null): ProjectView | null {
  return findSessionByKey(key)?.project ?? null;
}

/** True when the device has a cached or active snapshot entry for the Session. */
export function deviceHasSession(deviceId: string, sessionId: string): boolean {
  const app = getState();
  return Boolean(
    findSessionByKeyForState(app, sessionKeyFor(deviceId, sessionId)),
  );
}

/**
 * Patch a Session in whatever snapshot owns its key. Active-device patches
 * keep the existing run/sequence authority; background snapshots are replaced
 * immutably so subscribed rows update.
 */
export function patchSessionByKey(
  key: string,
  patch: Partial<SessionView>,
): void {
  const app = getState();
  const { deviceKey, sessionId } = parseSessionKey(key);
  if (deviceKey === activeDeviceKeyOf(app)) {
    patchSession(sessionId, patch);
    return;
  }
  const snapshot = state.snapshots[deviceKey];
  if (!snapshot) return;
  let projectChanged = false;
  const projects = snapshot.projects.map((project) => {
    let sessionChanged = false;
    const sessions = project.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      sessionChanged = true;
      return { ...session, ...patch };
    });
    if (!sessionChanged) return project;
    projectChanged = true;
    return { ...project, sessions };
  });
  if (!projectChanged) return;
  publish({ ...snapshot, projects });
}

/** Remove one Session from a background snapshot (active removal is store-owned). */
export function removeSessionFromSnapshot(key: string): void {
  const app = getState();
  const { deviceKey, sessionId } = parseSessionKey(key);
  if (deviceKey === activeDeviceKeyOf(app)) return;
  const snapshot = state.snapshots[deviceKey];
  if (!snapshot) return;
  let changed = false;
  const projects = snapshot.projects.map((project) => {
    const sessions = project.sessions.filter((session) => session.id !== sessionId);
    if (sessions.length === project.sessions.length) return project;
    changed = true;
    return { ...project, sessions };
  });
  if (changed) publish({ ...snapshot, projects });
}

/** Test hook: reset snapshots and in-flight generations. */
export function resetDeviceSessionsForTests(): void {
  state = { snapshots: {}, refreshing: false };
  generations.clear();
  refreshingCount = 0;
  emit();
}
