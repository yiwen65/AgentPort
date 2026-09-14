// Recovery timeline (PRD 3.6 / 4.4.1): three-line summary + event list,
// click opens the Session at its latest output, "全部已读" acknowledges.

import Modal from "./Modal";
import { useTranslation } from "react-i18next";
import { ackTimelineFlow, refreshTimeline, selectSession } from "../actions";
import { agentDisplay, confidenceLabel, formatTimelineTime, sourceLabel, stateLabel } from "../format";
import { closeDialog, findSession, openDialog, toast, useStore } from "../store";
import { runtimeMessageText } from "../runtimeMessages";
import type { TimelineEntry } from "../types";

function EntryRow({ entry }: { entry: TimelineEntry }) {
  const { t } = useTranslation("session");
  const s = useStore();
  const session = findSession(s.projects, entry.sessionId);
  const exists = Boolean(session);
  const outputOnly = entry.evidence === "recovery:output-during-gui-closed";
  const hostInterrupted = entry.evidence?.startsWith("host:interrupted:") ?? false;
  return (
    <button
      className="timeline-row"
      aria-disabled={!exists}
      onClick={() => {
        if (!exists) {
          toast(t("timeline.sessionMissing"), "error");
          return;
        }
        closeDialog();
        selectSession(entry.sessionId);
      }}
    >
      <span className="timeline-time">{formatTimelineTime(entry.occurredAt)}</span>
      <span className="timeline-main">
        <div className="timeline-title">
          {agentDisplay(entry.adapterType)} · {entry.sessionTitle}
        </div>
        <div className="timeline-sub">{entry.projectName}</div>
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 12 }}>
        {outputOnly
          ? t("timeline.newOutputWhileClosed")
          : hostInterrupted
            ? t("timeline.hostInterrupted")
            : stateLabel(entry.state)}
      </span>
      <span className="dim" style={{ flex: "none", fontSize: 11 }}>
        {sourceLabel(entry.source)} · {confidenceLabel(entry.confidence)}
      </span>
    </button>
  );
}

export default function TimelineDialog() {
  const { t } = useTranslation(["session", "common"]);
  const s = useStore();
  const timeline = s.timeline;
  const timelineError = s.timelineMessage
    ? runtimeMessageText(s.timelineMessage)
    : s.timelineError;

  return (
    <Modal
      title={t("session:timeline.title")}
      onClose={closeDialog}
      wide
      footer={
        <>
          <span className="dim" style={{ marginRight: "auto", alignSelf: "center", fontSize: 12 }}>
            {t("session:timeline.description")}
          </span>
          <button
            className="btn"
            disabled={timeline.entries.length === 0}
            onClick={() => void ackTimelineFlow()}
          >
            {t("session:timeline.markAllRead")}
          </button>
          <button className="btn ghost" onClick={closeDialog}>
            {t("common:actions.close")}
          </button>
        </>
      }
    >
      <div className="timeline-summary">
        <div className="summary-card ok">
          <div className="num">{timeline.completed}</div>
          <div className="dim">{t("session:timeline.completed")}</div>
        </div>
        <div className="summary-card wait">
          <div className="num">{timeline.waiting}</div>
          <div className="dim">{t("session:timeline.needsInput")}</div>
        </div>
        <div className="summary-card fail">
          <div className="num">{timeline.failed}</div>
          <div className="dim">{t("session:timeline.failed")}</div>
        </div>
      </div>
      {timelineError ? (
        <div className="empty-state" role="alert">
          <div>{timelineError}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }}>
            <button className="btn" onClick={() => void refreshTimeline()}>{t("common:actions.retry")}</button>
            <button className="btn ghost" onClick={() => openDialog({ kind: "diagnostics" })}>{t("session:timeline.openDiagnostics")}</button>
          </div>
        </div>
      ) : null}
      {timelineError ? null : timeline.entries.length === 0 ? (
        <div className="empty-state">
          <div>{t("session:timeline.empty")}</div>
          <button className="btn ghost" onClick={closeDialog}>
            {t("session:timeline.viewAllSessions")}
          </button>
        </div>
      ) : (
        <div role="list" aria-label={t("session:timeline.eventsAria")}>
          {timeline.entries.map((e, i) => (
            <EntryRow key={`${e.sessionId}-${i}`} entry={e} />
          ))}
        </div>
      )}
    </Modal>
  );
}
