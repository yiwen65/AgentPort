// Recovery timeline (PRD 3.6 / 4.4.1): three-line summary + event list,
// click jumps to the session, "全部已读" acknowledges.

import { useEffect } from "react";
import Modal from "./Modal";
import { ackTimelineFlow, refreshTimeline, selectSession } from "../actions";
import { agentDisplay, confidenceZh, formatTime, sourceZh, stateZh } from "../format";
import { closeDialog, findSession, toast, useStore } from "../store";
import type { TimelineEntry } from "../types";

function EntryRow({ entry }: { entry: TimelineEntry }) {
  const s = useStore();
  const exists = Boolean(findSession(s.projects, entry.sessionId));
  return (
    <button
      className="timeline-row"
      disabled={!exists}
      data-tip={
        entry.rotatedAway
          ? "对应输出已轮转，仅保留事件元数据"
          : entry.logOffset !== null
            ? `日志偏移 ${entry.logOffset}`
            : undefined
      }
      onClick={() => {
        if (!exists) {
          toast("该 Session 已不存在", "error");
          return;
        }
        closeDialog();
        selectSession(entry.sessionId);
      }}
    >
      <span className="timeline-time">{formatTime(entry.occurredAt)}</span>
      <span className="timeline-main">
        <div className="timeline-title">
          {agentDisplay(entry.adapterType)} · {entry.sessionTitle}
        </div>
        <div className="timeline-sub">
          {entry.projectName}
          {entry.rotatedAway ? " · 输出已轮转" : ""}
        </div>
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 12 }}>
        {stateZh(entry.state)}
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 11 }}>
        {sourceZh(entry.source)} · {confidenceZh(entry.confidence)}
      </span>
    </button>
  );
}

export default function TimelineDialog() {
  const s = useStore();
  useEffect(() => {
    void refreshTimeline();
  }, []);
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
      {t.entries.length === 0 ? (
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
