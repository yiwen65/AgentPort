import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentIcon } from "../../components/AgentIcons";
import { Modal } from "../../components/Modal";
import "./dashboard.css";
import { useTranslation } from "react-i18next";
import type { ConnectionState, HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import { deliverAttentionNotifications, SystemNotificationSink } from "./attentionNotifications";
import { activeAgentSessions, orderedVisibleAgents, quickStartParams, statusClass, type SessionLayout } from "./sessionModel";
import type { AgentPreferences, AttentionCursor, AttentionPollResult, OpenSession, ProjectSummary, SessionSummary, SupportedAgent } from "./types";

const DEVICE_KEY = "agentport-mobile-v2:selected-device";
const WORKSPACE_PREFIX = "agentport-mobile-v2:workspace:";
const ATTENTION_CURSOR_PREFIX = "agentport-mobile-v2:attention-cursor:";
const ATTENTION_SEEDED_PREFIX = "agentport-mobile-v2:attention-seeded:";

interface DeviceSnapshot {
  sessions: SessionSummary[];
  projects: ProjectSummary[];
  agents: SupportedAgent[];
  preferences?: AgentPreferences;
  cached: boolean;
  error?: string;
}

interface PersistedWorkspace {
  layout: SessionLayout;
  expandedProjects: string[];
  projectExpansionInitialized: boolean;
  recentOpen: boolean;
  scrollTop: number;
}

const emptyWorkspace = (): PersistedWorkspace => ({
  layout: "projects",
  expandedProjects: [],
  projectExpansionInitialized: false,
  recentOpen: false,
  scrollTop: 0,
});

function workspaceKey(deviceId: string) {
  return `${WORKSPACE_PREFIX}${deviceId}`;
}

function readWorkspace(deviceId: string): PersistedWorkspace {
  try {
    const value = JSON.parse(localStorage.getItem(workspaceKey(deviceId)) ?? "null") as Partial<PersistedWorkspace> | null;
    const expandedProjects = Array.isArray(value?.expandedProjects)
      ? value.expandedProjects.filter((item): item is string => typeof item === "string")
      : [];
    return {
      layout: value?.layout === "active" ? "active" : "projects",
      expandedProjects,
      projectExpansionInitialized: value?.projectExpansionInitialized === true || expandedProjects.length > 0,
      recentOpen: value?.recentOpen === true,
      scrollTop: typeof value?.scrollTop === "number" && value.scrollTop >= 0 ? value.scrollTop : 0,
    };
  } catch {
    return emptyWorkspace();
  }
}

function persistWorkspace(deviceId: string, value: PersistedWorkspace) {
  try { localStorage.setItem(workspaceKey(deviceId), JSON.stringify(value)); } catch { /* device UI state is best effort */ }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function sessionTime(session: SessionSummary): number {
  const parsed = Date.parse(session.latestStatus?.occurredAt ?? session.updatedAt ?? session.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function stateLabel(session: SessionSummary): string {
  return session.latestStatus?.state ?? session.lifecycle;
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 100) return `${days}d`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Icon({ name }: { name: "computer" | "bell" | "refresh" | "clock" | "folder" | "chevron" | "settings" }) {
  const paths = {
    settings: <><circle cx="12" cy="12" r="3" /><path d="m9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3z" /></>,
    computer: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8M12 18v3" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18.5 10a7 7 0 0 0-12-3L4 9M5.5 14a7 7 0 0 0 12 3l2.5-2" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    folder: <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    chevron: <path d="m9 6 6 6-6 6" />,
  } as const;
  return <svg className={`ui-icon ui-icon-${name}`} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function AgentGlyph({ agent }: { agent: string }) {
  if (["pi", "codex", "claude", "kimi", "qoder"].includes(agent)) {
    return <AgentIcon agent={agent} className="agent-picker-glyph" size={30} mono />;
  }
  return <svg className="agent-picker-glyph" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 6 6 6-6 6m8 0h6" />
  </svg>;
}

function SessionRow({ session, host, onOpen }: {
  session: SessionSummary;
  host: HostProfileSummary;
  onOpen: () => void;
}) {
  const disabled = Boolean(session.archivedAt) || host.connectionState !== "connected";
  return (
    <li className="v2-session-row">
      <span className={`session-status-dot ${statusClass(session)}`} role="img" aria-label={stateLabel(session)} />
      <button type="button" data-session-id={session.id} disabled={disabled} onClick={onOpen} aria-label={`${session.title}, ${stateLabel(session)}`}>
        <span><strong>{session.title}</strong><small>{session.adapterType}</small></span>
        <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt)}</time>
      </button>
      {session.unreadAttention ? <span className="attention-mark" aria-label="unread attention">•</span> : null}
    </li>
  );
}

export function SessionDashboard({ client, onOpenSession, onManageDevices, onOpenSettings }: {
  client: RemoteClient;
  onOpenSession: (session: OpenSession) => void;
  onManageDevices?: () => void;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostProfileSummary[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    try { return localStorage.getItem(DEVICE_KEY) ?? ""; } catch { return ""; }
  });
  const [snapshot, setSnapshot] = useState<DeviceSnapshot>();
  const [workspace, setWorkspace] = useState<PersistedWorkspace>(emptyWorkspace);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState<string>();
  const [picker, setPicker] = useState<{ hostId: string; project: ProjectSummary }>();
  const pickerRef = useRef(picker);
  const launchBusy = useRef(false);
  const [launchError, setLaunchError] = useState("");
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  const selectedDeviceRef = useRef(selectedDeviceId);
  selectedDeviceRef.current = selectedDeviceId;
  pickerRef.current = picker;
  const [actionError, setActionError] = useState("");
  const [notificationError, setNotificationError] = useState("");
  const mounted = useRef(true);
  const attentionCursor = useRef<AttentionCursor>();
  const attentionSeeded = useRef(false);
  const deliveredAttention = useRef(new Set<string>());
  const notificationSink = useRef(new SystemNotificationSink());
  const snapshotRef = useRef<DeviceSnapshot>();
  const workspaceRef = useRef(workspace);
  snapshotRef.current = snapshot;
  workspaceRef.current = workspace;

  const selectedHost = hosts.find((host) => host.id === selectedDeviceId);

  const refreshDevice = useCallback(async (deviceId: string) => {
    if (!deviceId) return;
    try {
      const [sessions, projects, agents, preferences] = await Promise.all([
        client.request<SessionSummary[]>(deviceId, "session.list", { includeArchived: false }),
        client.request<ProjectSummary[]>(deviceId, "project.list", {}),
        client.request<SupportedAgent[]>(deviceId, "agent.supported", {}),
        client.request<AgentPreferences>(deviceId, "agent.preferences", {}),
      ]);
      if (!mounted.current || deviceId !== selectedDeviceRef.current) return;
      setSnapshot({ sessions, projects, agents, preferences, cached: false });
    } catch (error) {
      if (!mounted.current || deviceId !== selectedDeviceRef.current) return;
      setSnapshot((current) => ({
        sessions: current?.sessions ?? [],
        projects: current?.projects ?? [],
        agents: current?.agents ?? [],
        preferences: current?.preferences,
        cached: true,
        error: errorText(error),
      }));
    }
  }, [client, selectedDeviceId]);

  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => Promise<void>) | undefined;
    void client.listHostProfiles().then((profiles) => {
      if (!mounted.current) return;
      setHosts(profiles);
      setSelectedDeviceId((current) => profiles.some((profile) => profile.id === current) ? current : profiles[0]?.id ?? "");
    }).catch((error) => setActionError(errorText(error))).finally(() => mounted.current && setLoading(false));
    void client.onConnectionState((event) => {
      setHosts((current) => current.map((host) => host.id === event.profileId ? { ...host, connectionState: event.state } : host));
      if (event.profileId === selectedDeviceId && event.state === "connected") void refreshDevice(event.profileId);
      if (event.profileId === selectedDeviceId && event.state !== "connected") setSnapshot((current) => current ? { ...current, cached: true } : current);
    }).then((value) => { if (!mounted.current) void value(); else unsubscribe = value; });
    return () => {
      mounted.current = false;
      if (unsubscribe) void unsubscribe();
    };
  }, [client, refreshDevice, selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setSnapshot(undefined);
      setWorkspace(emptyWorkspace());
      return;
    }
    try { localStorage.setItem(DEVICE_KEY, selectedDeviceId); } catch { /* selection persistence is best effort */ }
    const restored = readWorkspace(selectedDeviceId);
    setWorkspace(restored);
    if (restored.scrollTop > 0) window.requestAnimationFrame(() => window.scrollTo({ top: restored.scrollTop, behavior: "auto" }));
    setSnapshot(undefined);
    const host = hosts.find((candidate) => candidate.id === selectedDeviceId);
    if (host?.connectionState === "connected") void refreshDevice(selectedDeviceId);
  }, [hosts, refreshDevice, selectedDeviceId]);

  useEffect(() => () => {
    if (selectedDeviceId) persistWorkspace(selectedDeviceId, { ...workspaceRef.current, recentOpen: false, scrollTop: window.scrollY });
  }, [selectedDeviceId]);

  useEffect(() => {
    attentionCursor.current = undefined;
    attentionSeeded.current = false;
    deliveredAttention.current.clear();
    if (!selectedDeviceId) return;
    try {
      const stored = localStorage.getItem(`${ATTENTION_CURSOR_PREFIX}${selectedDeviceId}`);
      if (stored) {
        attentionCursor.current = JSON.parse(stored) as AttentionCursor;
        attentionSeeded.current = true;
      } else attentionSeeded.current = localStorage.getItem(`${ATTENTION_SEEDED_PREFIX}${selectedDeviceId}`) === "1";
    } catch { /* invalid cursor safely starts a silent baseline scan */ }
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || selectedHost?.connectionState !== "connected") return;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await client.request<AttentionPollResult>(selectedDeviceId, "attention.poll", { cursor: attentionCursor.current ?? null, limit: 256 });
        const wasSeeded = attentionSeeded.current;
        if (wasSeeded && result.events.length) {
          const titles = new Map((snapshotRef.current?.sessions ?? []).map((session) => [session.id, session.title]));
          await deliverAttentionNotifications(result.events.map((event) => ({
            sessionId: event.sessionId,
            sessionTitle: titles.get(event.sessionId),
            kind: event.kind,
            runId: event.runId,
            runOrdinal: event.cursor.runOrdinal,
            sequence: event.cursor.sequence,
            occurredAt: event.cursor.occurredAt,
          })), deliveredAttention.current, notificationSink.current).catch((error) => setNotificationError(errorText(error)));
        }
        if (result.nextCursor) {
          attentionCursor.current = result.nextCursor;
          try { localStorage.setItem(`${ATTENTION_CURSOR_PREFIX}${selectedDeviceId}`, JSON.stringify(result.nextCursor)); } catch { /* cursor persistence is best effort */ }
        }
        // A new install drains old attention silently in bounded pages. Only
        // after reaching the tail can later events become system notifications.
        if (!wasSeeded && result.events.length < 256) {
          attentionSeeded.current = true;
          try { localStorage.setItem(`${ATTENTION_SEEDED_PREFIX}${selectedDeviceId}`, "1"); } catch { /* best effort */ }
        }
      } catch {
        // Session status refresh remains useful when notification polling is unavailable.
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => window.clearInterval(timer);
  }, [client, selectedDeviceId, selectedHost?.connectionState]);

  useEffect(() => {
    if (!selectedDeviceId || selectedHost?.connectionState !== "connected") return;
    const timer = window.setInterval(() => void refreshDevice(selectedDeviceId), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshDevice, selectedDeviceId, selectedHost?.connectionState]);

  const updateWorkspace = (next: PersistedWorkspace) => {
    setWorkspace(next);
    if (selectedDeviceId) persistWorkspace(selectedDeviceId, next);
  };

  const sessions = snapshot?.sessions.filter((session) => !session.archivedAt) ?? [];
  const active = useMemo(() => activeAgentSessions(sessions), [sessions]);
  const agents = useMemo(() => orderedVisibleAgents(snapshot?.agents ?? [], snapshot?.preferences), [snapshot?.agents, snapshot?.preferences]);
  const projects = useMemo(() => {
    const known = new Map((snapshot?.projects ?? []).map((project) => [project.id, project]));
    for (const session of sessions) {
      if (!known.has(session.projectId)) known.set(session.projectId, { id: session.projectId, name: session.projectId, rootPath: session.cwd, pinned: false, sortOrder: Number.MAX_SAFE_INTEGER });
    }
    return [...known.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [sessions, snapshot?.projects]);
  const recent = useMemo(() => [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a)).slice(0, 12), [sessions]);

  const open = (session: SessionSummary) => {
    if (!selectedHost) return;
    onOpenSession({
      hostProfileId: selectedHost.id,
      hostName: selectedHost.name,
      projectName: projects.find((project) => project.id === session.projectId)?.name,
      session,
    });
  };

  const closePicker = () => {
    pickerRef.current = undefined;
    setPicker(undefined);
  };

  useEffect(() => { closePicker(); }, [selectedDeviceId]);

  const quickLaunch = async (agent: string) => {
    const target = pickerRef.current;
    if (!target || !selectedHost || selectedHost.id !== target.hostId || selectedHost.connectionState !== "connected" || launchBusy.current || createdSessionId) return;
    launchBusy.current = true;
    setLaunching(agent);
    setLaunchError("");
    const host = selectedHost;
    const isCurrent = () => mounted.current && selectedDeviceRef.current === host.id && pickerRef.current === target;
    let created = false;
    try {
      const result = await client.request<{ sessionId: string }>(host.id, "session.create", quickStartParams(target.project.id, agent));
      created = true;
      if (!isCurrent()) return;
      setCreatedSessionId(result.sessionId);
      const latest = await client.request<SessionSummary[]>(host.id, "session.list", { includeArchived: false });
      if (!isCurrent()) return;
      setSnapshot((current) => current ? { ...current, sessions: latest, cached: false, error: undefined } : current);
      const session = latest.find((candidate) => candidate.id === result.sessionId);
      if (session) {
        closePicker();
        onOpenSession({ hostProfileId: host.id, hostName: host.name, projectName: target.project.name, session });
      } else setLaunchError(t("session.createMissing", { defaultValue: "The Session was created, but its latest summary could not be loaded." }));
    } catch (error) {
      if (isCurrent()) setLaunchError(created
        ? t("dashboard.launchCreated", { defaultValue: "Session created. Close this picker and refresh the session list to open it." })
        : t("dashboard.launchFailed", { defaultValue: "Could not start agent: {{error}}", error: errorText(error) }));
    } finally {
      launchBusy.current = false;
      if (mounted.current) setLaunching(undefined);
    }
  };

  const toggleProject = (projectId: string) => {
    const expanded = new Set(workspace.projectExpansionInitialized
      ? workspace.expandedProjects
      : projects.map((project) => project.id));
    if (expanded.has(projectId)) expanded.delete(projectId); else expanded.add(projectId);
    updateWorkspace({ ...workspace, expandedProjects: [...expanded], projectExpansionInitialized: true });
  };

  return (
    <section className="session-dashboard mobile-session-sidebar" aria-labelledby="dashboard-title">
      <h1 className="visually-hidden" id="dashboard-title">{t("dashboard.title")}</h1>
      <header className="mobile-sidebar-toolbar">
        <button type="button" className="toolbar-icon-button" onClick={onManageDevices} aria-label={t("hosts.manage")} aria-haspopup="dialog">
          <Icon name="computer" />
        </button>
        <label className="compact-device-picker">
          <span className={`device-state ${selectedHost?.connectionState ?? "disconnected"}`} aria-hidden="true" />
          <select value={selectedDeviceId} onChange={(event) => {
            if (selectedDeviceId) persistWorkspace(selectedDeviceId, { ...workspaceRef.current, recentOpen: false, scrollTop: window.scrollY });
            closePicker();
            selectedDeviceRef.current = event.target.value;
            setSelectedDeviceId(event.target.value);
          }} aria-label={t("dashboard.currentDevice")}>
            {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
          </select>
        </label>
        <span className="toolbar-spacer" />
        <button type="button" className="toolbar-icon-button" disabled={!selectedHost} onClick={() => updateWorkspace({ ...workspace, recentOpen: true })} aria-label={t("dashboard.recent")}><Icon name="clock" /></button>
        <button type="button" className="toolbar-icon-button" disabled={!selectedDeviceId} onClick={() => void refreshDevice(selectedDeviceId)} aria-label={t("dashboard.refresh")}><Icon name="refresh" /></button>
        <button
          type="button"
          className={`toolbar-icon-button activity-toggle${workspace.layout === "active" ? " is-active" : ""}`}
          aria-label={workspace.layout === "projects" ? t("dashboard.showActivity") : t("dashboard.showProjects")}
          aria-pressed={workspace.layout === "active"}
          onClick={() => updateWorkspace({ ...workspace, layout: workspace.layout === "projects" ? "active" : "projects" })}
        >
          <Icon name="bell" />
          {active.some((session) => session.unreadAttention) ? <span className="toolbar-attention" aria-hidden="true" /> : null}
        </button>
        <button type="button" className="toolbar-icon-button" onClick={onOpenSettings} disabled={!onOpenSettings} aria-label={t("settings.title", { defaultValue: "Settings" })} aria-haspopup="dialog"><Icon name="settings" /></button>
      </header>

      <div className="visually-hidden" aria-live="polite">
        <strong>{workspace.layout === "projects" ? t("dashboard.projects") : t("dashboard.activity")}</strong>
        <span>{workspace.layout === "projects" ? sessions.length : active.length}</span>
      </div>

      {loading ? <div className="state-card" role="status">{t("dashboard.loading")}</div> : null}
      {!loading && hosts.length === 0 ? <div className="state-card" role="status">{t("dashboard.noHosts")}</div> : null}
      {selectedHost && selectedHost.connectionState !== "connected" ? <div className="state-note" role="status">{t(`status.${selectedHost.connectionState as ConnectionState}`)} — {t("dashboard.cached")}</div> : null}
      {snapshot?.error ? <p className="inline-error" role="alert">{snapshot.error}</p> : null}
      {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
      {notificationError ? <p className="state-note" role="status">{notificationError}</p> : null}

      {workspace.layout === "projects" ? <div className="project-session-list dense-project-tree">
        {projects.map((project) => {
          const projectSessions = sessions.filter((session) => session.projectId === project.id).sort((a, b) => sessionTime(b) - sessionTime(a));
          const expanded = workspace.projectExpansionInitialized
            ? workspace.expandedProjects.includes(project.id)
            : true;
          return <section className="project-group" key={project.id}>
            <header>
              <button type="button" className="project-toggle" aria-expanded={expanded} onClick={() => toggleProject(project.id)}><Icon name="chevron" /><Icon name="folder" /><strong>{project.name}</strong></button>
              <button type="button" className="project-launch-button" aria-haspopup="dialog" aria-label={t("dashboard.launchIn", { defaultValue: "Start agent in {{project}}", project: project.name })} onClick={() => {
                const target = { hostId: selectedDeviceId, project };
                pickerRef.current = target;
                setPicker(target);
                setLaunchError("");
                setCreatedSessionId(undefined);
              }}>{t("dashboard.launch", { defaultValue: "Start agent" })}</button>
            </header>
            {expanded ? <ul className="v2-session-list">{projectSessions.map((session) => <SessionRow key={session.id} session={session} host={selectedHost!} onOpen={() => open(session)} />)}</ul> : null}
          </section>;
        })}
      </div> : <div className="activity-session-view"><ul className="v2-session-list active-agent-list">{active.map((session) => <SessionRow key={session.id} session={session} host={selectedHost!} onOpen={() => open(session)} />)}</ul>{snapshot && active.length === 0 ? <div className="compact-empty" role="status">{t("dashboard.noActivity")}</div> : null}</div>}

      {snapshot && sessions.length === 0 ? <div className="state-card" role="status">{t("dashboard.noSessions")}</div> : null}

      {picker && picker.hostId === selectedDeviceId ? <Modal title={t("dashboard.chooseAgent", { defaultValue: "Choose an agent" })} onClose={closePicker} className="agent-picker">
        <p className="agent-picker-project">{t("dashboard.launchTarget", { defaultValue: "Project: {{project}}", project: picker.project.name })}</p>
        {selectedHost?.connectionState !== "connected" ? <p role="status">{t("dashboard.launchOffline", { defaultValue: "Connect this device to start an agent." })}</p> : null}
        {!agents.length ? <p role="status">{t("dashboard.noAgents", { defaultValue: "No visible agents available. Check agent installation and preferences on this device." })}</p> : null}
        {launching ? <p role="status">{t("dashboard.launchBusy", { defaultValue: "Starting agent… You can close this picker; the session will still be created." })}</p> : null}
        {launchError ? <p className="inline-error" role="alert">{launchError}</p> : null}
        <ul className="agent-picker-list" aria-busy={Boolean(launching)}>
          {agents.map((agent) => <li key={agent.agent}><button type="button" data-agent={agent.agent} disabled={Boolean(launching) || Boolean(createdSessionId) || selectedHost?.connectionState !== "connected"} aria-label={t("dashboard.startAgent", { defaultValue: "Start {{agent}} in {{project}}", agent: agent.displayName, project: picker.project.name })} onClick={() => void quickLaunch(agent.agent)}><AgentGlyph agent={agent.agent} /><span className="agent-picker-name">{agent.displayName}</span></button></li>)}
        </ul>
      </Modal> : null}

      {workspace.recentOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) updateWorkspace({ ...workspace, recentOpen: false }); }}>
        <section className="modal-sheet recent-sheet" role="dialog" aria-modal="true" aria-labelledby="recent-title">
          <header><h2 id="recent-title">{t("dashboard.recent")}</h2><button type="button" aria-label={t("common.close")} onClick={() => updateWorkspace({ ...workspace, recentOpen: false })}>×</button></header>
          <ul className="v2-session-list">{recent.map((session) => <SessionRow key={session.id} session={session} host={selectedHost!} onOpen={() => open(session)} />)}</ul>
        </section>
      </div> : null}
    </section>
  );
}
