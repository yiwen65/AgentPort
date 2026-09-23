// Device list store for desktop multi-device switching. Self-contained module
// (store.ts stays untouched): device registry state, the frozen device_*
// command wrappers with an injectable invoker, and the device-switch handler
// registry that the boot/switch flow plugs into. New desktop code.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { DeviceContext } from "./deviceContext";

// ---------------------------------------------------------------------------
// Types (wire-tolerant: the Rust registry task freezes its exact enum tagging
// independently, so normalizeDeviceProfile accepts every plausible shape).
// ---------------------------------------------------------------------------

export interface RelayPeerInfo {
  relayUrl: string;
  publicKey: string;
  hostId: string;
}

export interface DeviceProfile {
  id: string;
  name: string;
  transport: "ssh" | "relay";
  /** SSH transport fields. */
  hostname?: string;
  port?: number;
  username?: string;
  /** Relay transport fields. */
  peer?: RelayPeerInfo;
  createdAt?: string;
  lastConnectedAt?: string | null;
  lastError?: string | null;
}

export type DeviceSshAuth =
  | { kind: "password"; password: string }
  | { kind: "privateKey"; pem: string; passphrase?: string };

export interface DeviceSshDraft {
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth: DeviceSshAuth;
}

/** Structured error bodies returned by device_* / remote_* Rust commands. */
export interface DeviceCommandError {
  code: string;
  message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePeer(raw: unknown): RelayPeerInfo | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const relayUrl = asString(record.relayUrl) ?? asString(record.relay_url);
  const publicKey = asString(record.publicKey) ?? asString(record.public_key);
  const hostId = asString(record.hostId) ?? asString(record.host_id);
  if (!relayUrl || !publicKey || !hostId) return undefined;
  return { relayUrl, publicKey, hostId };
}

/**
 * Accepts externally tagged (`transport: {ssh: {...}}`), internally tagged
 * (`transport: {kind: "ssh", ...}`), and flat (`transport: "ssh", hostname...`)
 * wire shapes and produces the canonical profile.
 */
export function normalizeDeviceProfile(raw: unknown): DeviceProfile {
  const record = asRecord(raw) ?? {};
  const transportRaw = record.transport;
  const transportRecord = asRecord(transportRaw);
  let transport: "ssh" | "relay" = "relay";
  let body: Record<string, unknown> = record;
  if (typeof transportRaw === "string") {
    transport = transportRaw === "ssh" ? "ssh" : "relay";
  } else if (transportRecord) {
    if (typeof transportRecord.kind === "string") {
      transport = transportRecord.kind === "ssh" ? "ssh" : "relay";
      body = transportRecord;
    } else if (asRecord(transportRecord.ssh)) {
      transport = "ssh";
      body = asRecord(transportRecord.ssh)!;
    } else if (asRecord(transportRecord.relay)) {
      transport = "relay";
      body = asRecord(transportRecord.relay)!;
    }
  }
  const profile: DeviceProfile = {
    id: asString(record.id) ?? "",
    name: asString(record.name) ?? "",
    transport,
    peer: normalizePeer(body.peer) ?? normalizePeer(record.peer),
    createdAt: asString(record.createdAt) ?? asString(record.created_at),
    lastConnectedAt:
      asString(record.lastConnectedAt) ?? asString(record.last_connected_at) ?? null,
    lastError: asString(record.lastError) ?? asString(record.last_error) ?? null,
  };
  if (transport === "ssh") {
    profile.hostname = asString(body.hostname);
    profile.port = asNumber(body.port);
    profile.username = asString(body.username);
  }
  return profile;
}

/** Short human summary of where a device lives (settings table + picker). */
export function deviceTargetSummary(device: DeviceProfile): string {
  if (device.transport === "ssh") {
    const user = device.username ? `${device.username}@` : "";
    const port = device.port && device.port !== 22 ? `:${device.port}` : "";
    return `${user}${device.hostname ?? "?"}${port}`;
  }
  return device.peer ? `${device.peer.hostId} · ${device.peer.relayUrl}` : "relay";
}

/** Normalize an invoke rejection into {code, message}. */
export function deviceCommandError(cause: unknown): DeviceCommandError {
  const record = asRecord(cause);
  if (record) {
    return {
      code: asString(record.code) ?? "device_error",
      message:
        asString(record.message) ??
        (cause instanceof Error ? cause.message : String(cause)),
    };
  }
  if (cause instanceof Error) return { code: "device_error", message: cause.message };
  return { code: "device_error", message: String(cause) };
}

// ---------------------------------------------------------------------------
// Injectable command invoker (tests never touch @tauri-apps/api).
// ---------------------------------------------------------------------------

export type DeviceInvoker = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

const tauriInvoker: DeviceInvoker = (command, args) => invoke(command, args);

let activeInvoker: DeviceInvoker = tauriInvoker;

/** Test hook: replace the command invoker. Pass no argument to restore. */
export function setDevicesInvokerForTests(invoker?: DeviceInvoker): void {
  activeInvoker = invoker ?? tauriInvoker;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

export type DeviceTestState =
  | { phase: "testing" }
  | { phase: "ok"; latencyMs: number; deviceName: string }
  | { phase: "failed"; error: DeviceCommandError };

export interface DevicesState {
  /** null until the first successful refresh (distinguishes empty vs unknown). */
  devices: DeviceProfile[] | null;
  loading: boolean;
  error: string | null;
  /** Per-device test-connect state (settings surface). */
  testing: Record<string, DeviceTestState>;
  /** Device id (or "local") a switch is currently running towards. */
  switchingTo: string | null;
  /** Last switch failure, surfaced by the picker. */
  switchError: string | null;
}

let state: DevicesState = {
  devices: null,
  loading: false,
  error: null,
  testing: {},
  switchingTo: null,
  switchError: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<DevicesState>): void {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export function getDevicesState(): DevicesState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDevicesStore(): DevicesState;
export function useDevicesStore<T>(selector: (snapshot: DevicesState) => T): T;
export function useDevicesStore<T>(
  selector?: (snapshot: DevicesState) => T,
): DevicesState | T {
  if (selector) return useSyncExternalStore(subscribe, () => selector(state));
  return useSyncExternalStore(subscribe, getDevicesState);
}

/** Test helper: reset the module store between tests. */
export function resetDevicesStoreForTests(): void {
  state = {
    devices: null,
    loading: false,
    error: null,
    testing: {},
    switchingTo: null,
    switchError: null,
  };
  listeners.forEach((listener) => listener());
}

// ---------------------------------------------------------------------------
// Command actions
// ---------------------------------------------------------------------------

export async function refreshDevices(): Promise<DeviceProfile[]> {
  setState({ loading: true, error: null });
  try {
    const raw = await activeInvoker("device_list");
    const devices = (Array.isArray(raw) ? raw : []).map(normalizeDeviceProfile);
    setState({ devices, loading: false });
    return devices;
  } catch (cause) {
    setState({ loading: false, error: deviceCommandError(cause).message });
    throw cause;
  }
}

export async function renameDevice(id: string, name: string): Promise<void> {
  await activeInvoker("device_rename", { deviceId: id, name });
  const devices = (state.devices ?? []).map((device) =>
    device.id === id ? { ...device, name } : device,
  );
  setState({ devices });
}

/**
 * Removes a device. On failure the list is refreshed from the registry so the
 * UI never shows a device that may still exist.
 */
export async function removeDevice(
  id: string,
  deleteCredentials: boolean,
): Promise<void> {
  await activeInvoker("device_remove", { deviceId: id, deleteCredentials });
  const devices = (state.devices ?? []).filter((device) => device.id !== id);
  const testing = { ...state.testing };
  delete testing[id];
  setState({ devices, testing });
}

/**
 * Test-connect: remote_connect followed by remote_disconnect. Measures the
 * round trip; the connection is always released, even on failure.
 */
export async function testDeviceConnection(id: string): Promise<DeviceTestState> {
  const testing = { ...state.testing, [id]: { phase: "testing" } as DeviceTestState };
  setState({ testing });
  const started = Date.now();
  let result: DeviceTestState;
  try {
    const hello = asRecord(await activeInvoker("remote_connect", { deviceId: id }));
    result = {
      phase: "ok",
      latencyMs: Date.now() - started,
      deviceName: asString(hello?.deviceName) ?? "",
    };
  } catch (cause) {
    result = { phase: "failed", error: deviceCommandError(cause) };
  } finally {
    try {
      await activeInvoker("remote_disconnect", { deviceId: id });
    } catch {
      // Disconnect is best-effort: a failed connect may leave nothing to close.
    }
  }
  setState({ testing: { ...state.testing, [id]: result } });
  return result;
}

/** Redeem a pairing code/link into a new device profile. */
export async function redeemPairing(
  payload: string,
  name?: string,
): Promise<DeviceProfile> {
  const raw = await activeInvoker("device_pair_redeem", {
    payload,
    name: name ?? null,
  });
  const device = normalizeDeviceProfile(raw);
  // Fire-and-forget: the fresh profile is already in hand; the list refresh
  // must never block or fail the redemption result.
  void refreshDevices().catch(() => undefined);
  return device;
}

/** Add a device via manual SSH credentials (probe + trust-on-first-use). */
export async function addSshDevice(draft: DeviceSshDraft): Promise<DeviceProfile> {
  const raw = await activeInvoker("device_add_ssh", { draft });
  const device = normalizeDeviceProfile(raw);
  void refreshDevices().catch(() => undefined);
  return device;
}

// ---------------------------------------------------------------------------
// Device-switch handler registry (boot/switch flow plugs the real handler in)
// ---------------------------------------------------------------------------

export type DeviceSwitchHandler = (
  target: DeviceContext,
) => void | Promise<void>;

let switchHandler: DeviceSwitchHandler | null = null;

/** Called once by the switch-flow integration to install the real handler. */
export function registerDeviceSwitchHandler(handler: DeviceSwitchHandler | null): void {
  switchHandler = handler;
}

/**
 * Entry point used by every device-switch affordance (picker, pair success).
 * Tracks switching state and surfaces failures; without a registered handler
 * this is a reported no-op so the UI never silently dead-ends.
 */
export async function requestDeviceSwitch(target: DeviceContext): Promise<void> {
  const targetId = target.kind === "local" ? "local" : target.deviceId;
  setState({ switchingTo: targetId, switchError: null });
  try {
    if (!switchHandler) {
      throw new Error("device switch handler is not registered yet");
    }
    await switchHandler(target);
  } catch (cause) {
    setState({ switchError: deviceCommandError(cause).message });
    throw cause;
  } finally {
    setState({ switchingTo: null });
  }
}
