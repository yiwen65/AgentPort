// Remote boot composition: build the BootInfo the desktop UI expects from a
// connected remote device. Local-only slices (settings, platform, webview,
// exportsDir) always come from THIS Mac — settings are local by product
// decision; data slices (adapters, projects, timeline, secrets) come from the
// remote device.
// New desktop code (desktop multi-device switching).

import { api, errorText } from "./api";
import { cachedRemoteAdapters } from "./remoteAdapterCache";
import type { RemoteBackend } from "./remote/backend";
import type {
  AdapterInstall,
  BootInfo,
  PlatformInfo,
  TimelineData,
} from "./types";

export interface LocalBootBase {
  platform: PlatformInfo;
  webview: string;
  exportsDir: string;
  adapters: AdapterInstall[];
}

let localBase: LocalBootBase | null = null;

/**
 * Cache the local-only boot slices. Called on every successful LOCAL boot;
 * the first value wins for platform/webview, while exportsDir tracks the
 * latest local boot.
 */
export function cacheLocalBootBase(info: BootInfo): void {
  localBase = {
    platform: info.platform,
    webview: info.webview,
    exportsDir: info.exportsDir,
    adapters: info.adapters,
  };
}

function emptyTimeline(): TimelineData {
  return { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] };
}

/**
 * Remote adapter discovery is a slow, server-blocking probe (several seconds
 * on hosts that check every agent sequentially). A switch must not wait for
 * it; reuse the last successful result for this device, or leave the list
 * empty until the Host cache fills it. Never borrow another device's list.
 * Explicit rechecks refresh the cache through RemoteBackend.probeAgents.
 */
/** Adapter list from the most recent local boot, used to paint local
 * switches immediately before the background boot refreshes it. */
export function cachedLocalAdapters(): AdapterInstall[] {
  return localBase?.adapters ?? [];
}

export interface ComposeRemoteBootOptions {
  deviceId?: string;
}

/**
 * Compose a BootInfo for a connected remote device. The server-side reconcile
 * (backend.boot) runs first, mirroring the local boot's startup reconcile.
 * Optional slices degrade exactly like the local boot: a timeline failure
 * yields an empty timeline plus timelineError instead of failing the boot.
 */
export async function composeRemoteBoot(
  backend: RemoteBackend,
  options: ComposeRemoteBootOptions = {},
): Promise<BootInfo> {
  if (!localBase) {
    throw new Error(
      "composeRemoteBoot requires a prior local boot (cacheLocalBootBase)",
    );
  }
  await backend.boot();
  const [settings, projects, timeline, secretBackend] = await Promise.all([
    // Settings are ALWAYS local (device switching never restyles the UI).
    api.getSettings(),
    backend.listProjects(null),
    backend
      .getTimeline()
      .then((data) => ({ data, error: null as string | null }))
      .catch((error: unknown) => ({
        data: emptyTimeline(),
        error: errorText(error),
      })),
    backend.secretStatus(),
  ]);
  const adapters = options.deviceId
    ? cachedRemoteAdapters(options.deviceId) ?? []
    : localBase.adapters;
  return {
    platform: localBase.platform,
    settings,
    adapters,
    projects,
    timeline: timeline.data,
    timelineError: timeline.error,
    timelineMessage: null,
    secretBackend,
    // The remote search index is queried on demand by the bridge; the local
    // purge-state distinction does not cross devices.
    indexState: "native_on_demand",
    webview: localBase.webview,
    exportsDir: localBase.exportsDir,
  };
}

/** Test hook: drop the cached local base. */
export function resetLocalBootBaseForTests(): void {
  localBase = null;
}
