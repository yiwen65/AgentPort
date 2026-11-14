// Explicitly close a device's panes and release its transport. This is the
// only path that removes another device's layout leaves; ordinary workspace
// switching preserves them.

import { errorText } from "./api";
import { disconnectDevice, forgetDeviceConnection } from "./deviceConnections";
import { dropDeviceSnapshot } from "./deviceSessions";
import { switchDevice } from "./deviceSwitch";
import { LOCAL_DEVICE_CONTEXT } from "./deviceContext";
import { getDevicesState } from "./devicesStore";
import { i18n } from "./i18n";
import {
  orderedLayoutSessionIds,
  paneLayoutHasSplit,
  persistTerminalLayouts,
  prunePaneLayout,
  sanitizePaneLayouts,
} from "./paneLayout";
import { deviceKeyForContext, parseSessionKey } from "./sessionIdentity";
import { confirmDialog, getState, setState, toast } from "./store";
import { releaseTerminalAsync } from "./terminalRuntime";

function layoutKeys(state = getState()): string[] {
  const keys = new Set<string>(orderedLayoutSessionIds(state.terminalLayout));
  for (const group of state.terminalLayoutGroups) {
    for (const key of orderedLayoutSessionIds(group)) keys.add(key);
  }
  return [...keys];
}

export function paneKeysForDevice(deviceId: string): string[] {
  return layoutKeys().filter(
    (key) => parseSessionKey(key).deviceKey === deviceId,
  );
}

function deviceNameFor(deviceId: string): string {
  const active = getState().activeDevice;
  if (active.kind === "remote" && active.deviceId === deviceId) {
    return active.deviceName;
  }
  return (
    getDevicesState().devices?.find((device) => device.id === deviceId)?.name ??
    deviceId
  );
}

/**
 * Disconnect one remote device. Panes are closed only after the user confirms
 * (unless this is a device-removal cascade). An active device first returns
 * the workspace to THIS computer so no focused Session is lost mid-teardown.
 */
export async function disconnectDeviceFlow(
  deviceId: string,
  options: { skipConfirm?: boolean; forget?: boolean } = {},
): Promise<boolean> {
  if (deviceId === "local") return false;
  const keys = paneKeysForDevice(deviceId);
  if (keys.length > 0 && !options.skipConfirm) {
    const deviceName = deviceNameFor(deviceId);
    const ok = await confirmDialog({
      title: i18n.t("shell:ui.activeDevices.disconnectTitle", {
        device: deviceName,
        defaultValue: "Disconnect {{device}}?",
      }),
      body: i18n.t("shell:ui.activeDevices.disconnectBody", {
        count: keys.length,
        device: deviceName,
        defaultValue:
          "This closes {{count}} terminal pane(s) on {{device}}.",
      }),
      confirmLabel: i18n.t("shell:ui.activeDevices.disconnect", {
        defaultValue: "Disconnect",
      }),
      danger: true,
    });
    if (!ok) return false;
  }

  if (deviceKeyForContext(getState().activeDevice) === deviceId) {
    await switchDevice(LOCAL_DEVICE_CONTEXT);
    if (deviceKeyForContext(getState().activeDevice) === deviceId) {
      toast(
        i18n.t("shell:ui.activeDevices.disconnectFailed", {
          device: deviceNameFor(deviceId),
          detail: i18n.t("shell:ui.activeDevices.switchBackFailed", {
            defaultValue: "could not return to This computer",
          }),
        }),
        "error",
      );
      return false;
    }
  }

  const state = getState();
  const remaining = new Set(
    layoutKeys(state).filter(
      (key) => parseSessionKey(key).deviceKey !== deviceId,
    ),
  );
  const terminalLayout = prunePaneLayout(state.terminalLayout, remaining);
  const terminalLayoutGroups = sanitizePaneLayouts(
    state.terminalLayoutGroups,
    remaining,
  ).filter(paneLayoutHasSplit);
  const owned = (key: string) => parseSessionKey(key).deviceKey === deviceId;
  const runtime = Object.fromEntries(
    Object.entries(state.runtime).filter(([key]) => !owned(key)),
  );
  const attachedIds = state.attachedIds.filter((key) => !owned(key));
  const archivingSessionIds = state.archivingSessionIds.filter(
    (key) => !owned(key),
  );
  const maximizedSessionId =
    state.maximizedSessionId && owned(state.maximizedSessionId)
      ? null
      : state.maximizedSessionId;
  setState({
    terminalLayout,
    terminalLayoutGroups,
    attachedIds,
    runtime,
    archivingSessionIds,
    maximizedSessionId,
  });
  persistTerminalLayouts(
    terminalLayoutGroups,
    terminalLayoutGroups[0] ?? terminalLayout,
  );
  await Promise.allSettled(keys.map((key) => releaseTerminalAsync(key)));
  dropDeviceSnapshot(deviceId);
  try {
    if (options.forget) forgetDeviceConnection(deviceId);
    else await disconnectDevice(deviceId);
    return true;
  } catch (cause) {
    toast(
      i18n.t("shell:ui.activeDevices.disconnectFailed", {
        device: deviceNameFor(deviceId),
        detail: errorText(cause),
      }),
      "error",
    );
    return false;
  }
}
