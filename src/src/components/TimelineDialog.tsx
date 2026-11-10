// Recovery timeline: completed and waiting-for-approval list. Click opens the
// Session at its latest output and acknowledges that entry.

import Modal from "./Modal";
import { useTranslation } from "react-i18next";
import { ackTimelineFlow, dismissTimelineEntry, refreshTimeline, selectSession } from "../actions";
import { agentDisplay, formatTimelineTime } from "../format";
import { closeDialog, findSession, openDialog, toast, useStore } from "../store";
import { runtimeMessageText } from "../runtimeMessages";
import { visibleTimelineEntries, type TimelineEntryKind } from "../timelineEntries";
import type { TimelineEntry } from "../types";

function EntryRow({ entry, kind }: { entry: TimelineEntry; kind: TimelineEntryKind }) {
  const { t } = useTranslation("session");
  const s = useStore();
  const session = findSession(s.projects, entry.sessionId);
  const exists = Boolean(session);
  return (
    <button
      className="timeline-row"
      aria-disabled={!exists}
      onClick={() => {
        if (!exists) {
          toast(t("timeline.sessionMissing"), "error");
          return;
        }
        void dismissTimelineEntry(entry);
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
      <span className="timeline-kind">
        {t(kind === "waiting" ? "timeline.needsInput" : "timeline.completed")}
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
  const entries = visibleTimelineEntries(timeline.entries);
  const completed = entries.filter((item) => item.kind === "completed").length;
  const waiting = entries.filter((item) => item.kind === "waiting").length;

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
            disabled={entries.length === 0}
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
          <div className="num">{completed}</div>
          <div className="dim">{t("session:timeline.completed")}</div>
        </div>
        <div className="summary-card wait">
          <div className="num">{waiting}</div>
          <div className="dim">{t("session:timeline.needsInput")}</div>
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
      {timelineError ? null : entries.length === 0 ? (
        <div className="empty-state">
          <div>{t("session:timeline.empty")}</div>
          <button className="btn ghost" onClick={closeDialog}>
            {t("session:timeline.viewAllSessions")}
          </button>
        </div>
      ) : (
        <div role="list" aria-label={t("session:timeline.eventsAria")}>
          {entries.map(({ entry, kind }, i) => (
            <EntryRow key={`${entry.sessionId}-${i}`} entry={entry} kind={kind} />
          ))}
        </div>
      )}
    </Modal>
  );
}
