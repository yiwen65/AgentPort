// Device switching: tear down the current device's UI/connection state, then
// connect and boot the target device. The app is never left device-less — any
// failure rolls back to the previous device, with the local device as the
// last resort. Switching runs strictly serialized.
// New desktop code (desktop multi-device switching).

import { api, errorText } from "./api";
import { applyBootInfo } from "./bootApply";
import {
  ACTIVE_DEVICE_STORAGE_KEY,
  activeDeviceContext,
  LOCAL_DEVICE_CONTEXT,
  LOCAL_DEVICE_STORAGE_VALUE,
  type DeviceContext,
} from "./deviceContext";
import { i18n } from "./i18n";
import { composeRemoteBoot } from "./remoteBoot";
import { dropRemoteBackend, remoteBackendFor } from "./remote/runtime";
import { startRemoteSync, stopRemoteSync } from "./remote/remoteSync";
import { getState, setActiveDevice, setState, toast } from "./store";
import { releaseTerminal } from "./terminals";
import type { BootInfo } from "./types";

let switchChain: Promise<void> = Promise.resolve();
let switchGeneration = 0;

function sameDevice(a: DeviceContext, b: DeviceContext): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "local" || (b.kind === "remote" && a.deviceId === b.deviceId);
}

/**
 * Switch the active device. Concurrent calls are serialized: a queued switch
 * starts only after the previous one settles. The returned promise always
 * resolves — failures are surfaced via AppState.deviceError plus a toast and
 * leave the app on the previous device.
 */
export function switchDevice(target: DeviceContext): Promise<void> {
  const run = switchChain.then(() => doSwitchDevice(target));
  switchChain = run.catch(() => undefined);
  return run;
}

/** The device to restore at startup from the persisted choice; null = local. */
export function startupRestoreTarget(): DeviceContext | null {
  try {
    const stored = window.localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY);
    if (stored && stored !== LOCAL_DEVICE_STORAGE_VALUE) {
      // The registry/UI resolves display names later; the id identifies the
      // device until the negotiated hello supplies its name.
      return {
        kind: "remote",
        deviceId: stored,
        deviceName: stored,
        capabilities: [],
      };
    }
  } catch {
    // Storage unavailable: stay local.
  }
  return null;
}

async function doSwitchDevice(target: DeviceContext): Promise<void> {
  const previous = activeDeviceContext();
  if (sameDevice(previous, target)) return;
  const generation = ++switchGeneration;
  const stale = () => generation !== switchGeneration;
  setState({ deviceSwitching: true });
  try {
    await switchTeardown(previous);
    const boot = await connectAndBoot(target);
    await applyBootInfo(boot, {
      isCancelled: stale,
      // connectAndBoot already probed a remote target.
      skipBackgroundProbeRefresh: target.kind === "remote",
    });
    if (!stale()) {
      if (target.kind === "remote") startRemoteSync(target.deviceId);
      setState({ deviceSwitching: false, deviceError: null });
    }
  } catch (error) {
    await rollbackTo(previous, stale);
    if (!stale()) {
      const detail = errorText(error);
      setState({ deviceSwitching: false, deviceError: detail });
      toast(
        i18n.t("device:switch.failed", {
          detail,
          defaultValue: "设备切换失败：{{detail}}",
        }),
        "error",
      );
    }
  }
}

/**
 * Detach every attached terminal (detach calls still route to the OLD device
 * because the context flips only in connectAndBoot), then drop the old remote
 * connection. The remote Sessions keep running on their device.
 */
async function switchTeardown(previous: DeviceContext): Promise<void> {
  // Stop remote polling/notification sync before any detach or disconnect.
  stopRemoteSync();
  // Unmount terminal panes first so components never touch a disposed handle.
  setState({ activeSessionId: null });
  const attached = [...getState().attachedIds];
  await Promise.all(
    attached.map((sessionId) =>
      releaseTerminal(sessionId).catch(() => undefined),
    ),
  );
  if (previous.kind === "remote") {
    const backend = remoteBackendFor(previous.deviceId);
    await backend.client.disconnect().catch(() => undefined);
    // A fresh backend on return guarantees no stale attachment ids survive.
    dropRemoteBackend(previous.deviceId);
  }
}

async function connectAndBoot(target: DeviceContext): Promise<BootInfo> {
  if (target.kind === "local") {
    setActiveDevice(LOCAL_DEVICE_CONTEXT);
    return api.boot();
  }
  const backend = remoteBackendFor(target.deviceId);
  const hello = await backend.client.connect();
  setActiveDevice({
    kind: "remote",
    deviceId: target.deviceId,
    deviceName: hello.deviceName || target.deviceName,
    capabilities: hello.capabilities,
  });
  return composeRemoteBoot(backend);
}

async function rollbackTo(
  previous: DeviceContext,
  stale: () => boolean,
): Promise<void> {
  try {
    const boot = await connectAndBoot(previous);
    await applyBootInfo(boot, {
      isCancelled: stale,
      skipBackgroundProbeRefresh: previous.kind === "remote",
    });
    if (!stale() && previous.kind === "remote") {
      startRemoteSync(previous.deviceId);
    }
  } catch {
    // The previous device is gone too; the local device always exists.
    setActiveDevice(LOCAL_DEVICE_CONTEXT);
    try {
      await applyBootInfo(await api.boot(), { isCancelled: stale });
    } catch (fatal) {
      if (!stale()) setState({ ready: true, bootError: errorText(fatal) });
    }
  }
}

/** Test hook: reset the serialization chain and generation counter. */
export function resetDeviceSwitchForTests(): void {
  switchChain = Promise.resolve();
  switchGeneration = 0;
}
