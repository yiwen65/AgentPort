import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HostProfileSummary } from "../../protocol/remoteClient";
import type { InboxEntry } from "./attentionInbox";
import "./recentNotifications.css";

const RecentRow = memo(function RecentRow({ entry, host, busy, onOpen, onDismiss }: {
  entry: InboxEntry; host?: HostProfileSummary; busy: boolean;
  onOpen: (entry: InboxEntry) => void; onDismiss: (entry: InboxEntry) => void;
}) {
  const { t } = useTranslation();
  const kindLabel = entry.kind === "execution_failed" ? "dashboard.executionFailed"
    : entry.kind === "turn_completed" ? "dashboard.turnCompleted" : "dashboard.approvalRequested";
  const date = new Date(entry.occurredAt);
  const timestamp = date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
  const surface = useRef<HTMLButtonElement>(null);
  const gesture = useRef<{ x: number; y: number; origin: number; horizontal: boolean }>();
  const offset = useRef(0);
  const consumed = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removalTimer = useRef<ReturnType<typeof setTimeout>>();
  const settle = (open: boolean) => {
    offset.current = open ? -80 : 0;
    surface.current?.style.setProperty("--swipe-x", `${offset.current}px`);
    surface.current?.classList.remove("is-dragging");
    setExpanded(open);
  };
  useEffect(() => () => { gesture.current = undefined; clearTimeout(removalTimer.current); }, []);
  return <li className={`recent-message${expanded ? " is-expanded" : ""}${removing ? " is-removing" : ""}`}>
    <button type="button" className="recent-dismiss" disabled={removing} onClick={() => {
      setRemoving(true);
      const delay = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
      removalTimer.current = setTimeout(() => { onDismiss(entry); setRemoving(false); settle(false); }, delay);
    }}
      aria-label={t("dashboard.dismissNotification", { title: entry.sessionTitle ?? entry.sessionId })}>
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 10v8m4-8v8" /></svg>
      <span>{t("dashboard.dismiss")}</span>
    </button>
    <button ref={surface} type="button" className="recent-message-surface" aria-busy={busy || undefined}
      aria-label={`${entry.sessionTitle ?? entry.sessionId}, ${t(kindLabel)}, ${host?.name ?? entry.hostId}`}
      aria-disabled={host?.connectionState !== "connected" || busy}
      onPointerDown={event => {
        if (event.button !== 0) return;
        consumed.current = false;
        gesture.current = { x: event.clientX, y: event.clientY, origin: offset.current, horizontal: false };
      }}
      onPointerMove={event => {
        const start = gesture.current; if (!start) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (!start.horizontal) {
          if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { gesture.current = undefined; return; }
          if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
          start.horizontal = true; consumed.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          event.currentTarget.classList.add("is-dragging");
        }
        offset.current = Math.max(-100, Math.min(0, start.origin + dx));
        event.currentTarget.style.setProperty("--swipe-x", `${offset.current}px`);
      }}
      onPointerUp={() => { if (gesture.current?.horizontal) settle(offset.current < -40); gesture.current = undefined; }}
      onPointerCancel={() => { settle(expanded); gesture.current = undefined; }}
      onKeyDown={event => { if (event.key === "Escape") settle(false); }}
      onClick={() => {
        if (consumed.current) { consumed.current = false; return; }
        if (expanded) { settle(false); return; }
        if (host?.connectionState === "connected" && !busy) onOpen(entry);
      }}>
      <span className={`recent-kind ${entry.kind}`} aria-hidden="true">{entry.kind === "turn_completed" ? "✓" : "!"}</span>
      <span className="recent-message-copy"><strong>{entry.sessionTitle ?? entry.sessionId}</strong>
        <span>{t(kindLabel)}</span>
        <small>{host?.name ?? entry.hostId}</small></span>
      <time dateTime={entry.occurredAt}>{timestamp}</time>
    </button>
  </li>;
});

export function RecentNotifications({ entries, hosts, opening, onOpen, onDismiss }: {
  entries: InboxEntry[]; hosts: HostProfileSummary[]; opening?: string;
  onOpen: (entry: InboxEntry) => void; onDismiss: (entry: InboxEntry) => void;
}) {
  return <ul className="recent-message-list">{entries.map(entry => <RecentRow key={`${entry.hostId}:${entry.sessionId}`}
    entry={entry} host={hosts.find(host => host.id === entry.hostId)} busy={opening === `${entry.hostId}:${entry.sessionId}`}
    onOpen={onOpen} onDismiss={onDismiss} />)}</ul>;
}
