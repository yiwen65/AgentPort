// Stable Session identity across devices. Local Sessions keep the historical
// plain id so existing persisted layouts and storage stay byte-compatible;
// remote Sessions are namespaced `deviceId:sessionId` to keep equal ids on
// different devices independent in layouts, runtime, handles and selection.

import type { DeviceContext } from "./deviceContext";

export const LOCAL_DEVICE_KEY = "local";

/** Device namespace used by session keys. */
export function deviceKeyForContext(context: DeviceContext): string {
  return context.kind === "local" ? LOCAL_DEVICE_KEY : context.deviceId;
}

export function isLocalDeviceKey(deviceKey: string): boolean {
  return deviceKey === LOCAL_DEVICE_KEY;
}

export function sessionKeyFor(deviceKey: string, sessionId: string): string {
  return isLocalDeviceKey(deviceKey) ? sessionId : `${deviceKey}:${sessionId}`;
}

export interface ParsedSessionKey {
  deviceKey: string;
  sessionId: string;
}

/**
 * Split a layout/runtime key. Device and Session ids are generated from the
 * Crockford-ish alphabet plus underscores, so ':' is a safe separator. A key
 * without ':' is a local Session (legacy layouts included).
 */
export function parseSessionKey(key: string): ParsedSessionKey {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    return { deviceKey: LOCAL_DEVICE_KEY, sessionId: key };
  }
  return {
    deviceKey: key.slice(0, separator),
    sessionId: key.slice(separator + 1),
  };
}

export function isLocalSessionKey(key: string): boolean {
  return !key.includes(":");
}

/** The focused Session's stable key for the current active device. */
export function activeSessionKey(
  state: { activeDevice: DeviceContext; activeSessionId: string | null },
): string | null {
  if (!state.activeSessionId) return null;
  return sessionKeyFor(
    deviceKeyForContext(state.activeDevice),
    state.activeSessionId,
  );
}

/** Prefix every plain key in a persisted layout with a remote device id. */
export function namespaceSessionKeys<T>(value: T, deviceKey: string): T {
  if (isLocalDeviceKey(deviceKey)) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => namespaceSessionKeys(entry, deviceKey)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[name] =
        (name === "sessionId" || name === "focusedSessionId") &&
        typeof entry === "string"
          ? namespacePlainKey(entry, deviceKey)
          : namespaceSessionKeys(entry, deviceKey);
    }
    return out as T;
  }
  return value;
}

function namespacePlainKey(key: string, deviceKey: string): string {
  if (!key || key.includes(":")) return key;
  return `${deviceKey}:${key}`;
}
