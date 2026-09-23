// Remote boot composition: build the BootInfo the desktop UI expects from a
// connected remote device. Local-only slices (settings, platform, webview,
// exportsDir) always come from THIS Mac — settings are local by product
// decision; data slices (adapters, projects, timeline, secrets) come from the
// remote device.
// New desktop code (desktop multi-device switching).

import { api, errorText } from "./api";
import type { RemoteBackend } from "./remote/backend";
import type { BootInfo, PlatformInfo, TimelineData } from "./types";

export interface LocalBootBase {
  platform: PlatformInfo;
  webview: string;
  exportsDir: string;
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
  };
}

function emptyTimeline(): TimelineData {
  return { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] };
}

/**
 * Compose a BootInfo for a connected remote device. The server-side reconcile
 * (backend.boot) runs first, mirroring the local boot's startup reconcile.
 * Optional slices degrade exactly like the local boot: a timeline failure
 * yields an empty timeline plus timelineError instead of failing the boot.
 */
export async function composeRemoteBoot(
  backend: RemoteBackend,
): Promise<BootInfo> {
  if (!localBase) {
    throw new Error(
      "composeRemoteBoot requires a prior local boot (cacheLocalBootBase)",
    );
  }
  await backend.boot();
  const [settings, adapters, projects, timeline, secretBackend] =
    await Promise.all([
      // Settings are ALWAYS local (device switching never restyles the UI).
      api.getSettings(),
      // A live probe is the only remote source of AdapterInstalls; it runs
      // with preserveSelections so explicit remote path choices survive.
      backend
        .probeAgents(true)
        .then((outcomes) =>
          outcomes.flatMap((outcome) =>
            outcome.install ? [outcome.install] : [],
          ),
        ),
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
