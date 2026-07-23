// Recovery timeline (PRD 3.6 / 4.4.1): three-line summary + event list,
// click jumps to the session, "全部已读" acknowledges.

import Modal from "./Modal";
import { ackTimelineFlow, refreshTimeline, selectSession } from "../actions";
import { agentDisplay, confidenceZh, formatTimelineTime, sourceZh, stateZh } from "../format";
import { closeDialog, findSession, openDialog, toast, useStore } from "../store";
import type { TimelineEntry } from "../types";

function EntryRow({ entry }: { entry: TimelineEntry }) {
  const s = useStore();
  const exists = Boolean(findSession(s.projects, entry.sessionId));
  const canLocate = Boolean(entry.logCursor) && !entry.rotatedAway;
  const outputOnly = entry.evidence === "recovery:output-during-gui-closed";
  const hostInterrupted = entry.evidence?.startsWith("host:interrupted:") ?? false;
  const unavailable = entry.locationUnavailableReason
    ?? (entry.rotatedAway ? "输出已轮转" : "此事件没有可验证的输出位置");
  return (
    <button
      className="timeline-row"
      aria-disabled={!exists}
      data-tip={canLocate
        ? `日志 ${entry.logCursor?.runId} / 代际 ${entry.logCursor?.generation} / 偏移 ${entry.logCursor?.offset}`
        : unavailable}
      onClick={() => {
        if (!exists) {
          toast("该 Session 已不存在，无法打开对应输出", "error");
          return;
        }
        closeDialog();
        selectSession(entry.sessionId, canLocate ? entry.logCursor : null);
        if (!canLocate) toast(`已打开 Session；${unavailable}`, "info");
      }}
    >
      <span className="timeline-time">{formatTimelineTime(entry.occurredAt)}</span>
      <span className="timeline-main">
        <div className="timeline-title">
          {agentDisplay(entry.adapterType)} · {entry.sessionTitle}
        </div>
        <div className="timeline-sub">
          {entry.projectName}
          {canLocate ? " · 可定位输出" : ` · ${unavailable}`}
        </div>
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 12 }}>
        {outputOnly ? "关闭期间新增输出" : hostInterrupted ? "Host 异常中断" : stateZh(entry.state)}
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 11 }}>
        {sourceZh(entry.source)} · {confidenceZh(entry.confidence)}
      </span>
    </button>
  );
}

export default function TimelineDialog() {
  const s = useStore();
  const t = s.timeline;

  return (
    <Modal
      title="恢复时间线"
      onClose={closeDialog}
      wide
      footer={
        <>
          <span className="dim" style={{ marginRight: "auto", alignSelf: "center", fontSize: 12 }}>
            离开期间发生的完成 / 等待 / 异常事件
          </span>
          <button
            className="btn"
            disabled={t.entries.length === 0}
            onClick={() => void ackTimelineFlow()}
          >
            全部已读
          </button>
          <button className="btn ghost" onClick={closeDialog}>
            关闭
          </button>
        </>
      }
    >
      <div className="timeline-summary">
        <div className="summary-card ok">
          <div className="num">{t.completed}</div>
          <div className="dim">已完成</div>
        </div>
        <div className="summary-card wait">
          <div className="num">{t.waiting}</div>
          <div className="dim">等待输入</div>
        </div>
        <div className="summary-card fail">
          <div className="num">{t.failed}</div>
          <div className="dim">异常 / 退出</div>
        </div>
      </div>
      {s.timelineError ? (
        <div className="empty-state" role="alert">
          <div>{s.timelineError}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
            <button className="btn" onClick={() => void refreshTimeline()}>重试</button>
            <button className="btn ghost" onClick={() => openDialog({ kind: "diagnostics" })}>打开诊断</button>
          </div>
        </div>
      ) : null}
      {s.timelineError ? null : t.entries.length === 0 ? (
        <div className="empty-state">
          <div>离开期间没有新的完成、等待或异常事件。</div>
          <button className="btn ghost" onClick={closeDialog}>
            查看全部 Session
          </button>
        </div>
      ) : (
        <div role="list" aria-label="时间线事件">
          {t.entries.map((e, i) => (
            <EntryRow key={`${e.sessionId}-${i}`} entry={e} />
          ))}
        </div>
      )}
    </Modal>
  );
}
