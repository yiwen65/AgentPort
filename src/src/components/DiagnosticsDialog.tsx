// Diagnostics center (PRD 2 / 3.6): host list, CLI capabilities, copyable
// summary, redacted diagnostics ZIP export, notification test.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText } from "../api";
import { copyTextWithToast } from "../actions";
import { formatBytes } from "../format";
import { closeDialog, getState, toast, useStore } from "../store";
import type { HostInfo } from "../types";

export default function DiagnosticsDialog() {
  const { t } = useTranslation(["runtime", "common"]);
  const s = useStore();
  const [hosts, setHosts] = useState<HostInfo[]>([]);
  const [caps, setCaps] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zipSession, setZipSession] = useState(s.activeSessionId ?? "");
  const [zipDest, setZipDest] = useState(
    `${getState().exportsDir || "/tmp"}/agentport-diagnostics.zip`,
  );
  const [zipResult, setZipResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sessions = s.projects.flatMap((p) => p.sessions);
  const lifecycleLabel = (lifecycle: string) => {
    switch (lifecycle) {
      case "creating":
        return t("runtime:diagnostics.lifecycleValue.creating");
      case "running":
        return t("runtime:diagnostics.lifecycleValue.running");
      case "interrupted":
        return t("runtime:diagnostics.lifecycleValue.interrupted");
      case "exited":
        return t("runtime:diagnostics.lifecycleValue.exited");
      case "stopped":
        return t("runtime:diagnostics.lifecycleValue.stopped");
      default:
        return lifecycle;
    }
  };

  const reload = async () => {
    setError(null);
    try {
      setHosts(await api.diagHosts());
    } catch (e) {
      setError(t("runtime:diagnostics.hostListFailed", { detail: errorText(e) }));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const copySummary = async () => {
    try {
      const text = await api.diagSummary();
      await copyTextWithToast(text, t("runtime:diagnostics.summaryCopied"));
    } catch (e) {
      toast(t("runtime:diagnostics.copySummaryFailed", { detail: errorText(e) }), "error");
    }
  };

  const showCaps = async () => {
    try {
      const raw = await api.diagCapabilities();
      try {
        setCaps(JSON.stringify(JSON.parse(raw), null, 2));
      } catch {
        setCaps(raw);
      }
    } catch (e) {
      toast(t("runtime:diagnostics.capabilitiesFailed", { detail: errorText(e) }), "error");
    }
  };

  const exportZip = async () => {
    const sid = zipSession || sessions[0]?.id;
    if (!sid) {
      toast(t("runtime:diagnostics.noSessionToExport"), "error");
      return;
    }
    setBusy(true);
    setZipResult(null);
    try {
      const p = await api.exportSession({
        sessionId: sid,
        kind: "zip",
        dest: zipDest.trim(),
        last: null,
        stripAnsi: false,
      });
      setZipResult(p);
      toast(t("runtime:diagnostics.exported"), "success");
    } catch (e) {
      toast(t("runtime:diagnostics.exportFailed", { detail: errorText(e) }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("runtime:diagnostics.title")} onClose={closeDialog} wide>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}

      <div className="section-title">
        {t("runtime:diagnostics.hosts")}
        <button className="btn small ghost" style={{ float: "right" }} onClick={() => void reload()}>
          {t("common:actions.refresh")}
        </button>
      </div>
      {hosts.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          {t("runtime:diagnostics.noHosts")}
        </p>
      ) : (
        <table className="table" aria-label={t("runtime:diagnostics.hosts")}>
          <thead>
            <tr>
              <th>Session</th>
              <th>PID</th>
              <th>{t("runtime:diagnostics.online")}</th>
              <th>{t("runtime:diagnostics.lifecycle")}</th>
              <th>{t("runtime:diagnostics.log")}</th>
              <th>Socket</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.sessionId}>
                <td>{h.title}</td>
                <td className="mono">{h.hostPid ?? "—"}</td>
                <td>
                  <span className={`status-light ${h.alive ? "on" : "off"}`} aria-hidden="true" />{" "}
                  {h.alive ? t("runtime:diagnostics.online") : t("runtime:diagnostics.offline")}
                </td>
                <td>{lifecycleLabel(h.lifecycle)}</td>
                <td>{formatBytes(h.logBytes)}</td>
                <td className="mono dim" style={{ wordBreak: "break-all", maxWidth: 200 }}>
                  {h.socketPath ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">{t("runtime:diagnostics.actions")}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void copySummary()}>
          {t("runtime:diagnostics.copySummary")}
        </button>
        <button className="btn" onClick={() => void showCaps()}>
          {t("runtime:diagnostics.showCapabilities")}
        </button>
        <button
          className="btn"
          disabled={!s.settings?.notificationsEnabled}
          data-tip={s.settings?.notificationsEnabled
            ? undefined
            : t("runtime:diagnostics.notificationDisabled")}
          onClick={() =>
            void api
              .notifyTest()
              .then(() => toast(t("runtime:diagnostics.testSent"), "success"))
              .catch((e) =>
                toast(t("runtime:diagnostics.notificationFailed", { detail: errorText(e) }), "error"),
              )
          }
        >
          {t("runtime:diagnostics.testNotification")}
        </button>
      </div>
      {caps !== null ? (
        <pre
          className="mono selectable"
          style={{
            margin: 0,
            padding: 10,
            background: "var(--bg-elevated)",
            borderRadius: 8,
            overflow: "auto",
            maxHeight: 260,
            fontSize: 11,
          }}
          aria-label={t("runtime:diagnostics.capabilitiesAria")}
        >
          {caps}
        </pre>
      ) : null}

      <div className="section-title">{t("runtime:diagnostics.exportTitle")}</div>
      <div className="form-row">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label={t("runtime:diagnostics.chooseSession")}
            style={{ flex: "1 1 180px" }}
            value={zipSession || sessions[0]?.id || ""}
            onChange={(e) => setZipSession(e.target.value)}
          >
            {sessions.length === 0 ? <option value="">{t("runtime:diagnostics.noSession")}</option> : null}
            {sessions.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </select>
          <input
            type="text"
            className="mono"
            style={{ flex: "2 1 260px" }}
            aria-label={t("runtime:diagnostics.savePath")}
            value={zipDest}
            onChange={(e) => setZipDest(e.target.value)}
          />
          <button
            className="btn"
            type="button"
            onClick={() =>
              void api
                .pickSavePath("agentport-diagnostics.zip")
                .then((p) => {
                  if (p) setZipDest(p);
                })
                .catch((e) => toast(
                  t("runtime:diagnostics.chooseDestinationFailed", { detail: errorText(e) }),
                  "error",
                ))
            }
          >
            {t("common:actions.browse")}
          </button>
          <button className="btn" disabled={busy || sessions.length === 0} onClick={() => void exportZip()}>
            {busy ? t("common:actions.exporting") : t("runtime:diagnostics.exportZip")}
          </button>
        </div>
        {zipResult ? (
          <span className="form-hint">
            {t("runtime:diagnostics.exportedPath")} <span className="mono">{zipResult}</span>
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
