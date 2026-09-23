// Settings section managing paired remote PCs: list, test-connect, rename,
// delete (with credential cascade), and the entry point to PairDevice.
// New desktop code (desktop multi-device switching).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceContext } from "../deviceContext";
import {
  deviceTargetSummary,
  refreshDevices,
  removeDevice,
  renameDevice,
  requestDeviceSwitch,
  testDeviceConnection,
  useDevicesStore,
  type DeviceProfile,
  type DeviceSwitchHandler,
} from "../devicesStore";
import PairDevice from "./PairDevice";
import "./devices.css";

function formatConnectedAt(
  value: string | null | undefined,
  locale: string,
): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DeviceSettings(props: {
  onSwitchDevice?: DeviceSwitchHandler;
}) {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const onSwitchDevice = props.onSwitchDevice ?? requestDeviceSwitch;
  const devices = useDevicesStore((state) => state.devices);
  const loading = useDevicesStore((state) => state.loading);
  const loadError = useDevicesStore((state) => state.error);
  const testing = useDevicesStore((state) => state.testing);
  const [pairing, setPairing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<DeviceProfile | null>(null);
  const [deleteCredentials, setDeleteCredentials] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void refreshDevices().catch(() => undefined);
  }, []);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirmRename = () =>
    run(async () => {
      if (!renaming) return;
      const name = renaming.name.trim();
      if (!name) return;
      await renameDevice(renaming.id, name);
      setRenaming(null);
    });

  const confirmRemove = () =>
    run(async () => {
      if (!removing) return;
      await removeDevice(removing.id, deleteCredentials);
      setRemoving(null);
    });

  const testRow = (device: DeviceProfile) => {
    const result = testing[device.id];
    if (!result) return null;
    if (result.phase === "testing") {
      return <span className="dim">{t("settings:ui.devices.testing")}</span>;
    }
    if (result.phase === "ok") {
      return (
        <span>
          {t("settings:ui.devices.testOk", { latency: result.latencyMs })}
        </span>
      );
    }
    return (
      <span className="device-error-cell" data-tip={result.error.message}>
        {t("settings:ui.devices.testFailed", {
          detail: result.error.message,
        })}
      </span>
    );
  };

  return (
    <section className="devices-section" aria-labelledby="devices-heading">
      <div className="settings-section-heading">
        <div className="section-title" id="devices-heading">
          {t("settings:ui.sections.devices")}
        </div>
      </div>
      <p>{t("settings:ui.devices.description")}</p>
      <div className="devices-actions">
        <button
          className="btn primary"
          disabled={busy}
          onClick={() => setPairing(true)}
        >
          {t("settings:ui.devices.add")}
        </button>
        <button
          className="btn"
          disabled={busy || loading}
          onClick={() => void refreshDevices().catch(() => undefined)}
        >
          {t("common:actions.refresh")}
        </button>
      </div>
      {loadError ? (
        <p className="pair-device-error" role="alert">
          {loadError}
        </p>
      ) : null}
      {actionError ? (
        <p className="pair-device-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <table className="table devices-table" aria-label={t("settings:ui.devices.tableAriaLabel")}>
        <thead>
          <tr>
            <th>{t("settings:ui.devices.columns.name")}</th>
            <th>{t("settings:ui.devices.columns.transport")}</th>
            <th>{t("settings:ui.devices.columns.target")}</th>
            <th>{t("settings:ui.devices.columns.lastConnected")}</th>
            <th>{t("settings:ui.devices.columns.status")}</th>
            <th aria-label={t("settings:ui.columns.actions")} />
          </tr>
        </thead>
        <tbody>
          {(devices ?? []).map((device) => (
            <tr key={device.id}>
              <td>
                {renaming?.id === device.id ? (
                  <span className="device-rename-row">
                    <input
                      aria-label={t("settings:ui.devices.renameAriaLabel")}
                      maxLength={80}
                      value={renaming.name}
                      disabled={busy}
                      onChange={(event) =>
                        setRenaming({ id: device.id, name: event.target.value })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void confirmRename();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                    <button
                      className="btn small primary"
                      disabled={busy || !renaming.name.trim()}
                      onClick={() => void confirmRename()}
                    >
                      {t("common:actions.save")}
                    </button>
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() => setRenaming(null)}
                    >
                      {t("common:actions.cancel")}
                    </button>
                  </span>
                ) : (
                  device.name
                )}
              </td>
              <td>
                <span className="device-badge">{device.transport}</span>
              </td>
              <td className="mono dim">{deviceTargetSummary(device)}</td>
              <td className="dim">
                {formatConnectedAt(device.lastConnectedAt, i18n.language)}
              </td>
              <td>
                {device.lastError ? (
                  <span className="device-error-cell" data-tip={device.lastError}>
                    {t("settings:ui.devices.lastError")}
                  </span>
                ) : (
                  testRow(device) ?? <span className="dim">—</span>
                )}
              </td>
              <td>
                <span className="device-actions-cell">
                  <button
                    className="btn small"
                    disabled={busy || testing[device.id]?.phase === "testing"}
                    onClick={() => void testDeviceConnection(device.id)}
                  >
                    {t("settings:ui.devices.testConnect")}
                  </button>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => setRenaming({ id: device.id, name: device.name })}
                  >
                    {t("common:actions.rename")}
                  </button>
                  <button
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => {
                      setRemoving(device);
                      setDeleteCredentials(true);
                    }}
                  >
                    {t("common:actions.delete")}
                  </button>
                </span>
              </td>
            </tr>
          ))}
          {devices !== null && devices.length === 0 ? (
            <tr>
              <td colSpan={6} className="dim">
                {t("settings:ui.devices.empty")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {removing ? (
        <div className="device-confirm" role="alert">
          <p>
            {t("settings:ui.devices.removeConfirm", { name: removing.name })}
          </p>
          <div className="device-confirm-buttons">
            <button className="btn" disabled={busy} onClick={() => setRemoving(null)}>
              {t("common:actions.cancel")}
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={() => void confirmRemove()}
            >
              {t("common:actions.delete")}
            </button>
            <label>
              <input
                type="checkbox"
                checked={deleteCredentials}
                disabled={busy}
                onChange={(event) => setDeleteCredentials(event.target.checked)}
              />
              {t("settings:ui.devices.removeCredentials")}
            </label>
          </div>
        </div>
      ) : null}
      {pairing ? (
        <PairDevice
          onClose={() => setPairing(false)}
          onSwitchDevice={(target: DeviceContext) => onSwitchDevice(target)}
        />
      ) : null}
    </section>
  );
}
