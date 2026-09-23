// Topbar device picker: shows which device this window is pointed at and
// switches between the local Mac and paired remote PCs. The actual switch is
// delegated to a single injectable handler (default: devicesStore's
// requestDeviceSwitch) so the boot/switch flow integrates in one line.
// New desktop code (desktop multi-device switching).

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openDialog, useStore } from "../store";
import type { DeviceContext } from "../deviceContext";
import {
  deviceTargetSummary,
  refreshDevices,
  requestDeviceSwitch,
  useDevicesStore,
  type DeviceProfile,
  type DeviceSwitchHandler,
} from "../devicesStore";
import PairDevice from "./PairDevice";
import "./devices.css";

function IconDevices() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect
        x="2.5"
        y="3.5"
        width="15"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M7 16.5h6M10 13.5v3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconChevronSmall() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.75 5 6.25l2.5-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function contextForDevice(device: DeviceProfile): DeviceContext {
  return {
    kind: "remote",
    deviceId: device.id,
    deviceName: device.name,
    capabilities: [],
  };
}

export default function DevicePicker(props: {
  onSwitchDevice?: DeviceSwitchHandler;
}) {
  const { t } = useTranslation(["shell", "common"]);
  const onSwitchDevice = props.onSwitchDevice ?? requestDeviceSwitch;
  const activeDevice = useStore((state) => state.activeDevice);
  const devices = useDevicesStore((state) => state.devices);
  const switchingTo = useDevicesStore((state) => state.switchingTo);
  const switchError = useDevicesStore((state) => state.switchError);
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pending, setPending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Refresh the device list every time the menu opens (cheap command, keeps
  // rename/remove from other surfaces in sync); never on closed render.
  useEffect(() => {
    if (open) void refreshDevices().catch(() => undefined);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const activeName =
    activeDevice.kind === "remote"
      ? activeDevice.deviceName
      : t("shell:ui.topBar.devices.local");
  const switching = switchingTo !== null || pending;

  // The menu stays open while a switch runs: on success it closes, on failure
  // it remains so the error (devicesStore.switchError) stays visible.
  const switchTo = (target: DeviceContext) => {
    setPending(true);
    void Promise.resolve(onSwitchDevice(target))
      .then(() => setOpen(false))
      .catch(() => setOpen(true))
      .finally(() => setPending(false));
  };

  const deviceRow = (device: DeviceProfile) => {
    const isActive =
      activeDevice.kind === "remote" && activeDevice.deviceId === device.id;
    const dotClass = switchingTo === device.id
      ? "device-dot switching"
      : device.lastError
        ? "device-dot error"
        : device.lastConnectedAt
          ? "device-dot ok"
          : "device-dot";
    return (
      <button
        key={device.id}
        className="device-picker-row"
        role="menuitemradio"
        aria-checked={isActive}
        disabled={switching || isActive}
        onClick={() => switchTo(contextForDevice(device))}
        data-tip={device.lastError ?? undefined}
      >
        <span className={dotClass} aria-hidden="true" />
        <span className="device-picker-row-label">
          {device.name}
          <span className="device-picker-row-target">
            {deviceTargetSummary(device)}
          </span>
        </span>
        <span className="device-badge">{device.transport}</span>
        <span className="device-picker-check" aria-hidden="true">
          {isActive ? "✓" : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="device-picker" ref={rootRef}>
      <button
        className="device-picker-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("shell:ui.topBar.devices.label")}
        data-tip={t("shell:ui.topBar.devices.tip")}
        disabled={switching}
        onClick={() => setOpen((value) => !value)}
        data-tauri-drag-region="false"
      >
        <IconDevices />
        <span className="device-picker-name">
          {switching
            ? t("shell:ui.topBar.devices.switching")
            : activeName}
        </span>
        <IconChevronSmall />
      </button>
      {open ? (
        <div className="device-picker-menu" role="menu" aria-label={t("shell:ui.topBar.devices.label")}>
          <button
            className="device-picker-row"
            role="menuitemradio"
            aria-checked={activeDevice.kind === "local"}
            disabled={switching || activeDevice.kind === "local"}
            onClick={() => switchTo({ kind: "local" })}
          >
            <span
              className={
                switchingTo === "local" ? "device-dot switching" : "device-dot ok"
              }
              aria-hidden="true"
            />
            <span className="device-picker-row-label">
              {t("shell:ui.topBar.devices.local")}
              <span className="device-picker-row-target">
                {t("shell:ui.topBar.devices.localTarget")}
              </span>
            </span>
            <span className="device-picker-check" aria-hidden="true">
              {activeDevice.kind === "local" ? "✓" : ""}
            </span>
          </button>
          {(devices ?? []).map(deviceRow)}
          {devices !== null && devices.length === 0 ? (
            <div className="device-picker-row" role="presentation">
              <span className="device-picker-row-label device-picker-row-target">
                {t("shell:ui.topBar.devices.empty")}
              </span>
            </div>
          ) : null}
          <div className="device-picker-separator" />
          <div className="device-picker-footer">
            <button
              className="device-picker-row"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setPairing(true);
              }}
            >
              {t("shell:ui.topBar.devices.add")}
            </button>
            <button
              className="device-picker-row"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                openDialog({ kind: "settings" });
              }}
            >
              {t("shell:ui.topBar.devices.manage")}
            </button>
          </div>
          {switchError ? (
            <div className="device-picker-error" role="alert">
              {t("shell:ui.topBar.devices.switchFailed", { detail: switchError })}
            </div>
          ) : null}
        </div>
      ) : null}
      {pairing ? (
        <PairDevice
          onClose={() => setPairing(false)}
          onSwitchDevice={onSwitchDevice}
        />
      ) : null}
    </div>
  );
}
