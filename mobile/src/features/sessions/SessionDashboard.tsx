import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useId, useRef, useState, type CSSProperties } from "react";
import { AgentPortMark } from "../../components/AgentPortMark";
import { SessionRowActions } from "./SessionRowActions";
import { useForegroundRecovery } from "../../protocol/useForegroundRecovery";
import { remoteErrorMessage } from "../../protocol/remoteError";
import { useAttentionInbox } from "./useAttentionInbox";
import { RecentNotifications } from "./RecentNotifications";
import type { InboxEntry } from "./attentionInbox";
import { SessionStateBadge } from "./SessionStateBadge";
import { AgentIcon, hasAgentIcon } from "../../components/AgentIcons";
import { Modal } from "../../components/Modal";
import "./dashboard.css";
import { useTranslation } from "react-i18next";
import type { ConnectionState, HostProfileSummary, RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import { activeAgentSessions, orderedVisibleAgents, quickStartParams, type SessionLayout } from "./sessionModel";
import type { AgentPreferences, OpenSession, ProjectSummary, SessionSummary, SupportedAgent } from "./types";

const DEVICE_KEY = "agentport-mobile-v2:selected-device";
const WORKSPACE_PREFIX = "agentport-mobile-v2:workspace:";

interface DeviceSnapshot {
  deviceId: string;
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

const errorText = remoteErrorMessage;

function sessionTime(session: SessionSummary): number {
  const parsed = Date.parse(session.latestStatus?.occurredAt ?? session.updatedAt ?? session.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
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
    folder: <path d="M5.2 6.8h5.3l1.6 2h6.7a1.6 1.6 0 0 1 1.6 1.6v7a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6V8.4a1.6 1.6 0 0 1 1.6-1.6Z" />,
    chevron: <path d="m9 6 6 6-6 6" />,
  } as const;
  return <svg className={`ui-icon ui-icon-${name}`} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function projectTone(id: string): number {
  return [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 6;
}

function AgentGlyph({ agent }: { agent: string }) {
  if (hasAgentIcon(agent)) {
    return <AgentIcon agent={agent} className="agent-picker-glyph" size={agent === "easy_pi" ? 38 : 30} mono />;
  }
  return <svg className="agent-picker-glyph" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="m5 6 6 6-6 6m8 0h6" />
  </svg>;
}

function SessionRow({ session, unread, host, stale, onOpen, onActions }: {
  session: SessionSummary;
  unread: boolean;
  host: HostProfileSummary;
  stale?: boolean;
  onOpen: () => void;
  onActions: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const press = useRef<{ x: number; y: number; timer: number }>();
  const consumed = useRef(false);
  const cancelPress = () => { window.clearTimeout(press.current?.timer); press.current = undefined; };
  useEffect(() => cancelPress, []);
  const disabled = Boolean(session.archivedAt) || host.connectionState !== "connected";
  return (
    <li className={`v2-session-row${unread ? " has-unread" : ""}`}>
      <button type="button" data-session-id={session.id} disabled={disabled}
        onPointerDown={event => {
          cancelPress(); consumed.current = false;
          if (event.button !== 0 || disabled) return;
          press.current = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => { consumed.current = true; cancelPress(); onActions(); }, 500) };
        }}
        onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress(); }}
        onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
        onContextMenu={event => { event.preventDefault(); cancelPress(); consumed.current = true; onActions(); }}
        onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); cancelPress(); onActions(); } }}
        onClick={() => { if (consumed.current) { consumed.current = false; return; } onOpen(); }} aria-labelledby={`${id}-title`} aria-describedby={`${id}-status`}>
        <span className="session-row-copy">
          <span id={`${id}-status`} className="session-row-status"><SessionStateBadge session={session} stale={stale || host.connectionState !== "connected"} /></span>
          <strong id={`${id}-title`}>{session.title}</strong>
          {unread ? <span className="session-unread" role="img" aria-label={t("dashboard.unread")}><span aria-hidden="true" /></span> : null}
        </span>
        <time dateTime={session.updatedAt}>{relativeTime(session.updatedAt)}</time>
      </button>
    </li>
  );
}

const EMPTY_SESSIONS: SessionSummary[] = [];

// Project disclosure and toolbar changes do not change the Session rows.
// Keep their event handlers and list identity stable instead of rendering every
// row in every project for those local UI-only updates.
const SessionRows = memo(function SessionRows({ sessions, unreadSessionIds, host, stale, onOpen, onActions }: {
  sessions: SessionSummary[];
  unreadSessionIds: ReadonlySet<string>;
  host: HostProfileSummary;
  stale?: boolean;
  onOpen: (session: SessionSummary) => void;
  onActions: (session: SessionSummary) => void;
}) {
  return <>{sessions.map(session => <SessionRow key={session.id} session={session} unread={unreadSessionIds.has(session.id)} host={host} stale={stale}
    onOpen={() => onOpen(session)} onActions={() => onActions(session)} />)}</>;
});

export function SessionDashboard({ client, onOpenSession, onManageDevices, onOpenSettings, openedSession, hostProfilesEpoch = 0, preferredHostId, active: dashboardActive = true }: {
  client: RemoteClient;
  hostProfilesEpoch?: number;
  preferredHostId?: string;
  active?: boolean;
  onOpenSession: (session: OpenSession) => void;
  onManageDevices?: () => void;
  onOpenSettings?: () => void;
  openedSession?: { open: OpenSession; token: number };
}) {
  const { t } = useTranslation();
  const [openingRecent, setOpeningRecent] = useState<string>();
  const recentOpening = useRef(false);
  const [rowActions, setRowActions] = useState<{ hostId: string; session: SessionSummary }>();
  const [removingSessions, setRemovingSessions] = useState<string[]>([]);
  const refreshEpoch = useRef(0);
  const refreshes = useRef(new Map<string, { again: boolean; promise: Promise<void> }>());
  const manualUpdates = useRef(new Set<string>());
  const recoveringDevice = useRef<string>();
  const [recoveringHost, setRecoveringHost] = useState<string>();
  const [updatingHosts, setUpdatingHosts] = useState(new Set<string>());
  const [updateErrorHost, setUpdateErrorHost] = useState<string>();
  const connectionEvents = useRef(new Map<string, RemoteConnectionStateEvent>());
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== "hidden");
  const visible = dashboardActive && pageVisible;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
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
  const mounted = useRef(true);
  const dashboardRef = useRef<HTMLElement>(null);
  const pendingScroll = useRef<{ deviceId: string; top: number }>();
  const snapshotRef = useRef<DeviceSnapshot>();
  const workspaceRef = useRef(workspace);
  snapshotRef.current = snapshot;
  workspaceRef.current = workspace;

  const selectedHost = hosts.find((host) => host.id === selectedDeviceId);
  const { entries: recent, error: notificationError, acknowledge, clearAll } = useAttentionInbox(client, hosts.map(host => host.id === recoveringHost
    ? { ...host, connectionState: "reconnecting" as const } : host), pageVisible);
  const updateBusy = recoveringHost === selectedDeviceId || updatingHosts.has(selectedDeviceId) || selectedHost?.connectionState === "connecting" || selectedHost?.connectionState === "reconnecting";
  const updateFailed = Boolean(snapshot?.error || updateErrorHost === selectedDeviceId);

  const refreshDeviceOnce = useCallback(async (deviceId: string) => {
    if (!deviceId || recoveringDevice.current === deviceId) return;
    const epoch = ++refreshEpoch.current;
    const sessionsRequest = client.request<SessionSummary[]>(deviceId, "session.list", { includeArchived: false });
    const metadataRequest = Promise.all([
      client.request<ProjectSummary[]>(deviceId, "project.list", {}),
      client.request<SupportedAgent[]>(deviceId, "agent.supported", {}),
      client.request<AgentPreferences>(deviceId, "agent.preferences", {}),
    ]).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    try {
      const sessions = await sessionsRequest;
      if (!mounted.current || deviceId !== selectedDeviceRef.current || epoch !== refreshEpoch.current) return;
      setSnapshot((current) => ({
        deviceId,
        sessions,
        projects: current?.deviceId === deviceId ? current.projects : [],
        agents: current?.deviceId === deviceId ? current.agents : [],
        preferences: current?.deviceId === deviceId ? current.preferences : undefined,
        cached: false,
      }));
      setUpdateErrorHost(current => current === deviceId ? undefined : current);
      const metadata = await metadataRequest;
      if (!metadata.ok) throw metadata.error;
      if (!mounted.current || deviceId !== selectedDeviceRef.current || epoch !== refreshEpoch.current) return;
      const [projects, agents, preferences] = metadata.value;
      setSnapshot({ deviceId, sessions, projects, agents, preferences, cached: false });
    } catch (error) {
      if (!mounted.current || deviceId !== selectedDeviceRef.current || epoch !== refreshEpoch.current) return;
      setSnapshot((current) => ({
        deviceId,
        sessions: current?.deviceId === deviceId ? current.sessions : [],
        projects: current?.deviceId === deviceId ? current.projects : [],
        agents: current?.deviceId === deviceId ? current.agents : [],
        preferences: current?.deviceId === deviceId ? current.preferences : undefined,
        cached: true,
        error: errorText(error),
      }));
    }
  }, [client]);

  const refreshDevice = useCallback((deviceId: string, afterPending = true): Promise<void> => {
    const existing = refreshes.current.get(deviceId);
    if (existing) {
      // Timer ticks share the current read. Explicit refresh/mutation/reconnect
      // requests need one trailing read, since the current snapshot may predate them.
      existing.again ||= afterPending;
      return existing.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      do {
        entry.again = false;
        await refreshDeviceOnce(deviceId);
      } while (entry.again && mounted.current && deviceId === selectedDeviceRef.current);
    })().finally(() => { refreshes.current.delete(deviceId); });
    refreshes.current.set(deviceId, entry);
    return entry.promise;
  }, [refreshDeviceOnce]);

  useForegroundRecovery(client, selectedDeviceId,
    dashboardActive && Boolean(selectedHost) && (recoveringDevice.current === selectedDeviceId || selectedHost?.connectionState !== "disconnected"), {
      onChecking: () => {
        // Invalidate old reads before foreground effects can submit new ones.
        refreshEpoch.current += 1;
        recoveringDevice.current = selectedDeviceId;
        setRecoveringHost(selectedDeviceId);
        setUpdateErrorHost(undefined);
        setSnapshot(current => current ? { ...current, error: undefined } : current);
      },
      onStart: () => setSnapshot(current => current ? { ...current, cached: true } : current),
      onRecovered: () => {
        recoveringDevice.current = undefined;
        setRecoveringHost(undefined);
        void refreshDevice(selectedDeviceId);
      },
      onError: () => {
        recoveringDevice.current = undefined;
        setRecoveringHost(undefined);
        connectionEvents.current.set(selectedDeviceId, { profileId: selectedDeviceId, state: "failed" });
        setHosts(current => current.map(host => host.id === selectedDeviceId ? { ...host, connectionState: "failed" } : host));
        setUpdateErrorHost(selectedDeviceId);
      },
    });

  // One explicit action: connected -> read; offline -> connect then read.
  // Keep the lock in a ref so repeated taps cannot race React's next render.
  const updateSelectedDevice = async () => {
    const deviceId = selectedDeviceId;
    const before = connectionEvents.current.get(deviceId);
    const phase = before?.state ?? selectedHost?.connectionState;
    if (!selectedHost || recoveringDevice.current === deviceId || manualUpdates.current.has(deviceId) || phase === "connecting" || phase === "reconnecting") return;
    manualUpdates.current.add(deviceId);
    setUpdatingHosts(new Set(manualUpdates.current));
    setUpdateErrorHost(undefined);
    try {
      if (phase !== "connected") {
        await client.connect(deviceId);
        if (!mounted.current) return;
        const after = connectionEvents.current.get(deviceId);
        // An older connect reply cannot overwrite a newer transport failure.
        if (after && after !== before && after.state !== "connected" && after.state !== "connecting") throw new Error("Connection changed during update");
        connectionEvents.current.set(deviceId, { profileId: deviceId, state: "connected" });
        setHosts(current => current.map(host => host.id === deviceId ? { ...host, connectionState: "connected" } : host));
      }
      if (mounted.current && selectedDeviceRef.current === deviceId) await refreshDevice(deviceId, false);
    } catch {
      if (!mounted.current) return;
      const latest = connectionEvents.current.get(deviceId);
      // A rejected connect must release the spinner even if the platform did
      // not deliver its final failed event. Preserve any newer terminal state.
      if (phase !== "connected" && (!latest || latest === before || latest.state === "connecting")) {
        connectionEvents.current.set(deviceId, { profileId: deviceId, state: "failed" });
        setHosts(current => current.map(host => host.id === deviceId ? { ...host, connectionState: "failed" } : host));
      }
      if (selectedDeviceRef.current === deviceId) setUpdateErrorHost(deviceId);
    } finally {
      manualUpdates.current.delete(deviceId);
      if (mounted.current) setUpdatingHosts(new Set(manualUpdates.current));
    }
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let unsubscribe: (() => Promise<void>) | undefined;
    const phases = new Map<string, ConnectionState>();
    connectionEvents.current.clear();
    void client.onConnectionState(event => {
      if (cancelled) return;
      phases.set(event.profileId, event.state);
      connectionEvents.current.set(event.profileId, event);
      setHosts(current => current.map(host => host.id === event.profileId ? { ...host, connectionState: event.state } : host));
    }).then(value => { if (cancelled) void value(); else unsubscribe = value; });
    void client.listHostProfiles().then(profiles => {
      if (cancelled) return;
      setHosts(profiles.map(profile => ({ ...profile, connectionState: phases.get(profile.id) ?? profile.connectionState })));
      setSelectedDeviceId(current => preferredHostId && profiles.some(profile => profile.id === preferredHostId)
        ? preferredHostId : profiles.some(profile => profile.id === current) ? current : profiles[0]?.id ?? "");
    }).catch(error => { if (!cancelled) setActionError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; if (unsubscribe) void unsubscribe(); };
  }, [client, hostProfilesEpoch, preferredHostId]);

  useEffect(() => {
    if (!selectedDeviceId) {
      setSnapshot(undefined);
      setWorkspace(emptyWorkspace());
      return;
    }
    try { localStorage.setItem(DEVICE_KEY, selectedDeviceId); } catch { /* selection persistence is best effort */ }
    const restored = readWorkspace(selectedDeviceId);
    setWorkspace(restored);
    pendingScroll.current = { deviceId: selectedDeviceId, top: restored.scrollTop };
    const scroller = dashboardRef.current?.closest<HTMLElement>(".main-content");
    if (scroller) scroller.scrollTop = 0;
    setSnapshot(undefined);
    recoveringDevice.current = undefined;
    setRecoveringHost(undefined);
    setUpdateErrorHost(undefined);
    setRowActions(undefined);
  }, [selectedDeviceId]);

  useEffect(() => {
    if (selectedHost?.connectionState === "connected") {
      if (visible && !manualUpdates.current.has(selectedDeviceId)) void refreshDevice(selectedDeviceId);
    } else setSnapshot(current => current ? { ...current, cached: true } : current);
  }, [selectedDeviceId, selectedHost?.connectionState, refreshDevice, visible]);

  useEffect(() => {
    const opened = openedSession?.open;
    const status = opened?.session.latestStatus;
    if (opened && status) acknowledge(opened.hostProfileId, opened.session.id, status);
  }, [openedSession, acknowledge]);

  // Restore only once the matching device's rows are committed. Restoring on
  // device selection would clamp against the empty/loading list. No queued RAF
  // may later apply an old device's offset to the new device.
  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    const scroller = dashboardRef.current?.closest<HTMLElement>(".main-content");
    if (!scroller || !pending || pending.deviceId !== selectedDeviceId || snapshot?.deviceId !== selectedDeviceId) return;
    scroller.scrollTop = pending.top;
    pendingScroll.current = undefined;
  }, [selectedDeviceId, snapshot]);

  useEffect(() => {
    // Capture the node while mounted: React may detach the ref before cleanup.
    const scroller = dashboardRef.current?.closest<HTMLElement>(".main-content");
    return () => {
      const pending = pendingScroll.current;
      if (selectedDeviceId) persistWorkspace(selectedDeviceId, {
        ...workspaceRef.current, recentOpen: false,
        scrollTop: pending?.deviceId === selectedDeviceId ? pending.top : scroller?.scrollTop ?? 0,
      });
    };
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!visible || !selectedDeviceId || selectedHost?.connectionState !== "connected") return;
    const timer = window.setInterval(() => void refreshDevice(selectedDeviceId, false), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshDevice, selectedDeviceId, selectedHost?.connectionState, visible]);

  const updateWorkspace = useCallback((next: PersistedWorkspace) => {
    setWorkspace(next);
    if (selectedDeviceId) persistWorkspace(selectedDeviceId, next);
  }, [selectedDeviceId]);

  // Mobile receipts belong to this phone, not the shared desktop unread bit.
  // Use the same durable inbox as Recent so old server snapshots cannot relight
  // an acknowledged row, while a newer attention event can.
  // A value-stable key preserves memoized rows when inbox polling publishes
  // unchanged entries. Keep the original Session objects and lists intact.
  const unreadSessionKey = JSON.stringify(recent
    .filter(entry => entry.hostId === snapshot?.deviceId).map(entry => entry.sessionId).sort());
  const unreadSessionIds = useMemo(() => new Set<string>(JSON.parse(unreadSessionKey)), [unreadSessionKey]);
  const sessions = useMemo(() => snapshot?.sessions.filter(session => !session.archivedAt
    && !removingSessions.includes(JSON.stringify([snapshot.deviceId, session.id]))) ?? EMPTY_SESSIONS,
  [snapshot?.sessions, snapshot?.deviceId, removingSessions]);
  const sessionsByProject = useMemo(() => {
    const grouped = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      const group = grouped.get(session.projectId);
      if (group) group.push(session); else grouped.set(session.projectId, [session]);
    }
    for (const group of grouped.values()) group.sort((a, b) => sessionTime(b) - sessionTime(a));
    return grouped;
  }, [sessions]);
  const active = useMemo(() => activeAgentSessions(sessions), [sessions]);
  const agents = useMemo(() => orderedVisibleAgents(snapshot?.agents ?? [], snapshot?.preferences), [snapshot?.agents, snapshot?.preferences]);
  const projects = useMemo(() => {
    const known = new Map((snapshot?.projects ?? []).map((project) => [project.id, project]));
    for (const session of sessions) {
      if (!known.has(session.projectId)) known.set(session.projectId, { id: session.projectId, name: session.projectId, rootPath: session.cwd, pinned: false, sortOrder: Number.MAX_SAFE_INTEGER });
    }
    return [...known.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }, [sessions, snapshot?.projects]);

  const open = useCallback((session: SessionSummary) => {
    if (!selectedHost) return;
    updateWorkspace({ ...workspaceRef.current, recentOpen: false });
    onOpenSession({
      hostProfileId: selectedHost.id,
      hostName: selectedHost.name,
      projectName: projects.find((project) => project.id === session.projectId)?.name,
      session,
    });
  }, [selectedHost, projects, updateWorkspace, onOpenSession]);

  const dismissRecent = useCallback((entry: InboxEntry) => acknowledge(entry.hostId, entry.sessionId, entry), [acknowledge]);
  const openRecent = useCallback(async (entry: InboxEntry) => {
    const host = hosts.find(item => item.id === entry.hostId);
    if (!host || host.connectionState !== "connected" || recentOpening.current) return;
    recentOpening.current = true;
    setOpeningRecent(`${entry.hostId}:${entry.sessionId}`);
    try {
      const current = await client.request<SessionSummary[]>(entry.hostId, "session.list", { includeArchived: false });
      if (!mounted.current || !workspaceRef.current.recentOpen) return;
      const session = current.find(item => item.id === entry.sessionId);
      if (!session) return; // Keep the notification dismissible without an unavailable-Session warning.
      onOpenSession({ hostProfileId: host.id, hostName: host.name, session });
      updateWorkspace({ ...workspaceRef.current, recentOpen: false });
    } catch (failure) { if (mounted.current) setActionError(errorText(failure)); }
    finally { recentOpening.current = false; if (mounted.current) setOpeningRecent(undefined); }
  }, [client, hosts, onOpenSession, updateWorkspace]);

  const showSessionActions = useCallback((session: SessionSummary) => {
    updateWorkspace({ ...workspaceRef.current, recentOpen: false });
    setRowActions({ hostId: selectedDeviceId, session });
  }, [selectedDeviceId, updateWorkspace]);

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
    <section ref={dashboardRef} className="session-dashboard mobile-session-sidebar" aria-labelledby="dashboard-title">
      <h1 className="visually-hidden" id="dashboard-title">{t("dashboard.title")}</h1>
      <header className="mobile-sidebar-toolbar">
        <button type="button" className="toolbar-icon-button" style={{ "--toolbar-color": "#a8b8ff" } as CSSProperties} onClick={onManageDevices} aria-label={t("hosts.manage")} aria-haspopup="dialog">
          <Icon name="computer" />
        </button>
        <label className="compact-device-picker">
          <span className={`device-state ${selectedHost?.connectionState ?? "disconnected"}`} aria-hidden="true" />
          <select value={selectedDeviceId} onChange={(event) => {
            closePicker();
            selectedDeviceRef.current = event.target.value;
            setSelectedDeviceId(event.target.value);
          }} aria-label={t("dashboard.currentDevice")}>
            {hosts.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
          </select>
        </label>
        <span className="toolbar-spacer" />
        <button type="button" className="toolbar-icon-button" style={{ "--toolbar-color": "#f7c66a" } as CSSProperties} disabled={!selectedHost} onClick={() => updateWorkspace({ ...workspace, recentOpen: true })} aria-label={t("dashboard.recent")}><Icon name="clock" />{recent.length > 0 ? <span className="toolbar-attention" aria-hidden="true" /> : null}</button>
        <button type="button" className="toolbar-icon-button toolbar-refresh" style={{ "--toolbar-color": "#71e6d1" } as CSSProperties} disabled={!selectedDeviceId || updateBusy} aria-busy={updateBusy} onClick={() => void updateSelectedDevice()} aria-label={t("dashboard.refresh")}><Icon name="refresh" /></button>
        <button
          type="button"
          className={`toolbar-icon-button activity-toggle${workspace.layout === "active" ? " is-active" : ""}`}
          style={{ "--toolbar-color": "#d7a0e8" } as CSSProperties}
          aria-label={workspace.layout === "projects" ? t("dashboard.showActivity") : t("dashboard.showProjects")}
          aria-pressed={workspace.layout === "active"}
          onClick={() => updateWorkspace({ ...workspace, layout: workspace.layout === "projects" ? "active" : "projects" })}
        >
          <Icon name="bell" />
        </button>
        <button type="button" className="toolbar-icon-button" style={{ "--toolbar-color": "#9fd88c" } as CSSProperties} onClick={onOpenSettings} disabled={!onOpenSettings} aria-label={t("settings.title", { defaultValue: "Settings" })} aria-haspopup="dialog"><Icon name="settings" /></button>
      </header>

      <div className="visually-hidden" aria-live="polite">
        <strong>{workspace.layout === "projects" ? t("dashboard.projects") : t("dashboard.activity")}</strong>
        <span>{workspace.layout === "projects" ? sessions.length : active.length}</span>
      </div>

      {loading ? <div className="state-card" role="status">{t("dashboard.loading")}</div> : null}
      {!loading && hosts.length === 0 ? <div className="state-card" role="status">{t("dashboard.noHosts")}</div> : null}
      {selectedHost && selectedHost.connectionState !== "connected" && !updateFailed && !updateBusy ? <div className="state-note" role="status">{t(`status.${selectedHost.connectionState as ConnectionState}`)} — {t("dashboard.cached")}</div> : null}
      {updateFailed && !updateBusy ? <p className="dashboard-refresh-error" role="alert"><button type="button" onClick={() => void updateSelectedDevice()}>{t("dashboard.updateFailed")}</button></p> : null}
      {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
      {notificationError && !recoveringHost ? <p className="state-note" role="status">{notificationError}</p> : null}

      {workspace.layout === "projects" ? <div className="project-session-list dense-project-tree">
        {projects.map((project) => {
          const projectSessions = sessionsByProject.get(project.id) ?? EMPTY_SESSIONS;
          const expanded = workspace.projectExpansionInitialized
            ? workspace.expandedProjects.includes(project.id)
            : true;
          return <section className="project-group" data-project-tone={projectTone(project.id)} key={project.id}>
            <header>
              <button type="button" className="project-toggle" aria-expanded={expanded} onClick={() => toggleProject(project.id)}><Icon name="folder" /><strong>{project.name}</strong></button>
              <button type="button" className="project-launch-button" aria-haspopup="dialog" aria-label={t("dashboard.launchIn", { defaultValue: "Start agent in {{project}}", project: project.name })} onClick={() => {
                const target = { hostId: selectedDeviceId, project };
                pickerRef.current = target;
                setPicker(target);
                setLaunchError("");
                setCreatedSessionId(undefined);
              }}><AgentPortMark /></button>
            </header>
            <div className={`project-content${expanded ? " is-expanded" : ""}`} aria-hidden={!expanded} {...(expanded ? {} : { inert: "" })}><div><ul className="v2-session-list"><SessionRows sessions={projectSessions} unreadSessionIds={unreadSessionIds} host={selectedHost!} stale={snapshot?.cached} onOpen={open} onActions={showSessionActions} /></ul></div></div>
          </section>;
        })}
      </div> : <div className="activity-session-view"><ul className="v2-session-list active-agent-list"><SessionRows sessions={active} unreadSessionIds={unreadSessionIds} host={selectedHost!} stale={snapshot?.cached} onOpen={open} onActions={showSessionActions} /></ul>{snapshot && active.length === 0 ? <div className="compact-empty" role="status">{t("dashboard.noActivity")}</div> : null}</div>}

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

      {rowActions && rowActions.hostId === selectedDeviceId ? <SessionRowActions
        key={JSON.stringify([rowActions.hostId, rowActions.session.id])}
        session={rowActions.session} hostId={rowActions.hostId} client={client}
        onClose={() => setRowActions(current => current?.hostId === rowActions.hostId && current.session.id === rowActions.session.id ? undefined : current)}
        onChanged={() => refreshDevice(rowActions.hostId)}
        onRemovalPending={pending => {
          const key = JSON.stringify([rowActions.hostId, rowActions.session.id]);
          setRemovingSessions(current => pending ? [...new Set([...current, key])] : current.filter(value => value !== key));
        }}
        onRemovalError={message => setActionError(`${rowActions.session.title}: ${message}`)}
      /> : null}

      {workspace.recentOpen ? <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) updateWorkspace({ ...workspace, recentOpen: false }); }}>
        <section className="modal-sheet recent-sheet" role="dialog" aria-modal="true" aria-labelledby="recent-title">
          <header><h2 id="recent-title">{t("dashboard.recent")}</h2><div className="recent-header-actions">
            <button type="button" className="recent-clear-all" disabled={recent.length === 0} onClick={clearAll}>{t("dashboard.clearRecent")}</button>
            <button type="button" aria-label={t("common.close")} onClick={() => updateWorkspace({ ...workspace, recentOpen: false })}>×</button>
          </div></header>
          {recent.length === 0 ? <p role="status">{t("dashboard.noRecent")}</p> : null}
          <RecentNotifications entries={recent} hosts={hosts} opening={openingRecent} onOpen={openRecent} onDismiss={dismissRecent} />
        </section>
      </div> : null}
    </section>
  );
}
