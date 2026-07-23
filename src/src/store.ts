// Central UI state. A single observable store read via useSyncExternalStore;
// xterm instances themselves live outside React in terminals.ts (they are
// imperative, non-serializable and must survive tab switches).

import { useSyncExternalStore } from "react";
import type {
  AdapterInstall,
  PlatformInfo,
  ProjectView,
  SessionView,
  Settings,
  StatusEventView,
  TimelineData,
  WorktreeStatus,
  RepositoryStatus,
} from "./types";

export interface SessionRuntime {
  attached: boolean;
  attaching: boolean;
  replayDone: boolean;
  detached: boolean;
  status: StatusEventView | null;
  logBytes: number;
  exit: { code: number | null; signal: number | null; groupCleaned: boolean } | null;
  error: string | null;
  hostPid: number | null;
  scrolledUp: boolean;
  /** Set when the read-only history terminal shows a truncated log tail. */
  historyNote: string | null;
}

export function emptyRuntime(): SessionRuntime {
  return {
    attached: false,
    attaching: false,
    replayDone: false,
    detached: false,
    status: null,
    logBytes: 0,
    exit: null,
    error: null,
    hostPid: null,
    scrolledUp: false,
    historyNote: null,
  };
}

export interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  text: string;
}

export interface MenuItem {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  tip?: string;
  separator?: boolean;
  action?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface ConfirmState extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  okLabel?: string;
}

export interface PromptState extends PromptOptions {
  resolve: (v: string | null) => void;
}

export type DialogState =
  | { kind: "newSession"; projectId?: string; worktreeId?: string; agent?: string }
  | { kind: "newWorktree"; projectId: string }
  | { kind: "branchPicker"; projectId: string }
  | { kind: "settings" }
  | { kind: "diagnostics" }
  | { kind: "timeline" }
  | { kind: "palette" }
  | { kind: "search" }
  | { kind: "addProject" }
  | { kind: "export"; sessionId: string; exportKind: "md" | "log" }
  | null;

export type EffectiveTheme = "dark" | "light";

export interface AppState {
  ready: boolean;
  bootError: string | null;
  platform: PlatformInfo | null;
  settings: Settings | null;
  adapters: AdapterInstall[];
  projects: ProjectView[];
  timeline: TimelineData;
  timelineError: string | null;
  secretBackend: string;
  indexState: string;
  exportsDir: string;
  activeSessionId: string | null;
  /** Sessions with a live terminal pane (kept mounted, display:none toggling). */
  attachedIds: string[];
  runtime: Record<string, SessionRuntime>;
  rendererMode: "canvas" | "dom";
  rendererFallbackReason: string | null;
  dialog: DialogState;
  confirm: ConfirmState | null;
  prompt: PromptState | null;
  contextMenu: ContextMenuState | null;
  toasts: Toast[];
  showOnboarding: boolean;
  expandedProjects: Record<string, boolean>;
  activeWorktreeStatus: WorktreeStatus | null;
  /** Last backend-confirmed checkout state keyed by project. */
  repositoryStatuses: Record<string, RepositoryStatus>;
  /** Dismissed "结果尚未提交" notices (sessionId -> status sequence). */
  noticeDismissed: Record<string, number>;
  announcement: string;
  themeEffective: EffectiveTheme;
  reducedMotion: boolean;
  /** Whether the project/session sidebar is hidden for terminal focus. */
  sidebarCollapsed: boolean;
  /** Ephemeral width of the project/session split view in CSS pixels. */
  sidebarWidth: number;
  /** Session IDs mapped to their pin timestamp for this app run. */
  pinnedSessionAt: Record<string, number>;
  /** Terminal search bar visibility for the active session. */
  termSearchOpen: boolean;
  /** Project whose worktree management view replaces the sidebar list. */
  sidebarWorktreeProjectId: string | null;
  /** Worktree to emphasize after navigating here from branch management. */
  highlightedWorktreeId: string | null;
  /** Worktree ids whose session list is collapsed in the management view. */
  collapsedWorktrees: Record<string, boolean>;
}

const initialState: AppState = {
  ready: false,
  bootError: null,
  platform: null,
  settings: null,
  adapters: [],
  projects: [],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
  timelineError: null,
  secretBackend: "unknown",
  indexState: "unknown",
  exportsDir: "",
  activeSessionId: null,
  attachedIds: [],
  runtime: {},
  rendererMode: "canvas",
  rendererFallbackReason: null,
  dialog: null,
  confirm: null,
  prompt: null,
  contextMenu: null,
  toasts: [],
  showOnboarding: false,
  expandedProjects: {},
  activeWorktreeStatus: null,
  repositoryStatuses: {},
  noticeDismissed: {},
  announcement: "",
  themeEffective: "dark",
  reducedMotion: false,
  sidebarCollapsed: false,
  sidebarWidth: 296,
  pinnedSessionAt: {},
  termSearchOpen: false,
  sidebarWorktreeProjectId: null,
  highlightedWorktreeId: null,
  collapsedWorktrees: {},
};

let state = initialState;
const listeners = new Set<() => void>();
let projectsSnapshotRequest = 0;
const repositoryStatusRequests = new Map<string, number>();

function emit() {
  for (const l of listeners) l();
}

export function getState(): AppState {
  return state;
}

export function setState(partial: Partial<AppState>) {
  state = { ...state, ...partial };
  emit();
}

export function update(fn: (s: AppState) => Partial<AppState>) {
  setState(fn(state));
}

/** Issue/order full project-tree reads. Realtime patches invalidate pending reads. */
export function beginProjectsSnapshotRequest(): number {
  projectsSnapshotRequest += 1;
  return projectsSnapshotRequest;
}

export function invalidateProjectsSnapshotRequests() {
  projectsSnapshotRequest += 1;
}

export function isCurrentProjectsSnapshotRequest(request: number): boolean {
  return request === projectsSnapshotRequest;
}

/** Repository probes are independent per project and may race backend events. */
export function beginRepositoryStatusRequest(projectId: string): number {
  const request = (repositoryStatusRequests.get(projectId) ?? 0) + 1;
  repositoryStatusRequests.set(projectId, request);
  return request;
}

export function isCurrentRepositoryStatusRequest(projectId: string, request: number): boolean {
  return repositoryStatusRequests.get(projectId) === request;
}

export function applyRepositoryStatusSnapshot(status: RepositoryStatus) {
  repositoryStatusRequests.set(
    status.projectId,
    (repositoryStatusRequests.get(status.projectId) ?? 0) + 1,
  );
  update((current) => ({
    repositoryStatuses: { ...current.repositoryStatuses, [status.projectId]: status },
  }));
}

export function markRepositoryStatusUnavailable(projectId: string) {
  repositoryStatusRequests.set(projectId, (repositoryStatusRequests.get(projectId) ?? 0) + 1);
  update((current) => {
    const repositoryStatuses = { ...current.repositoryStatuses };
    delete repositoryStatuses[projectId];
    return { repositoryStatuses };
  });
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore(): AppState {
  return useSyncExternalStore(subscribe, getState);
}

// ---------------------------------------------------------------------------
// convenience helpers used across components
// ---------------------------------------------------------------------------

let toastSeq = 1;

export function toast(text: string, kind: Toast["kind"] = "info") {
  const id = toastSeq++;
  update((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  window.setTimeout(() => {
    update((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }, 5200);
}

export function announce(text: string) {
  setState({ announcement: text });
}

export function openDialog(dialog: DialogState) {
  setState({ dialog, contextMenu: null });
}

export function closeDialog() {
  setState({ dialog: null });
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setState({ confirm: { ...opts, resolve } });
  });
}

export function resolveConfirm(ok: boolean) {
  const c = state.confirm;
  setState({ confirm: null });
  c?.resolve(ok);
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    setState({ prompt: { ...opts, resolve } });
  });
}

export function resolvePrompt(value: string | null) {
  const p = state.prompt;
  setState({ prompt: null });
  p?.resolve(value);
}

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  setState({ contextMenu: { x, y, items } });
}

export function closeContextMenu() {
  if (state.contextMenu) setState({ contextMenu: null });
}

/** Drill the sidebar into one project's worktree session management view. */
export function openWorktreeView(projectId: string, highlightWorktreeId: string | null = null) {
  setState({ sidebarWorktreeProjectId: projectId, highlightedWorktreeId: highlightWorktreeId });
}

/** Leave the worktree management view and return to the main session list. */
export function closeWorktreeView() {
  if (state.sidebarWorktreeProjectId) {
    setState({ sidebarWorktreeProjectId: null, highlightedWorktreeId: null });
  }
}

/**
 * A project snapshot may race an already delivered state event. A sequence is
 * only monotonic inside one Host run, so compare the run ordinal first and
 * never let a foreign/same-ordinal run overwrite a known status.
 */
function latestStatus(
  current: StatusEventView | null,
  incoming: StatusEventView | null | undefined,
): StatusEventView | null | undefined {
  if (incoming === undefined) return undefined;
  if (current && incoming === null) return current;
  if (current && incoming) {
    if (incoming.runOrdinal < current.runOrdinal) return current;
    if (incoming.runOrdinal === current.runOrdinal) {
      if (incoming.runId !== current.runId || incoming.sequence < current.sequence) return current;
    }
  }
  return incoming;
}

export function patchRuntime(sessionId: string, patch: Partial<SessionRuntime>) {
  update((s) => {
    const runtime = { ...emptyRuntime(), ...s.runtime[sessionId] };
    const status = latestStatus(runtime.status, patch.status);
    return {
      runtime: {
        ...s.runtime,
        [sessionId]: {
          ...runtime,
          ...patch,
          ...(status === undefined ? {} : { status }),
        },
      },
    };
  });
}

export function getRuntime(sessionId: string): SessionRuntime {
  return { ...emptyRuntime(), ...state.runtime[sessionId] };
}

/** Patch one session inside the project tree (keeps unread/ordering intact). */
export function patchSession(sessionId: string, patch: Partial<SessionView>) {
  invalidateProjectsSnapshotRequests();
  update((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      sessions: p.sessions.map((ses) => {
        if (ses.id !== sessionId) return ses;
        const status = latestStatus(ses.status, patch.status);
        return {
          ...ses,
          ...patch,
          ...(status === undefined ? {} : { status }),
        };
      }),
    })),
  }));
}

function sessionIds(projects: ProjectView[]): Set<string> {
  return new Set(projects.flatMap((project) => project.sessions.map((session) => session.id)));
}

function retainSessionEntries<T>(entries: Record<string, T>, alive: Set<string>): Record<string, T> {
  const removed = Object.keys(entries).filter((sessionId) => !alive.has(sessionId));
  if (removed.length === 0) return entries;
  const next = { ...entries };
  for (const sessionId of removed) delete next[sessionId];
  return next;
}

function retainAttachedIds(ids: string[], alive: Set<string>): string[] {
  const next = ids.filter((sessionId) => alive.has(sessionId));
  return next.length === ids.length ? ids : next;
}

function sessionScopedState(s: AppState, alive: Set<string>): Partial<AppState> {
  const activeSessionId = s.activeSessionId && alive.has(s.activeSessionId) ? s.activeSessionId : null;
  return {
    runtime: retainSessionEntries(s.runtime, alive),
    noticeDismissed: retainSessionEntries(s.noticeDismissed, alive),
    pinnedSessionAt: retainSessionEntries(s.pinnedSessionAt, alive),
    attachedIds: retainAttachedIds(s.attachedIds, alive),
    activeSessionId,
    activeWorktreeStatus: activeSessionId ? s.activeWorktreeStatus : null,
    termSearchOpen: activeSessionId ? s.termSearchOpen : false,
  };
}

/**
 * Replace the backend project snapshot without allowing it to regress a
 * session status already observed through an event stream. This is also the
 * single store-side cleanup point for session-scoped UI caches.
 */
export function applyProjectsSnapshot(projects: ProjectView[]) {
  update((s) => {
    const worktreeIds = new Set(projects.flatMap((p) => p.worktrees.map((w) => w.id)));
    const currentSessions = new Map<string, SessionView>();
    for (const project of s.projects) {
      for (const session of project.sessions) currentSessions.set(session.id, session);
    }
    const nextProjects = projects.map((project) => ({
      ...project,
      sessions: project.sessions.map((session) => {
        const current = currentSessions.get(session.id);
        if (!current) return session;
        return { ...session, status: latestStatus(current.status, session.status) ?? null };
      }),
    }));
    return {
      projects: nextProjects,
      sidebarWorktreeProjectId:
        s.sidebarWorktreeProjectId &&
        nextProjects.some((p) => p.id === s.sidebarWorktreeProjectId)
          ? s.sidebarWorktreeProjectId
          : null,
      collapsedWorktrees: Object.fromEntries(
        Object.entries(s.collapsedWorktrees).filter(([id]) => worktreeIds.has(id)),
      ),
      ...sessionScopedState(s, sessionIds(nextProjects)),
    };
  });
}

/** Remove local state that must not outlive a successfully removed Session. */
export function clearSessionScopedState(sessionId: string) {
  update((s) => {
    const alive = sessionIds(s.projects);
    alive.delete(sessionId);
    return sessionScopedState(s, alive);
  });
}

/** All sessions in sidebar display order — drives ⌘1…9 switching. */
export function flattenSessions(projects: ProjectView[]): SessionView[] {
  const out: SessionView[] = [];
  for (const p of projects) {
    for (const ses of p.sessions) {
      if (!ses.worktreeId) out.push(ses);
    }
    for (const w of p.worktrees) {
      for (const ses of p.sessions) {
        if (ses.worktreeId === w.id) out.push(ses);
      }
    }
  }
  return out;
}

export function findSession(projects: ProjectView[], sessionId: string | null): SessionView | null {
  if (!sessionId) return null;
  for (const p of projects) {
    const hit = p.sessions.find((s) => s.id === sessionId);
    if (hit) return hit;
  }
  return null;
}

export function findProjectOf(projects: ProjectView[], sessionId: string | null) {
  if (!sessionId) return null;
  return projects.find((p) => p.sessions.some((s) => s.id === sessionId)) ?? null;
}
