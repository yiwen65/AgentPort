import { useEffect, useState } from "react";
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
  const [deviceManagerOpen, setDeviceManagerOpen] = useState(false);

  useEffect(() => {
    if (!deviceManagerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeviceManagerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deviceManagerOpen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">A</div>
        <div className="brand-copy"><strong>{t("appName")}</strong><span>{t("mobile")}</span></div>
        <button
          className="device-manager-button"
          type="button"
          aria-label={t("hosts.manage")}
          aria-haspopup="dialog"
          aria-expanded={deviceManagerOpen}
          onClick={() => setDeviceManagerOpen(true)}
        >
          <span aria-hidden="true">▣</span>
        </button>
      </header>

      <main className={`main-content${selectedSession ? " session-is-open" : ""}`} id="main-content">
        {selectedSession ? (
          <SessionWorkspace
            key={`${selectedSession.hostProfileId}:${selectedSession.session.id}`}
            open={selectedSession}
            client={client}
            onClose={() => setSelectedSession(undefined)}
            onSessionChanged={setSelectedSession}
          />
        ) : (
          <SessionDashboard client={client} onOpenSession={setSelectedSession} />
        )}
      </main>

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
