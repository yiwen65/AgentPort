import { useEffect, useRef, useState, type TouchEvent } from "react";
import { useTranslation } from "react-i18next";
import { HostManager } from "../features/hosts-auth/HostManager";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { SessionDashboard } from "../features/sessions/SessionDashboard";
import { SessionWorkspace } from "../features/sessions/SessionWorkspace";
import type { OpenSession } from "../features/sessions/types";
import type { RemoteClient } from "../protocol/remoteClient";

interface AppProps {
  client: RemoteClient;
  hostAuthClient: HostAuthClient;
}

export function App({ client, hostAuthClient }: AppProps) {
  const { t } = useTranslation();
  const [selectedSession, setSelectedSession] = useState<OpenSession>();
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const swipeStart = useRef<{ x: number; y: number; at: number }>();

  const openSession = (session: OpenSession) => {
    setSelectedSession(session);
    setTerminalVisible(true);
  };

  const handleSessionChanged = (next?: OpenSession) => {
    setSelectedSession(next);
    if (!next) setTerminalVisible(false);
  };

  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    const target = event.target as HTMLElement;
    if (target.closest("[role=dialog], .modal-backdrop")) return;
    if (target.closest("input, select, textarea, [data-horizontal-scroll]")) return;
    if (target.closest("button") && !target.closest(".project-toggle, .v2-session-row")) return;
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY, at: performance.now() };
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = undefined;
    if (!start || event.changedTouches.length !== 1) return;
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
      if (event.key === "Escape") setDeviceManagerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deviceManagerOpen]);

  useEffect(() => {
    if (!selectedSession) return;
    const frame = window.requestAnimationFrame(() => {
      if (terminalVisible) document.querySelector<HTMLElement>(".session-stage .terminal-back-button")?.focus();
      else [...document.querySelectorAll<HTMLElement>("[data-session-id]")].find((element) => element.dataset.sessionId === selectedSession.session.id)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedSession, terminalVisible]);

  return (
    <div className="app-shell" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <main className="main-content" id="main-content" aria-hidden={terminalVisible}>
        <SessionDashboard
          client={client}
          onOpenSession={openSession}
          onManageDevices={() => setDeviceManagerOpen(true)}
        />
      </main>

      {selectedSession ? (
        <div className={`session-stage${terminalVisible ? " is-visible" : ""}`} aria-hidden={!terminalVisible}>
          <SessionWorkspace
            key={`${selectedSession.hostProfileId}:${selectedSession.session.id}`}
            open={selectedSession}
            client={client}
            onClose={() => setTerminalVisible(false)}
            onSessionChanged={handleSessionChanged}
          />
        </div>
      ) : null}

      {deviceManagerOpen ? (
        <div className="modal-backdrop device-manager-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDeviceManagerOpen(false);
        }}>
          <section className="modal-sheet device-manager-sheet" role="dialog" aria-modal="true" aria-label={t("hosts.title")}>
            <button className="device-manager-close" type="button" onClick={() => setDeviceManagerOpen(false)} aria-label={t("common.close")}>×</button>
            <HostManager remoteClient={client} authClient={hostAuthClient} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
