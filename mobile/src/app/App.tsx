import { useCallback, lazy, Suspense, useEffect, useRef, useState, type TouchEvent } from "react";
import { useTranslation } from "react-i18next";
import { HostManager } from "../features/hosts-auth/HostManager";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { useTerminalImmersion } from "./terminalImmersion";
import { useApplyAppAppearance } from "./appAppearance";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { SessionDashboard } from "../features/sessions/SessionDashboard";
import type { OpenSession } from "../features/sessions/types";
import type { RemoteClient } from "../protocol/remoteClient";

const SessionWorkspace = lazy(() => import("../features/sessions/SessionWorkspace").then((module) => ({
  default: module.SessionWorkspace,
})));

interface AppProps {
  client: RemoteClient;
  hostAuthClient: HostAuthClient;
}

export function App({ client, hostAuthClient }: AppProps) {
  useApplyAppAppearance();
  const { t } = useTranslation();
  const [openedSession, setOpenedSession] = useState<{ open: OpenSession; token: number }>();
  const handleSessionOpened = useCallback((open: OpenSession) => setOpenedSession(previous => ({ open, token: (previous?.token ?? 0) + 1 })), []);
  const [selectedSession, setSelectedSession] = useState<OpenSession>();
  const [terminalVisible, setTerminalVisible] = useState(false);
  useTerminalImmersion(terminalVisible);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const [hostProfilesEpoch, setHostProfilesEpoch] = useState(0);
  const [connectedProfileId, setConnectedProfileId] = useState<string>();
  const closeDeviceManager = useCallback(() => { setConnectedProfileId(undefined); setDeviceManagerOpen(false); setHostProfilesEpoch(value => value + 1); }, []);
  const pairedConnected = useCallback((profileId: string) => {
    setConnectedProfileId(profileId);
    setDeviceManagerOpen(false);
    setTerminalVisible(false);
    setHostProfilesEpoch(value => value + 1);
  }, []);
  const swipeStart = useRef<{ x: number; y: number; at: number }>();

  const openSession = useCallback((session: OpenSession) => {
    setSelectedSession(session);
    setTerminalVisible(true);
  }, []);

  const handleSessionChanged = (next?: OpenSession) => {
    setSelectedSession(next);
    if (!next) setTerminalVisible(false);
  };

  const onTouchStart = (event: TouchEvent) => {
    swipeStart.current = undefined;
    if (settingsOpen || deviceManagerOpen || event.touches.length !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("[role=dialog], .modal-backdrop, .centered-modal-backdrop")) return;
    if (target.closest("input, select, textarea, [data-horizontal-scroll]")) return;
    if (target.closest("button") && !target.closest(".project-toggle, .v2-session-row")) return;
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY, at: performance.now() };
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = undefined;
    if (settingsOpen || deviceManagerOpen || document.querySelector(".mobile-modal-portal") || !start || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = performance.now() - start.at;
    if (elapsed > 700 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (terminalVisible && dx > 0) setTerminalVisible(false);
    if (!terminalVisible && dx < 0 && selectedSession) setTerminalVisible(true);
  };

  useEffect(() => {
    if (!deviceManagerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDeviceManager();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deviceManagerOpen, closeDeviceManager]);

  useEffect(() => {
    if (!selectedSession) return;
    let frame: number;
    let attempts = 0;
    const restoreFocus = () => {
      // A modal opened during the transition owns focus until it closes.
      if (document.querySelector("[role=dialog]")) return;
      const target = terminalVisible
        ? document.querySelector<HTMLElement>(".session-stage .session-workspace")
        : [...document.querySelectorAll<HTMLElement>("[data-session-id]")].find((element) => element.dataset.sessionId === selectedSession.session.id);
      if (target) {
        target.focus();
      } else if (attempts < 60) {
        attempts += 1;
        frame = window.requestAnimationFrame(restoreFocus);
      }
    };
    frame = window.requestAnimationFrame(restoreFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSession, terminalVisible]);

  useEffect(() => {
    document.documentElement.classList.toggle("terminal-visible", terminalVisible);
    document.body.classList.toggle("terminal-visible", terminalVisible);
    return () => {
      document.documentElement.classList.remove("terminal-visible");
      document.body.classList.remove("terminal-visible");
    };
  }, [terminalVisible]);

  return (
    <div className="app-shell" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <main className="main-content" id="main-content" aria-hidden={terminalVisible}>
        <SessionDashboard
          client={client}
          active={!terminalVisible && !deviceManagerOpen && !settingsOpen}
          onOpenSession={openSession}
          openedSession={openedSession}
          hostProfilesEpoch={hostProfilesEpoch}
          preferredHostId={connectedProfileId}
          onManageDevices={() => setDeviceManagerOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </main>

      {selectedSession ? (
        <div className={`session-stage${terminalVisible ? " is-visible" : ""}`} aria-hidden={!terminalVisible}>
          <Suspense fallback={<div className="state-card" role="status">{t("dashboard.loading")}</div>}>
            <SessionWorkspace
              key={`${selectedSession.hostProfileId}:${selectedSession.session.id}`}
              active={terminalVisible}
              open={selectedSession}
              client={client}
              onOpened={handleSessionOpened}
              onClose={() => setTerminalVisible(false)}
              onSessionChanged={handleSessionChanged}
            />
          </Suspense>
        </div>
      ) : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {deviceManagerOpen ? (
        <div className="modal-backdrop device-manager-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDeviceManager();
        }}>
          <section className="modal-sheet device-manager-sheet" role="dialog" aria-modal="true" aria-label={t("hosts.title")}>
            <button className="device-manager-close" type="button" onClick={closeDeviceManager} aria-label={t("common.close")}>×</button>
            <HostManager remoteClient={client} authClient={hostAuthClient} onPairedConnected={pairedConnected} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
