// Device switching: change the workspace's active device without destroying
// other devices' connections or panes. Explicit connections are owned by
// deviceConnections; this module only boots the target workspace and transfers
// focus. Switching runs strictly serialized.
// New desktop code (desktop multi-device switching, cross-device workspace).

import { api, errorText } from "./api";
import { applyBootInfo } from "./bootApply";
import { clearCommitPreviewCache } from "./components/GitCommitHoverCard";
import { connectDevice } from "./deviceConnections";
import { seedActiveDeviceSnapshot } from "./deviceSessions";
import {
  ACTIVE_DEVICE_STORAGE_KEY,
  activeDeviceContext,
  deviceKey,
  LOCAL_DEVICE_CONTEXT,
  LOCAL_DEVICE_STORAGE_VALUE,
  type DeviceContext,
} from "./deviceContext";
import { resetGitCenterForDeviceChange } from "./gitCenter";
import { i18n } from "./i18n";
import { composeRemoteBoot } from "./remoteBoot";
import { remoteBackendFor } from "./remote/runtime";
import { startRemoteSync, stopRemoteSync } from "./remote/remoteSync";
import {
  findSession,
  flattenSessions,
  getState,
  invalidateProjectsSnapshotRequests,
  setState,
  toast,
} from "./store";
import { selectSession } from "./actions";
import { registerFocusSessionKeyHandler } from "./sessionFocusRegistry";
import { parseSessionKey } from "./sessionIdentity";
import type { BootInfo } from "./types";

const ACTIVE_SESSION_STORAGE_KEY = "agentport-active-session-id";

let switchChain: Promise<void> = Promise.resolve();
let switchGeneration = 0;

export interface SwitchDeviceOptions {
  /** Plain Session id on the target device to focus after boot. */
  focusSessionId?: string | null;
  /** Focus the target device's remembered (or first) Session after boot. */
  focusRecent?: boolean;
  /** Reconnect/reboot even when the target device is already active. */
  force?: boolean;
}

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
export function switchDevice(
  target: DeviceContext,
  options: SwitchDeviceOptions = {},
): Promise<void> {
  const run = switchChain.then(() => doSwitchDevice(target, options).then(() => undefined));
  switchChain = run.catch(() => undefined);
  return run;
}

/** Focus one stable Session key, switching devices first when necessary. */
export function focusSessionKey(
  key: string,
  options: { revealInSidebar?: boolean } = {},
): Promise<boolean> {
  const { deviceKey: targetKey, sessionId } = parseSessionKey(key);
  const active = getState().activeDevice;
  const activeKey = active.kind === "local" ? "local" : active.deviceId;
  if (targetKey === activeKey) {
    if (options.revealInSidebar === undefined) selectSession(sessionId);
    else selectSession(sessionId, options);
    return Promise.resolve(true);
  }
  const target: DeviceContext =
    targetKey === "local"
      ? LOCAL_DEVICE_CONTEXT
      : {
          kind: "remote",
          deviceId: targetKey,
          deviceName: targetKey,
          capabilities: [],
        };
  const run = switchChain.then(() =>
    doSwitchDevice(target, { focusSessionId: sessionId }),
  );
  switchChain = run.then(() => undefined).catch(() => undefined);
  return run;
}

/** User-initiated selector switch: focus the target's remembered Session. */
export function switchDeviceAndFocusRecent(target: DeviceContext): Promise<void> {
  return switchDevice(target, { focusRecent: true });
}

/**
 * Reconnect the currently active remote device after an unexpected transport
 * loss. Explicitly user-triggered (the device strip's Connect action), never
 * automatic. Reboots the workspace and restarts the remote sync engine.
 */
export function reconnectActiveDevice(): Promise<boolean> {
  const active = getState().activeDevice;
  if (active.kind !== "remote") return Promise.resolve(false);
  const focused = getState().activeSessionId;
  const run = switchChain.then(() =>
    doSwitchDevice(active, { force: true, focusSessionId: focused }),
  );
  switchChain = run.then(() => undefined).catch(() => undefined);
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

async function doSwitchDevice(
  target: DeviceContext,
  options: SwitchDeviceOptions,
): Promise<boolean> {
  // At cold startup the context already holds the persisted device for scoped
  // storage, but no device has been booted yet. It is not a live connection to
  // skip or tear down, and a failed restore must fall back to the local device.
  const initialized = getState().ready;
  const previous = initialized ? activeDeviceContext() : LOCAL_DEVICE_CONTEXT;
  if (initialized && sameDevice(previous, target) && !options.force) {
    applyRequestedFocus(options);
    return true;
  }
  const generation = ++switchGeneration;
  const stale = () => generation !== switchGeneration;
  setState({ deviceSwitching: true });
  try {
    if (initialized) switchTeardown();
    const { boot, context } = await connectAndBoot(target);
    await applyBootInfo(boot, {
      isCancelled: stale,
      activeDevice: context,
      // connectAndBoot already probed a remote target.
      skipBackgroundProbeRefresh: context.kind === "remote",
    });
    if (!stale()) {
      if (target.kind === "remote") startRemoteSync(target.deviceId);
      resetGitCenterForDeviceChange();
      clearCommitPreviewCache();
      applyRequestedFocus(options);
      setState({ deviceSwitching: false, deviceError: null });
    }
    return !stale();
  } catch (error) {
    const rolledBack = await rollbackTo(previous, stale);
    if (!stale()) {
      const detail = errorText(error);
      setState({ deviceSwitching: false, deviceError: detail });
      toast(
        i18n.t("shell:ui.activeDevices.switchFailed", { detail }),
        "error",
      );
    }
    return rolledBack && !stale();
  }
}

/**
 * Detach the OLD device's workspace polling only. Its transport and terminal
 * attachments stay alive: explicit connections are released exclusively by
 * the user (or app exit), never by switching the visible device.
 */
function switchTeardown(): void {
  // Stop remote polling/notification sync before the workspace changes.
  stopRemoteSync();
  // A tick that was already in flight must not replace the target device's
  // projects after its boot snapshot is applied.
  invalidateProjectsSnapshotRequests();
  // Keep the old device's panes resolvable as background panes. This must run
  // before the active context flips to the target device.
  seedActiveDeviceSnapshot();
  // Clear the plain focused id without touching remembered panes. Otherwise a
  // target device that reuses the same Session id could inherit the old
  // device's focus before applyRequestedFocus runs.
  setState({ activeSessionId: null });
}

function applyRequestedFocus(options: SwitchDeviceOptions) {
  if (options.focusSessionId) {
    if (findSession(getState().projects, options.focusSessionId)) {
      selectSession(options.focusSessionId, { revealInSidebar: false });
    }
    return;
  }
  if (!options.focusRecent) return;
  const state = getState();
  const remembered = readRememberedSessionId(state.activeDevice);
  const target =
    (remembered ? findSession(state.projects, remembered) : null) ??
    flattenSessions(state.projects)[0] ??
    null;
  if (target) {
    selectSession(target.id, { revealInSidebar: false });
  } else {
    setState({ activeSessionId: null });
  }
}

function readRememberedSessionId(target: DeviceContext): string | null {
  try {
    return window.localStorage.getItem(
      deviceKey(target, ACTIVE_SESSION_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

interface ConnectedBoot {
  boot: BootInfo;
  context: DeviceContext;
}

/**
 * Fetch the target device's boot while the old context stays active. The
 * active context flips in applyBootInfo immediately before its projects land,
 * so the workspace never mixes the new device with the old project tree.
 */
async function connectAndBoot(target: DeviceContext): Promise<ConnectedBoot> {
  if (target.kind === "local") {
    return { boot: await api.boot(), context: LOCAL_DEVICE_CONTEXT };
  }
  const hello = await connectDevice(target.deviceId);
  const backend = remoteBackendFor(target.deviceId);
  const context: DeviceContext = {
    kind: "remote",
    deviceId: target.deviceId,
    deviceName: hello.deviceName || target.deviceName,
    capabilities: hello.capabilities,
  };
  return { boot: await composeRemoteBoot(backend), context };
}

async function rollbackTo(
  previous: DeviceContext,
  stale: () => boolean,
): Promise<boolean> {
  try {
    setState({ activeSessionId: null });
    const { boot, context } = await connectAndBoot(previous);
    await applyBootInfo(boot, {
      isCancelled: stale,
      activeDevice: context,
      skipBackgroundProbeRefresh: context.kind === "remote",
    });
    if (!stale() && context.kind === "remote") {
      startRemoteSync(context.deviceId);
    }
    return true;
  } catch {
    // The previous device is gone too; the local device always exists.
    try {
      await applyBootInfo(await api.boot(), {
        isCancelled: stale,
        activeDevice: LOCAL_DEVICE_CONTEXT,
      });
      return true;
    } catch (fatal) {
      if (!stale()) setState({ ready: true, bootError: errorText(fatal) });
      return false;
    }
  }
}

registerFocusSessionKeyHandler((key) => {
  void focusSessionKey(key);
});

/** Test hook: reset the serialization chain and generation counter. */
export function resetDeviceSwitchForTests(): void {
  switchChain = Promise.resolve();
  switchGeneration = 0;
}
