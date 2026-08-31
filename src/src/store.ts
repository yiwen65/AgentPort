// Central UI state. A single observable store read via useSyncExternalStore;
// xterm instances themselves live outside React in terminals.ts (they are
// imperative, non-serializable and must survive tab switches).

import { useSyncExternalStore } from "react";
import {
  layoutContains,
  orderedLayoutSessionIds,
  persistTerminalLayout,
  prunePaneLayout,
  readPersistedTerminalLayout,
  singletonPaneLayout,
  visiblePaneLayout,
} from "./paneLayout";
import type { PaneLayout, PaneSplitDirection } from "./paneLayout";
import type {
  AdapterInstall,
  PlatformInfo,
  ProjectView,
  SessionView,
  Settings,
  StatusEventView,
  TimelineData,
  RuntimeMessageEnvelope,
  RepositoryStatus,
  GitChangesSnapshot,
  GitCheckoutDescriptor,
  GitCommitDetail,
  GitCommitPatch,
  GitCommitResult,
  GitCommitReview,
  GitContextLocator,
  GitDiffSide,
  GitFileDiff,
  GitHistoryPage,
} from "./types";

export interface SessionRuntime {
  attached: boolean;
  attaching: boolean;
  replayDone: boolean;
  /** Restarted Pi is still constructing its first stable terminal frame. */
  startupPending: boolean;
  detached: boolean;
  status: StatusEventView | null;
  logBytes: number;
  exit: { code: number | null; signal: number | null; groupCleaned: boolean } | null;
  error: string | null;
  /** Stable source for re-localizing an application-owned runtime error. */
  errorMessage: RuntimeMessageEnvelope | null;
  hostPid: number | null;
  /** True while the direct Agent process group is stopped by Ctrl-Z. */
  suspended: boolean;
  /** Latest OSC 0/2 title emitted by the terminal application. */
  terminalTitle: string | null;
  scrolledUp: boolean;
  /** Set when the read-only history terminal shows a truncated log tail. */
  historyNote: string | null;
  /** Stable source for re-localizing a history note after a language switch. */
  historyMessage: RuntimeMessageEnvelope | null;
}

export function emptyRuntime(): SessionRuntime {
  return {
    attached: false,
    attaching: false,
    replayDone: false,
    startupPending: false,
    detached: false,
    status: null,
    logBytes: 0,
    exit: null,
    error: null,
    errorMessage: null,
    hostPid: null,
    suspended: false,
    terminalTitle: null,
    scrolledUp: false,
    historyNote: null,
    historyMessage: null,
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
  details?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
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

export type GitCenterPhase =
  | "idle"
  | "loading"
  | "refreshing"
  | "ready"
  | "stale"
  | "error";

export interface GitDiffSelection {
  entryToken: string;
  pathToken: string;
  side: GitDiffSide;
}

export interface GitCheckoutUiState {
  context: GitCheckoutDescriptor;
  changes: GitChangesSnapshot | null;
  changesPhase: GitCenterPhase;
  changesError: string | null;
  selectedEntries: Record<string, boolean>;
  diffSelection: GitDiffSelection | null;
  diff: GitFileDiff | null;
  diffPhase: GitCenterPhase;
  diffError: string | null;
  history: GitHistoryPage | null;
  historyPhase: GitCenterPhase;
  historyError: string | null;
  selectedCommitOid: string | null;
  commitDetail: GitCommitDetail | null;
  commitPatch: GitCommitPatch | null;
  commitDetailPhase: GitCenterPhase;
  commitDetailError: string | null;
  commitDraft: string;
  commitReview: GitCommitReview | null;
  commitReviewOpen: boolean;
  commitPhase: GitCenterPhase;
  commitError: string | null;
  commitAiPhase: GitCenterPhase;
  commitAiError: string | null;
  lastCommitResult: GitCommitResult | null;
}

export interface GitCenterState {
  open: boolean;
  view: "changes" | "history";
  locator: GitContextLocator | null;
  sourceActiveSessionId: string | null;
  activeCheckoutId: string | null;
  resolvePhase: GitCenterPhase;
  resolveError: string | null;
  pendingSessionLocator: GitContextLocator | null;
  caches: Record<string, GitCheckoutUiState>;
}

export function emptyGitCenterState(): GitCenterState {
  return {
    open: false,
    view: "changes",
    locator: null,
    sourceActiveSessionId: null,
    activeCheckoutId: null,
    resolvePhase: "idle",
    resolveError: null,
    pendingSessionLocator: null,
    caches: {},
  };
}

export type DialogState =
  | {
      kind: "newSession";
      projectId?: string;
      worktreeId?: string;
      agent?: string;
      splitTargetSessionId?: string;
      splitDirection?: PaneSplitDirection;
    }
  | {
      kind: "splitAgentPicker";
      targetSessionId: string;
      direction: PaneSplitDirection;
    }
  | { kind: "newWorktree"; projectId: string }
  | { kind: "branchPicker"; projectId: string }
  | { kind: "settings" }
  | { kind: "diagnostics" }
  | { kind: "timeline" }
  | { kind: "palette" }
  | { kind: "search" }
  | { kind: "addProject" }
  | { kind: "export"; sessionId: string; exportKind: "md" | "json" }
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
  timelineMessage: RuntimeMessageEnvelope | null;
  secretBackend: string;
  indexState: string;
  exportsDir: string;
  activeSessionId: string | null;
  /** Persisted recursive terminal workspace and its focused leaf. */
  terminalLayout: PaneLayout;
  /** Workspace-only maximize state; intentionally excluded from persistence. */
  maximizedSessionId: string | null;
  /** UI-only archive intents; authoritative membership remains in projects. */
  archivingSessionIds: string[];
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
  /** Last backend-confirmed checkout state keyed by project. */
  repositoryStatuses: Record<string, RepositoryStatus>;
  announcement: string;
  themeEffective: EffectiveTheme;
  reducedMotion: boolean;
  /** Whether the project/session sidebar is hidden for terminal focus. */
  sidebarCollapsed: boolean;
  /** Slide choreography phase for the sidebar toggle. "out" plays the
     transform slide before the layout commit; "inPrep"/"in" commit the
     layout off-screen first, then slide the panel back in. null = idle. */
  sidebarAnim: "out" | "inPrep" | "in" | null;
  /** Ephemeral width of the project/session split view in CSS pixels. */
  sidebarWidth: number;
  /** Prevent overlapping persistent Project layout mutations. */
  projectLayoutSaving: boolean;
  /** Monotonic revision of backend/event-owned Project snapshots. */
  projectsAuthorityRevision: number;
  /** Terminal search bar visibility for the active session. */
  termSearchOpen: boolean;
  /** In-app document viewer target opened from a terminal link. */
  openDocument: OpenDocumentTarget | null;
  /** Whether the VSCode-like file tree is visible in the document panel. */
  explorerOpen: boolean;
  /** Root directory of the file tree (captured from the active session). */
  explorerRoot: string | null;
  /** Ephemeral width of the document viewer split in CSS pixels. */
  docPanelWidth: number;
  /** Ephemeral width of the file tree column in CSS pixels (sash-draggable). */
  docTreeWidth: number;
  /** Whether the document viewer is expanded over the whole terminal page. */
  docPanelExpanded: boolean;
  /** Transient font zoom of the terminal area (xterm fontSize multiplier and
   * the pi timeline's `--term-font-scale`), adjusted via Ctrl/⌘ +/-. */
  termFontScale: number;
  /** Transient font zoom of the document viewer body (`--doc-font-scale`). */
  docFontScale: number;
  /** Project whose worktree management view replaces the sidebar list. */
  sidebarWorktreeProjectId: string | null;
  /** Worktree to emphasize after navigating here from branch management. */
  highlightedWorktreeId: string | null;
  /** Worktree ids whose session list is collapsed in the management view. */
  collapsedWorktrees: Record<string, boolean>;
  /** Checkout-frozen Git Center state, with all snapshots keyed by checkoutId. */
  gitCenter: GitCenterState;
}

export interface OpenDocumentTarget {
  /** Canonical absolute path reported by the backend. */
  path: string;
  /** One-based line to reveal in the raw view, from `path:line` links. */
  line: number | null;
}

export const COLLAPSED_PROJECTS_STORAGE_KEY =
  "agentport-collapsed-project-ids";

/** Restore collapsed Projects while keeping unknown/new Projects expanded. */
export function readPersistedProjectExpansion(): Record<string, boolean> {
  try {
    const value = window.localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY);
    if (!value) return {};
    const ids: unknown = JSON.parse(value);
    if (!Array.isArray(ids)) return {};
    return Object.fromEntries(
      ids.filter((id): id is string => typeof id === "string").map((id) => [id, false]),
    );
  } catch {
    return {};
  }
}

const LEGACY_TERMINAL_SNAPSHOT_STORAGE_PREFIX =
  "agentport:terminal-snapshot:v1:";

function reclaimObsoleteTerminalSnapshots() {
  for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(LEGACY_TERMINAL_SNAPSHOT_STORAGE_PREFIX)) {
      window.localStorage.removeItem(key);
    }
  }
}

export function persistProjectExpansion(expandedProjects: Record<string, boolean>) {
  const collapsedIds = Object.entries(expandedProjects)
    .filter(([, expanded]) => expanded === false)
    .map(([id]) => id)
    .sort();
  const encoded = JSON.stringify(collapsedIds);
  try {
    window.localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, encoded);
  } catch {
    try {
      // Terminal snapshots share WKWebView's small LocalStorage quota. Old v1
      // snapshots are only a crash-time optimization and can safely fall back
      // to Host replay; reclaim them before retrying compact UI state.
      reclaimObsoleteTerminalSnapshots();
      window.localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, encoded);
    } catch {
      // Expansion remains usable when WebView storage is unavailable.
    }
  }
}

const persistedTerminalLayout = readPersistedTerminalLayout();

const initialState: AppState = {
  ready: false,
  bootError: null,
  platform: null,
  settings: null,
  adapters: [],
  projects: [],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
  timelineError: null,
  timelineMessage: null,
  secretBackend: "unknown",
  indexState: "unknown",
  exportsDir: "",
  activeSessionId: persistedTerminalLayout.focusedSessionId,
  terminalLayout: persistedTerminalLayout,
  maximizedSessionId: null,
  archivingSessionIds: [],
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
  expandedProjects: readPersistedProjectExpansion(),
  repositoryStatuses: {},
  announcement: "",
  themeEffective: "dark",
  reducedMotion: false,
  sidebarCollapsed: false,
  sidebarAnim: null,
  sidebarWidth: 296,
  projectLayoutSaving: false,
  projectsAuthorityRevision: 0,
  termSearchOpen: false,
  openDocument: null,
  explorerOpen: false,
  explorerRoot: null,
  docPanelWidth: 480,
  docTreeWidth: 184,
  docPanelExpanded: false,
  termFontScale: 1,
  docFontScale: 1,
  sidebarWorktreeProjectId: null,
  highlightedWorktreeId: null,
  collapsedWorktrees: {},
  gitCenter: emptyGitCenterState(),
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

export function useStore(): AppState;
export function useStore<T>(selector: (snapshot: AppState) => T): T;
export function useStore<T>(selector?: (snapshot: AppState) => T): AppState | T {
  if (selector) return useSyncExternalStore(subscribe, () => selector(state));
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
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.runOrdinal < current.runOrdinal) return current;
  if (
    incoming.runOrdinal === current.runOrdinal &&
    (incoming.runId !== current.runId || incoming.sequence < current.sequence)
  ) return current;
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
    projectsAuthorityRevision: s.projectsAuthorityRevision + 1,
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

function sessionsById(projects: ProjectView[]): Map<string, SessionView> {
  return new Map(
    projects.flatMap((project) => project.sessions.map((session) => [session.id, session] as const)),
  );
}

function retainSessionEntries<T>(entries: Record<string, T>, alive: Set<string>): Record<string, T> {
  const removed = Object.keys(entries).filter((sessionId) => !alive.has(sessionId));
  if (removed.length === 0) return entries;
  const next = { ...entries };
  for (const sessionId of removed) delete next[sessionId];
  return next;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sessionScopedState(
  s: AppState,
  projects: ProjectView[],
  alive: Set<string>,
): Partial<AppState> {
  let terminalLayout = prunePaneLayout(s.terminalLayout, alive);
  const legacyActiveSessionId =
    s.activeSessionId && alive.has(s.activeSessionId) ? s.activeSessionId : null;

  // An active Session outside a multi-pane tree is a temporary singleton
  // view. Keep the split intact so selecting one of its members restores it.
  // A one-pane legacy layout has nothing to remember and still follows the
  // active Session as before pane workspaces existed.
  const hasRememberedSplit = orderedLayoutSessionIds(terminalLayout).length > 1;
  if (
    legacyActiveSessionId &&
    !layoutContains(terminalLayout, legacyActiveSessionId) &&
    !hasRememberedSplit
  ) {
    terminalLayout = singletonPaneLayout(legacyActiveSessionId);
  } else if (
    legacyActiveSessionId &&
    layoutContains(terminalLayout, legacyActiveSessionId) &&
    terminalLayout.focusedSessionId !== legacyActiveSessionId
  ) {
    terminalLayout = { ...terminalLayout, focusedSessionId: legacyActiveSessionId };
  }

  const activeSessionId = legacyActiveSessionId ?? terminalLayout.focusedSessionId;
  const displayLayout = visiblePaneLayout(terminalLayout, activeSessionId);
  const sessions = sessionsById(projects);
  const nextAttachedIds = orderedLayoutSessionIds(displayLayout).filter(
    (sessionId) => alive.has(sessionId) && sessions.get(sessionId)?.transport === "pty",
  );
  const attachedIds = sameIds(s.attachedIds, nextAttachedIds)
    ? s.attachedIds
    : nextAttachedIds;
  const maximizedSessionId =
    activeSessionId &&
    layoutContains(terminalLayout, activeSessionId) &&
    s.maximizedSessionId &&
    layoutContains(terminalLayout, s.maximizedSessionId)
      ? s.maximizedSessionId
      : null;

  if (terminalLayout !== s.terminalLayout) persistTerminalLayout(terminalLayout);
  return {
    runtime: retainSessionEntries(s.runtime, alive),
    terminalLayout,
    maximizedSessionId,
    attachedIds,
    activeSessionId,
    termSearchOpen:
      activeSessionId && activeSessionId === s.activeSessionId
        ? s.termSearchOpen
        : false,
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
    const aliveSessionIds = sessionIds(nextProjects);
    return {
      projectsAuthorityRevision: s.projectsAuthorityRevision + 1,
      projects: nextProjects,
      archivingSessionIds: s.archivingSessionIds.filter((id) => aliveSessionIds.has(id)),
      sidebarWorktreeProjectId:
        s.sidebarWorktreeProjectId &&
        nextProjects.some((p) => p.id === s.sidebarWorktreeProjectId)
          ? s.sidebarWorktreeProjectId
          : null,
      collapsedWorktrees: Object.fromEntries(
        Object.entries(s.collapsedWorktrees).filter(([id]) => worktreeIds.has(id)),
      ),
      ...sessionScopedState(s, nextProjects, aliveSessionIds),
    };
  });
}

/** Hide an archive intent immediately without rewriting backend-owned projects. */
export function setSessionArchiving(sessionId: string, archiving: boolean) {
  update((s) => {
    if (archiving) {
      return {
        archivingSessionIds: s.archivingSessionIds.includes(sessionId)
          ? s.archivingSessionIds
          : [...s.archivingSessionIds, sessionId],
      };
    }
    return {
      archivingSessionIds: s.archivingSessionIds.filter((id) => id !== sessionId),
    };
  });
}

/** Remove local state that must not outlive a successfully removed Session. */
export function clearSessionScopedState(sessionId: string) {
  update((s) => {
    const alive = sessionIds(s.projects);
    alive.delete(sessionId);
    return sessionScopedState(s, s.projects, alive);
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
