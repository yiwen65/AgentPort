// Active-device context: the single synchronous source for "which device does
// this UI/api call target". This is a leaf module — it must never import from
// api.ts/store.ts/paneLayout.ts/terminals.ts so every one of them can depend
// on it without cycles. New desktop code (desktop multi-device switching).

export type DeviceContext =
  | { kind: "local" }
  | {
      kind: "remote";
      deviceId: string;
      deviceName: string;
      /** Negotiated protocol capabilities; empty until the first connect. */
      capabilities: string[];
    };

export const LOCAL_DEVICE_CONTEXT: DeviceContext = { kind: "local" };

/** Persistence key for the active device id; the sentinel means the local Mac. */
export const ACTIVE_DEVICE_STORAGE_KEY = "agentport-active-device-id";
export const LOCAL_DEVICE_STORAGE_VALUE = "local";

/**
 * Prefix for every per-device LocalStorage/SessionStorage key. A remote
 * device's key is `agentport:device:<deviceId>:` + the full legacy local key,
 * so local keys stay byte-identical and device namespaces never collide.
 */
export const DEVICE_STORAGE_PREFIX = "agentport:device:";

export function isRemote(context: DeviceContext): boolean {
  return context.kind === "remote";
}

/** deviceKey under an explicit context (pure; preferred for tests). */
export function deviceKey(context: DeviceContext, baseKey: string): string {
  return context.kind === "local"
    ? baseKey
    : `${DEVICE_STORAGE_PREFIX}${context.deviceId}:${baseKey}`;
}

export function deviceStoragePrefix(context: DeviceContext): string {
  return context.kind === "local" ? "" : `${DEVICE_STORAGE_PREFIX}${context.deviceId}:`;
}

/** True for any key inside a device namespace (never a plain local key). */
export function isDeviceScopedStorageKey(key: string): boolean {
  return key.startsWith(DEVICE_STORAGE_PREFIX);
}

function readInitialDeviceContext(): DeviceContext {
  try {
    const stored = window.localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY);
    if (stored && stored !== LOCAL_DEVICE_STORAGE_VALUE) {
      // Only the id is persisted; name/capabilities are hydrated by
      // setActiveDevice once the device registry/boot flow (T-006) runs.
      return {
        kind: "remote",
        deviceId: stored,
        deviceName: stored,
        capabilities: [],
      };
    }
  } catch {
    // Storage can be unavailable; the local device is always the fallback.
  }
  return LOCAL_DEVICE_CONTEXT;
}

let current: DeviceContext = readInitialDeviceContext();

/**
 * The current synchronous context. Read at CALL TIME (never cache it in a
 * module constant) so storage keys and api routing follow a device switch.
 */
export function activeDeviceContext(): DeviceContext {
  return current;
}

/** deviceKey under the current context — the call-site helper. */
export function scopedStorageKey(baseKey: string): string {
  return deviceKey(current, baseKey);
}

/** Swap the active context and persist the choice (survives restarts). */
export function setDeviceContext(context: DeviceContext): void {
  current = context;
  try {
    window.localStorage.setItem(
      ACTIVE_DEVICE_STORAGE_KEY,
      context.kind === "local" ? LOCAL_DEVICE_STORAGE_VALUE : context.deviceId,
    );
  } catch {
    // Selection remains usable for the session when storage is unavailable.
  }
}

/** Test hook: restore the local context without a persisted value. */
export function resetDeviceContextForTests(): void {
  current = LOCAL_DEVICE_CONTEXT;
}
