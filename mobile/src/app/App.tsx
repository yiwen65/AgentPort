import { useCallback, lazy, Suspense, useEffect, useRef, useState, type TouchEvent } from "react";
import { useTranslation } from "react-i18next";
import { HostManager } from "../features/hosts-auth/HostManager";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { useTerminalImmersion } from "./terminalImmersion";
import { useApplyAppAppearance } from "./appAppearance";
import { usePushAlerts } from "./usePushAlerts";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { SessionDashboard } from "../features/sessions/SessionDashboard";
import type { OpenSession } from "../features/sessions/types";
import type { HostProfileSummary, RemoteClient } from "../protocol/remoteClient";
import type { GenericTerminalClient } from "../protocol/genericTerminalClient";
import { genericTerminalClient } from "../platform/tauriGenericTerminalClient";
import { GenericTerminal } from "../features/generic-terminal/GenericTerminal";

const SessionWorkspace = lazy(() => import("../features/sessions/SessionWorkspace").then((module) => ({
  default: module.SessionWorkspace,
})));

const SessionFiles = lazy(() => import("../features/files/SessionFiles").then((module) => ({
  default: module.SessionFiles,
})));

type SessionPage = "list" | "terminal" | "files";

interface AppProps {
  client: RemoteClient;
  hostAuthClient: HostAuthClient;
  terminalClient?: GenericTerminalClient;
}

export function App({ client, hostAuthClient, terminalClient = genericTerminalClient }: AppProps) {
  useApplyAppAppearance();
  const { t } = useTranslation();
  const [openedSession, setOpenedSession] = useState<{ open: OpenSession; token: number }>();
  const handleSessionOpened = useCallback((open: OpenSession) => setOpenedSession(previous => ({ open, token: (previous?.token ?? 0) + 1 })), []);
  const [selectedSession, setSelectedSession] = useState<OpenSession>();
  const [genericHost, setGenericHost] = useState<HostProfileSummary>();
  const [page, setPage] = useState<SessionPage>("list");
  const terminalVisible = page === "terminal" && !genericHost;
  const [filesVisited, setFilesVisited] = useState(false);
  useTerminalImmersion(terminalVisible);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);
  const [hostProfilesEpoch, setHostProfilesEpoch] = useState(0);
  const [connectedProfileId, setConnectedProfileId] = useState<string>();
  const closeDeviceManager = useCallback(() => { setConnectedProfileId(undefined); setDeviceManagerOpen(false); setHostProfilesEpoch(value => value + 1); }, []);
  const pairedConnected = useCallback((profileId: string) => {
    setConnectedProfileId(profileId);
    setDeviceManagerOpen(false);
    setPage("list");
    setHostProfilesEpoch(value => value + 1);
  }, []);
  const swipeStart = useRef<{ x: number; y: number; at: number; page: SessionPage; vertical: boolean }>();

  const openSession = useCallback((session: OpenSession) => {
    setSelectedSession(session);
    setPage("terminal");
  }, []);
  const openFiles = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setFilesVisited(true);
    setPage("files");
  };
  usePushAlerts(client, hostAuthClient, hostProfilesEpoch, openSession);

  const handleSessionChanged = (next?: OpenSession) => {
    setSelectedSession(next);
    if (!next) setPage("list");
  };

  const onTouchStart = (event: TouchEvent) => {
    swipeStart.current = undefined;
    if (settingsOpen || deviceManagerOpen || genericHost || event.touches.length !== 1 || document.querySelector(".mobile-modal-portal")) return;
    if (window.getSelection()?.toString()) return;
    const target = event.target as HTMLElement;
    if (target.closest("[role=dialog], .modal-backdrop, .centered-modal-backdrop")) return;
    if (target.closest("input, select, textarea, [data-horizontal-scroll], [data-no-page-swipe]")) return;
    if (target.closest("button") && !target.closest(".project-toggle, .v2-session-row, [data-page-swipe]")) return;
    const touch = event.touches[0];
    swipeStart.current = { x: touch.clientX, y: touch.clientY, at: performance.now(), page, vertical: false };
  };

  // Observe in capture phase: terminal vertical scroll consumes bubbling events.
  // Once vertical movement wins, a later diagonal tail cannot turn it into navigation.
  const onTouchMove = (event: TouchEvent) => {
    const start = swipeStart.current;
    if (!start) return;
    if (event.touches.length !== 1) { swipeStart.current = undefined; return; }
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - start.x);
    const dy = Math.abs(touch.clientY - start.y);
    if (dy > 8 && dy >= dx) start.vertical = true;
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = swipeStart.current;
    swipeStart.current = undefined;
    if (settingsOpen || deviceManagerOpen || genericHost || document.querySelector(".mobile-modal-portal") || !start || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    const elapsed = performance.now() - start.at;
    if (start.page !== page || start.vertical || elapsed > 700 || Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    if (window.getSelection()?.toString()) return;
    if (page === "terminal") {
      event.preventDefault(); // A completed page swipe must not also click its starting row.
      if (dx > 0) setPage("list");
      else openFiles();
    } else if (page === "files" && dx > 0) {
      event.preventDefault();
      setPage("terminal");
    } else if (page === "list" && dx < 0 && selectedSession) {
      event.preventDefault();
      setPage("terminal");
    }
  };

  useEffect(() => {
    if (!deviceManagerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDeviceManager();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deviceManagerOpen, closeDeviceManager]);

  // Restore focus only for navigation, not replacement Session snapshots.
  // Live status/rename updates must never move focus from the input to ARTICLE.
  const selectedSessionId = selectedSession?.session.id;
  const selectedHostProfileId = selectedSession?.hostProfileId;
  useEffect(() => {
    if (!selectedSessionId) return;
    let frame: number;
    let attempts = 0;
    const restoreFocus = () => {
      // A modal opened during the transition owns focus until it closes.
      if (document.querySelector("[role=dialog]")) return;
      const target = page === "files"
        ? document.querySelector<HTMLElement>(".files-stage .session-files")
        : terminalVisible ? document.querySelector<HTMLElement>(".session-stage .session-workspace")
        : [...document.querySelectorAll<HTMLElement>("[data-session-id]")].find((element) => element.dataset.sessionId === selectedSessionId && element.dataset.hostId === selectedHostProfileId);
      if (target) {
        // A tap can focus the terminal input before this navigation frame runs.
        // Keep that descendant's focus instead of dismissing the iOS keyboard.
        if (!target.contains(document.activeElement)) target.focus();
      } else if (attempts < 60) {
        attempts += 1;
        frame = window.requestAnimationFrame(restoreFocus);
      }
    };
    frame = window.requestAnimationFrame(restoreFocus);
    return () => window.cancelAnimationFrame(frame);
  }, [selectedHostProfileId, selectedSessionId, page, terminalVisible]);

  useEffect(() => {
    document.documentElement.classList.toggle("terminal-visible", terminalVisible);
    document.body.classList.toggle("terminal-visible", terminalVisible);
    return () => {
      document.documentElement.classList.remove("terminal-visible");
      document.body.classList.remove("terminal-visible");
    };
  }, [terminalVisible]);

  useEffect(() => {
    const filesVisible = page === "files";
    document.documentElement.classList.toggle("files-visible", filesVisible);
    document.body.classList.toggle("files-visible", filesVisible);
    return () => {
      document.documentElement.classList.remove("files-visible");
      document.body.classList.remove("files-visible");
    };
  }, [page]);

  return (
    <div className="app-shell" data-page={page} onTouchStart={onTouchStart} onTouchMoveCapture={onTouchMove}
      onTouchEnd={onTouchEnd} onTouchCancel={() => { swipeStart.current = undefined; }}>
      <main className="main-content" id="main-content" aria-hidden={page !== "list" || !!genericHost} {...(page !== "list" || genericHost ? { inert: "" } : {})}>
        <SessionDashboard
          client={client}
          active={page === "list" && !deviceManagerOpen && !settingsOpen && !genericHost}
          onOpenSession={openSession}
          openedSession={openedSession}
          hostProfilesEpoch={hostProfilesEpoch}
          preferredHostId={connectedProfileId}
          onManageDevices={() => setDeviceManagerOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </main>

      {selectedSession ? (
        <div className={`session-stage${terminalVisible ? " is-visible" : ""}${page === "files" ? " is-before-files" : ""}`} aria-hidden={!terminalVisible} {...(!terminalVisible ? { inert: "" } : {})}>
          <Suspense fallback={<div className="state-card" role="status">{t("dashboard.loading")}</div>}>
            <SessionWorkspace
              key={`${selectedSession.hostProfileId}:${selectedSession.session.id}`}
              active={terminalVisible}
              open={selectedSession}
              client={client}
              onOpened={handleSessionOpened}
              onClose={() => setPage("list")}
              onOpenFiles={openFiles}
              onSessionChanged={handleSessionChanged}
            />
          </Suspense>
        </div>
      ) : null}

      {selectedSession && filesVisited ? (
        <div className={`files-stage${page === "files" ? " is-visible" : ""}`} aria-hidden={page !== "files"} {...(page !== "files" ? { inert: "" } : {})}>
          <Suspense fallback={<div className="state-card" role="status">{t("dashboard.loading")}</div>}>
            <SessionFiles key={JSON.stringify([selectedSession.hostProfileId, selectedSession.session.id, selectedSession.session.cwd])}
              open={selectedSession} client={client} active={page === "files"} onBack={() => setPage("terminal")} />
          </Suspense>
        </div>
      ) : null}

      {genericHost ? <GenericTerminal key={genericHost.id} host={genericHost} client={terminalClient} authClient={hostAuthClient}
        onBack={() => { setGenericHost(undefined); setDeviceManagerOpen(true); }} /> : null}

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      {deviceManagerOpen ? (
        <div className="modal-backdrop device-manager-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDeviceManager();
        }}>
          <section className="modal-sheet device-manager-sheet" role="dialog" aria-modal="true" aria-label={t("hosts.title")}>
            <button className="device-manager-close" type="button" onClick={closeDeviceManager} aria-label={t("common.close")}>×</button>
            <HostManager remoteClient={client} authClient={hostAuthClient} onPairedConnected={pairedConnected}
              onOpenTerminal={host => { setGenericHost(host); setDeviceManagerOpen(false); }} />
          </section>
        </div>
      ) : null}
    </div>
  );
}
