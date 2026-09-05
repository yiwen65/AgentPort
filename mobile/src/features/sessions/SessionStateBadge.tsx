import { useTranslation } from "react-i18next";
import type { SessionSummary } from "./types";
import "./session-state.css";

const labels = {
  creating: "Starting", working: "Working", needs_input: "Needs input", idle: "Idle",
  exited: "Ended", interrupted: "Interrupted", stopped: "Stopped", unknown: "Unknown",
};
type DisplayState = keyof typeof labels;
export function sessionDisplayState(session: SessionSummary): DisplayState {
  const state = session.lifecycle === "running" ? session.latestStatus?.state : session.lifecycle;
  return state && Object.hasOwn(labels, state) ? state as DisplayState : "unknown";
}

export function SessionStateBadge({ session, stale = false }: { session: SessionSummary; stale?: boolean }) {
  const { t } = useTranslation();
  const state = sessionDisplayState(session);
  const cached = stale || (session.lifecycle === "running" && session.hostAlive === false);
  const moving = !cached && (state === "working" || state === "creating");
  const glyphs = {
    creating: <><circle cx="8" cy="8" r="5.5" strokeDasharray="20 15" /><path d="M8 5.5v5M5.5 8h5" /></>,
    working: <><circle cx="8" cy="8" r="5.5" strokeDasharray="24 11" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></>,
    needs_input: <><path d="M4 3.5v9m4-9v9" /><path d="m11 6 2 2-2 2" /></>,
    idle: <><circle cx="8" cy="8" r="5.5" /><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" /></>,
    exited: <><circle cx="8" cy="8" r="5.5" /><path d="M5.5 8h5" /></>,
    interrupted: <><path d="m8 2 6 11H2L8 2Z" /><path d="M8 6v3m0 2v.2" /></>,
    stopped: <rect x="3.5" y="3.5" width="9" height="9" rx="2" />,
    unknown: <><circle cx="8" cy="8" r="5.5" /><path d="M6 6a2 2 0 1 1 3.2 1.6C8.3 8.2 8 8.5 8 9m0 2v.1" /></>,
  };
  return <span className={`session-state state-${state}${cached ? " is-cached" : ""}`}>
    <svg className={`session-state-glyph${moving ? " is-moving" : ""}`} data-state={state} aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">{glyphs[state]}</svg>
    <span>{cached ? <span className="session-state-cached">{t("dashboard.states.cached", { defaultValue: "Last known" })} · </span> : null}{t(`dashboard.states.${state}`, { defaultValue: labels[state] })}</span>
  </span>;
}
