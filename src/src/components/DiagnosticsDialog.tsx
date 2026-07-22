// Diagnostics center (PRD 2 / 3.6): host list, CLI capabilities, copyable
// summary, redacted diagnostics ZIP export, notification test.

import { useEffect, useState } from "react";
import Modal from "./Modal";
import { api, copyText, errorText } from "../api";
import { formatBytes } from "../format";
import { closeDialog, getState, toast, useStore } from "../store";
import type { HostInfo } from "../types";

export default function DiagnosticsDialog() {
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

  const reload = async () => {
    setError(null);
    try {
      setHosts(await api.diagHosts());
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  const copySummary = async () => {
    try {
      const text = await api.diagSummary();
      const ok = await copyText(text);
      toast(ok ? "诊断摘要已复制" : "复制失败", ok ? "success" : "error");
    } catch (e) {
      toast(errorText(e), "error");
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
      toast(errorText(e), "error");
    }
  };

  const exportZip = async () => {
    const sid = zipSession || sessions[0]?.id;
    if (!sid) {
      toast("没有可导出的 Session", "error");
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
      toast("诊断包已导出（已脱敏）", "success");
    } catch (e) {
      toast(`导出失败：${errorText(e)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="诊断中心" onClose={closeDialog} wide>
      {error ? <div className="error-bar" role="alert">{error}</div> : null}

      <div className="section-title">
        Host 列表
        <button className="btn small ghost" style={{ float: "right" }} onClick={() => void reload()}>
          刷新
        </button>
      </div>
      {hosts.length === 0 ? (
        <p className="dim" style={{ margin: 0 }}>
          暂无 Session Host 记录。
        </p>
      ) : (
        <table className="table" aria-label="Host 列表">
          <thead>
            <tr>
              <th>Session</th>
              <th>PID</th>
              <th>在线</th>
              <th>生命周期</th>
              <th>日志</th>
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
                  {h.alive ? "在线" : "离线"}
                </td>
                <td>{h.lifecycle}</td>
                <td>{formatBytes(h.logBytes)}</td>
                <td className="mono dim" style={{ wordBreak: "break-all", maxWidth: 200 }}>
                  {h.socketPath ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-title">操作</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => void copySummary()}>
          复制诊断摘要
        </button>
        <button className="btn" onClick={() => void showCaps()}>
          查看 CLI 能力
        </button>
        <button
          className="btn"
          onClick={() =>
            void api
              .notifyTest()
              .then(() => toast("测试通知已发送", "success"))
              .catch((e) => toast(`通知失败：${errorText(e)}`, "error"))
          }
        >
          通知测试
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
          aria-label="CLI 能力详情"
        >
          {caps}
        </pre>
      ) : null}

      <div className="section-title">导出诊断 ZIP（默认脱敏，不含环境变量值与凭据）</div>
      <div className="form-row">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            aria-label="选择 Session"
            style={{ flex: "1 1 180px" }}
            value={zipSession || sessions[0]?.id || ""}
            onChange={(e) => setZipSession(e.target.value)}
          >
            {sessions.length === 0 ? <option value="">（无 Session）</option> : null}
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
            aria-label="ZIP 保存路径"
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
                .catch((e) => toast(errorText(e), "error"))
            }
          >
            浏览…
          </button>
          <button className="btn" disabled={busy || sessions.length === 0} onClick={() => void exportZip()}>
            {busy ? "导出中…" : "导出 ZIP"}
          </button>
        </div>
        {zipResult ? (
          <span className="form-hint">
            已导出：<span className="mono">{zipResult}</span>
          </span>
        ) : null}
      </div>
    </Modal>
  );
}
