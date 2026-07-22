// Export dialog for one session: Markdown (all / last N blocks) or raw log
// (all / last 10k lines, optional ANSI strip). dest is a text input because
// the backend registers no save-file dialog plugin.

import { useState } from "react";
import Modal from "./Modal";
import { api, copyText, errorText } from "../api";
import { closeDialog, findSession, getState, toast, useStore } from "../store";

function defaultDest(sessionId: string, kind: "md" | "log"): string {
  const base = getState().exportsDir || "/tmp";
  return `${base}/agentport-${sessionId}.${kind === "md" ? "md" : "log"}`;
}

export default function ExportDialog({
  sessionId,
  exportKind,
}: {
  sessionId: string;
  exportKind: "md" | "log";
}) {
  const s = useStore();
  const ses = findSession(s.projects, sessionId);
  const [last, setLast] = useState<string>("all");
  const [stripAnsi, setStripAnsi] = useState(false);
  const [dest, setDest] = useState(defaultDest(sessionId, exportKind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);

  const submit = async () => {
    if (!dest.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api.exportSession({
        sessionId,
        kind: exportKind,
        dest: dest.trim(),
        last: last === "all" ? null : Number(last),
        stripAnsi,
      });
      setDonePath(p);
      toast("导出完成", "success");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={exportKind === "md" ? `导出 Markdown · ${ses?.title ?? ""}` : `导出原始日志 · ${ses?.title ?? ""}`}
      onClose={closeDialog}
      footer={
        donePath ? (
          <>
            <button
              className="btn"
              onClick={() =>
                void copyText(donePath).then((ok) =>
                  toast(ok ? "已复制路径" : "复制失败", ok ? "success" : "error"),
                )
              }
            >
              复制路径
            </button>
            <button className="btn primary" onClick={closeDialog}>
              完成
            </button>
          </>
        ) : (
          <>
            <button className="btn ghost" onClick={closeDialog}>
              取消
            </button>
            <button className="btn primary" disabled={busy || !dest.trim()} onClick={() => void submit()}>
              {busy ? "导出中…" : "导出"}
            </button>
          </>
        )
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      {donePath ? (
        <div className="info-box" role="status">
          <div className="kv">
            <span className="k">已导出到</span>
            <span className="v mono">{donePath}</span>
          </div>
        </div>
      ) : (
        <>
          <div className="form-row">
            <label htmlFor="ex-range">范围</label>
            <select id="ex-range" value={last} onChange={(e) => setLast(e.target.value)}>
              <option value="all">全部</option>
              {exportKind === "md" ? (
                <>
                  <option value="20">最近 20 个输出块</option>
                  <option value="50">最近 50 个输出块</option>
                  <option value="100">最近 100 个输出块</option>
                </>
              ) : (
                <option value="10000">最近 10,000 行</option>
              )}
            </select>
          </div>
          {exportKind === "log" ? (
            <label className="check-row">
              <input
                type="checkbox"
                checked={stripAnsi}
                onChange={(e) => setStripAnsi(e.target.checked)}
              />
              <span>去除 ANSI 控制序列</span>
            </label>
          ) : (
            <p className="form-hint">Markdown 导出包含 Session、Agent、项目、分支和时间头。</p>
          )}
          <div className="form-row">
            <label htmlFor="ex-dest">保存到（绝对路径）</label>
            <div className="inline-form">
              <input
                id="ex-dest"
                type="text"
                className="mono"
                value={dest}
                onChange={(e) => setDest(e.target.value)}
              />
              <button
                className="btn"
                type="button"
                onClick={() =>
                  void api
                    .pickSavePath(`agentport-${sessionId}.${exportKind === "md" ? "md" : "log"}`)
                    .then((p) => {
                      if (p) setDest(p);
                    })
                    .catch((e) => setError(errorText(e)))
                }
              >
                浏览…
              </button>
            </div>
            <span className="form-hint">导出前自动脱敏：已知 Secret 值会被固定掩码替换。</span>
          </div>
        </>
      )}
    </Modal>
  );
}
