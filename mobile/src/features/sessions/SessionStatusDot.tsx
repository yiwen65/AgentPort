import { useTranslation } from "react-i18next";
import type { SessionSummary } from "./types";
import "./session-status-dot.css";

const labels = {
  creating: "Starting", working: "Working", needs_input: "Needs input", idle: "Idle",
  exited: "Ended", interrupted: "Interrupted", stopped: "Stopped", unknown: "Unknown",
};
type DisplayState = keyof typeof labels;
export function sessionDisplayState(session: SessionSummary): DisplayState {
  const state = session.lifecycle === "running" ? session.latestStatus?.state : session.lifecycle;
  return state && Object.hasOwn(labels, state) ? state as DisplayState : "unknown";
}

/** Desktop parity: ended and stopped sessions share the filled stopped dot. */
export function sessionDotClass(session: SessionSummary): string {
  const state = sessionDisplayState(session);
  return state === "exited" ? "stopped" : state;
}

export function SessionStatusDot({ session, stale = false }: { session: SessionSummary; stale?: boolean }) {
  const { t } = useTranslation();
  const state = sessionDisplayState(session);
  const cached = stale || (session.lifecycle === "running" && session.hostAlive === false);
  return <>
    <span className={`session-status-dot ${sessionDotClass(session)}${cached ? " is-cached" : ""}`} aria-hidden="true" />
    <span className="visually-hidden">{cached ? <span className="session-status-cached">{t("dashboard.states.cached", { defaultValue: "Last known" })} · </span> : null}{t(`dashboard.states.${state}`, { defaultValue: labels[state] })}</span>
  </>;
}
