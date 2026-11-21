// High-level user flows: confirm dialogs + backend calls + store updates.
// Components stay declarative; side effects live here.

import { api, copyText, errorText } from "./api";
import { scopedStorageKey } from "./deviceContext";
import {
  findSessionByKey,
  patchSessionByKey,
  refreshDeviceSnapshot,
  removeSessionFromSnapshot,
} from "./deviceSessions";
import { deviceSessionApiFor } from "./deviceApi";
import {
  focusSessionKeyViaRegistry,
  focusSessionKeyViaRegistryAsync,
} from "./sessionFocusRegistry";
import {
  activeSessionKey,
  deviceKeyForContext,
  parseSessionKey,
  sessionKeyFor,
} from "./sessionIdentity";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { localizedNotices } from "./runtimeMessages";
import { isAddedAgent, quickStartPermission } from "./agentCapabilities";
import {
  applyProjectsSnapshot,
  applyRepositoryStatusSnapshot,
  beginProjectsSnapshotRequest,
  beginRepositoryStatusRequest,
  clearSessionScopedState,
  confirmDialog,
  findProjectOf,
  findSession,
  flattenSessions,
  getState,
  invalidateProjectsSnapshotRequests,
  isCurrentProjectsSnapshotRequest,
  isCurrentRepositoryStatusRequest,
  markRepositoryStatusUnavailable,
  openDialog,
  patchSession,
  persistProjectExpansion,
  promptDialog,
  setSessionArchiving,
  setState,
  toast,
  type EffectiveTheme,
} from "./store";
import {
  applyTerminalSettingsAsync,
  applyXtermThemeAsync,
  attachHandleAsync,
  clearUnreadOutputTrackingAsync,
  disposeHandleAsync,
  getHandleAsync,
  pruneHandlesAsync,
  releaseTerminalAsync,
  resetForRestartAsync,
} from "./terminalRuntime";
import { agentDisplay } from "./format";
import { i18n } from "./i18n";
import { applyTerminalThemeCss } from "./terminalThemes";
import {
  assignPaneGroupAccent,
  buildGridPlacementForSessions,
  focusPane,
  isHorizontalPaneSplitDirection,
  isPaneSplitDirection,
  layoutContains,
  movePane,
  orderedLayoutSessionIds,
  paneLayoutGroupContaining,
  paneLayoutHasSplit,
  paneSessionSize,
  persistTerminalLayouts,
  removePane,
  samePaneLayout,
  singletonPaneLayout,
  splitPane,
  updateSplitRatio,
  visiblePaneLayout,
  type PaneLayout,
  type PaneSplitDirection,
} from "./paneLayout";
import type {
  ProjectLayoutEntry,
  ProjectRemovalPreflight,
  ProjectView,
  TimelineEntry,
  WorktreeDeletePreflight,
} from "./types";

export function isMac(): boolean {
  const os = getState().platform?.os;
  if (os) return os === "macos";
  return navigator.platform.toLowerCase().includes("mac");
}

export async function copyTextWithToast(text: string, successText: string) {
  const copied = await copyText(text);
  toast(
    copied ? successText : i18n.t("common:feedback.copyFailed"),
    copied ? "success" : "error",
  );
}

// ---------------------------------------------------------------------------
// boot / refresh
// ---------------------------------------------------------------------------

let refreshTimer: number | null = null;
let timelineRefreshRequest = 0;
let sessionSelectionIntent = 0;
const ACTIVE_SESSION_STORAGE_KEY = "agentport-active-session-id";

export function readLastSelectedSessionId(): string | null {
  try {
    return window.localStorage.getItem(scopedStorageKey(ACTIVE_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

function rememberSelectedSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(
      scopedStorageKey(ACTIVE_SESSION_STORAGE_KEY),
      sessionId,
    );
  } catch {
    // Selection must remain usable when WebView storage is unavailable.
  }
}

export async function refreshProjects() {
  const request = beginProjectsSnapshotRequest();
  const active = getState().activeSessionId;
  try {
    const projects = await api.listProjects(active);
    if (!isCurrentProjectsSnapshotRequest(request)) return false;
    applyProjectsSnapshot(projects);
    void pruneHandlesAsync();
    return true;
  } catch {
    // The backend is the source of truth; keep the last good tree on error.
    return false;
  }
}

/** Read the checkout state after every branch operation; no optimistic switch. */
export async function refreshRepositoryStatus(projectId: string) {
  const request = beginRepositoryStatusRequest(projectId);
  try {
    const status = await api.getRepositoryStatus(projectId);
    if (!isCurrentRepositoryStatusRequest(projectId, request)) {
      return getState().repositoryStatuses[projectId] ?? null;
    }
    applyRepositoryStatusSnapshot(status);
    return status;
  } catch {
    if (!isCurrentRepositoryStatusRequest(projectId, request)) {
      return getState().repositoryStatuses[projectId] ?? null;
    }
    // A failed live probe must not leave branch entry points enabled from a
    // persisted gitRootPath or an older repository snapshot. A later focus or
    // manual refresh will repopulate the backend-confirmed status.
    markRepositoryStatusUnavailable(projectId);
    return null;
  }
}

/** Pick a project directory natively, then add it using the default folder name. */
export async function addProjectFromPickerFlow() {
  try {
    const path = await api.pickDirectory();
    if (!path) return;
    const res = await api.addProject(path, null);
    await refreshProjects();
    toast(
      res.focusedExisting
        ? i18n.t("shell:project.alreadyAdded")
        : i18n.t("shell:project.added", { name: res.name ?? path }),
      res.focusedExisting ? "info" : "success",
    );
    if (res.id) {
      const state = getState();
      const expandedProjects = { ...state.expandedProjects, [res.id]: true };
      persistProjectExpansion(expandedProjects);
      const revealedProjects = { ...state.revealedProjects };
      delete revealedProjects[res.id];
      setState({ expandedProjects, revealedProjects });
    }
  } catch (e) {
    toast(i18n.t("shell:project.addFailed", { detail: errorText(e) }), "error");
  }
}

export function refreshProjectsSoon() {
  if (refreshTimer !== null) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null;
    void refreshProjects();
  }, 250);
}

export async function refreshTimeline() {
  const request = ++timelineRefreshRequest;
  try {
    const timeline = await api.getTimeline();
    if (request === timelineRefreshRequest) {
      setState({ timeline, timelineError: null, timelineMessage: null });
    }
    return true;
  } catch (error) {
    if (request === timelineRefreshRequest) {
      const detail = errorText(error);
      setState({
        timelineError: null,
        timelineMessage: {
          code: "timeline_load_failed",
          technicalDetail: detail,
        },
      });
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// theme / motion / font application
// ---------------------------------------------------------------------------

export function applyThemeSettings() {
  const s = getState();
  const st = s.settings;
  if (!st) return;
  const sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  let theme: EffectiveTheme;
  if (st.theme === "system") {
    theme = sysDark ? "dark" : "light";
  } else {
    theme = st.theme;
  }
  const sysReduced = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const reduced =
    st.reducedMotion === "system" ? sysReduced : st.reducedMotion === "on";
  document.documentElement.dataset.theme = theme;
  applyTerminalThemeCss(document.documentElement, st.terminalTheme, theme);
  delete document.documentElement.dataset.prepaintTheme;
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  // Keep the native window (and with it the sidebar's vibrancy material) on
  // the same appearance as the web content; otherwise a manual theme
  // override would mix a dark NSVisualEffectView with light chrome.
  void setNativeTheme(theme);
  // Frosted sidebar glass (CSS backdrop-filter over the transparent
  // window) is only enabled on macOS. Elsewhere the sidebar keeps its
  // solid surface — translucency without a blur behind it reads as dirt,
  // not glass.
  document.documentElement.dataset.vibrancy = /Mac/.test(navigator.userAgent)
    ? "on"
    : "off";
  try {
    localStorage.setItem("agentport-theme-mode", st.theme);
    localStorage.setItem("agentport-effective-theme", theme);
  } catch {
    // Theme application must not depend on optional WebView storage.
  }
  setState({ themeEffective: theme, reducedMotion: reduced });
  void applyXtermThemeAsync(theme, st.terminalTheme);
  void applyTerminalSettingsAsync();
}

// Sidebar hide/show choreography: the panel only ever animates `transform`
// (compositor work, zero layout churn — per-frame reflow is what starved
// paints and let the window behind ghost through). The width commit lands
// once, after the slide for hide and before it for show; an opaque curtain
// (CSS, keyed off data-sidebar-anim) covers the vacated column during the
// slide so the frosted glass never reveals the desktop mid-move.
const SIDEBAR_ANIM_MS = 180;
let sidebarAnimToken = 0;

function showSidebar() {
  const s = getState();
  if (!s.sidebarCollapsed && s.sidebarAnim !== "out") return;
  const token = ++sidebarAnimToken;
  if (s.reducedMotion) {
    setState({ sidebarCollapsed: false, sidebarAnim: null });
    return;
  }
  setState({ sidebarCollapsed: false, sidebarAnim: "inPrep" });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (token !== sidebarAnimToken) return;
      setState({ sidebarAnim: "in" });
      window.setTimeout(() => {
        if (token !== sidebarAnimToken) return;
        setState({ sidebarAnim: null });
      }, SIDEBAR_ANIM_MS);
    });
  });
}

export function toggleSidebarCollapsed() {
  const s = getState();
  if (s.sidebarAnim) return; // let the in-flight slide finish
  if (s.sidebarCollapsed) {
    showSidebar();
    return;
  }
  if (s.reducedMotion) {
    // No slide under reduced motion — commit immediately instead.
    setState({ sidebarCollapsed: true });
    return;
  }
  const token = ++sidebarAnimToken;
  setState({ sidebarAnim: "out" });
  window.setTimeout(() => {
    if (token !== sidebarAnimToken) return;
    setState({ sidebarCollapsed: true, sidebarAnim: null });
  }, SIDEBAR_ANIM_MS);
}

/** Toggle the global active-Agent sidebar without disturbing its project context. */
export function toggleActiveAgentsView() {
  const s = getState();
  if (s.sidebarViewMode === "activeAgents") {
    setState({ sidebarViewMode: "projects" });
    return;
  }

  setState({ sidebarViewMode: "activeAgents" });
  if (s.sidebarCollapsed || s.sidebarAnim === "out") showSidebar();
}

// ---------------------------------------------------------------------------
// session selection
// ---------------------------------------------------------------------------

export const PANE_SEPARATOR_SIZE = 6;

/**
 * A split is never refused for being "too small".
 *
 * Panes are proportional, so a narrow window simply yields narrow panes; the
 * minimums still bound *dragging* a separator (see `clampPaneSplitRatio`), which
 * keeps a pane usable once it exists. Refusing the split instead left the user
 * with no way to open a second Agent in a small window.
 */
export function canSplitPaneSize(
  _direction: PaneSplitDirection,
  width: number,
  height: number,
): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
}

function paneElement(sessionId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-pane-session-id]"),
  ).find((element) => element.dataset.paneSessionId === sessionId) ?? null;
}

function paneWorkspaceRect(): DOMRect | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(".pane-layout")
    ?.getBoundingClientRect() ?? null;
}

export function canSplitSessionPane(
  key: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const layout = visiblePaneLayout(
    state.terminalLayout,
    activeSessionKey(state),
  );
  const workspaceRect = paneWorkspaceRect();
  if (layout.root && workspaceRect) {
    const logicalSize = paneSessionSize(
      layout.root,
      key,
      workspaceRect.width,
      workspaceRect.height,
      PANE_SEPARATOR_SIZE,
    );
    if (logicalSize) {
      return canSplitPaneSize(direction, logicalSize.width, logicalSize.height);
    }
  }
  const element = paneElement(key);
  if (!element) return true;
  const rect = element.getBoundingClientRect();
  return canSplitPaneSize(direction, rect.width, rect.height);
}


function activeDeviceKey(): string {
  return deviceKeyForContext(getState().activeDevice);
}

/** Stable layout/runtime key for a Session on the currently active device. */
function activeKeyFor(sessionId: string): string {
  return sessionKeyFor(activeDeviceKey(), sessionId);
}

function plainActiveId(key: string | null): string | null {
  if (!key) return null;
  const parts = parseSessionKey(key);
  return parts.deviceKey === activeDeviceKey() ? parts.sessionId : null;
}

/** Stable key for a Session on an explicit device (default: active device). */
function sessionKeyOn(deviceId: string | undefined, sessionId: string): string {
  return sessionKeyFor(deviceId ?? activeDeviceKey(), sessionId);
}

function isActiveDeviceId(deviceId: string | undefined): boolean {
  return !deviceId || deviceId === activeDeviceKey();
}

function sessionOnDevice(
  sessionId: string,
  deviceId: string | undefined,
) {
  return isActiveDeviceId(deviceId)
    ? findSession(getState().projects, sessionId)
    : (findSessionByKey(sessionKeyOn(deviceId, sessionId))?.session ?? null);
}

function refreshSessionOwner(deviceId: string | undefined): Promise<unknown> {
  return isActiveDeviceId(deviceId)
    ? refreshProjects()
    : refreshDeviceSnapshot(deviceId!);
}

function attachedPtyIdsForLayout(layout: PaneLayout): string[] {
  return orderedLayoutSessionIds(layout).filter((key) => {
    const located = findSessionByKey(key);
    if (located) return located.session.transport === "pty";
    // A foreign pane can render before its device snapshot is loaded; it is a
    // mounted terminal by construction and must stay attached.
    return parseSessionKey(key).deviceKey !== activeDeviceKey();
  });
}

function releaseIdsOutside(previousIds: string[], nextIds: string[]) {
  const retained = new Set(nextIds);
  for (const key of previousIds) {
    if (!retained.has(key)) void releaseTerminalAsync(key);
  }
}

function acknowledgeSession(id: string) {
  const key = activeKeyFor(id);
  rememberSelectedSessionId(id);
  void clearUnreadOutputTrackingAsync(key);
  const session = findSession(getState().projects, id);
  void api
    .markSessionSeen(id, session?.status ?? null)
    .then(refreshProjects)
    .catch(() => undefined);
}

function layoutOverlapsIds(layout: PaneLayout, ids: ReadonlySet<string>): boolean {
  return orderedLayoutSessionIds(layout).some((sessionId) => ids.has(sessionId));
}

function rememberedPaneGroups(state = getState()): PaneLayout[] {
  if (!paneLayoutHasSplit(state.terminalLayout)) return state.terminalLayoutGroups;
  const activeIds = new Set(orderedLayoutSessionIds(state.terminalLayout));
  return [
    state.terminalLayout,
    ...state.terminalLayoutGroups.filter(
      (group) => !layoutOverlapsIds(group, activeIds),
    ),
  ];
}

function paneGroupsAfterLayoutChange(
  groups: readonly PaneLayout[],
  previousLayout: PaneLayout,
  nextLayout: PaneLayout,
  movingSessionId?: string,
): PaneLayout[] {
  const previousIds = paneLayoutHasSplit(previousLayout)
    ? new Set(orderedLayoutSessionIds(previousLayout))
    : new Set<string>();
  const nextIds = new Set(orderedLayoutSessionIds(nextLayout));
  const remaining: PaneLayout[] = [];
  for (const group of groups) {
    if (previousIds.size > 0 && layoutOverlapsIds(group, previousIds)) continue;
    const candidate = movingSessionId && layoutContains(group, movingSessionId)
      ? removePane(group, movingSessionId)
      : group;
    if (!paneLayoutHasSplit(candidate) || layoutOverlapsIds(candidate, nextIds)) continue;
    remaining.push(candidate);
  }
  return paneLayoutHasSplit(nextLayout) ? [nextLayout, ...remaining] : remaining;
}

function persistPaneGroups(groups: readonly PaneLayout[], fallbackLayout: PaneLayout) {
  // Singleton views are temporary while any remembered split survives; cold
  // starts restore the most recently activated split instead.
  persistTerminalLayouts(groups, groups[0] ?? fallbackLayout);
}

function commitPaneLayout(
  terminalLayout: PaneLayout,
  options: {
    maximizedSessionId?: string | null;
    acknowledgeFocused?: boolean;
    previousLayout?: PaneLayout;
    movingSessionId?: string;
  } = {},
) {
  const current = getState();
  const remembered = rememberedPaneGroups(current);
  const nextLayout = assignPaneGroupAccent(terminalLayout, remembered);
  const groups = paneGroupsAfterLayoutChange(
    remembered,
    options.previousLayout ?? current.terminalLayout,
    nextLayout,
    options.movingSessionId,
  );
  const activeSessionId = plainActiveId(nextLayout.focusedSessionId);
  const attachedIds = attachedPtyIdsForLayout(nextLayout);
  const maximizedSessionId =
    options.maximizedSessionId !== undefined
      ? options.maximizedSessionId
      : current.maximizedSessionId &&
          layoutContains(nextLayout, current.maximizedSessionId)
        ? current.maximizedSessionId
        : null;
  setState({
    terminalLayout: nextLayout,
    terminalLayoutGroups: groups,
    activeSessionId,
    attachedIds,
    maximizedSessionId,
  });
  persistPaneGroups(groups, nextLayout);
  releaseIdsOutside(current.attachedIds, attachedIds);
  if (options.acknowledgeFocused && activeSessionId) acknowledgeSession(activeSessionId);
  // A split/move can land on a pane owned by another device. Focus-driven
  // activity must follow it instead of leaving the top bar on the old device.
  const focusedKey = nextLayout.focusedSessionId;
  if (
    focusedKey &&
    parseSessionKey(focusedKey).deviceKey !== activeDeviceKey()
  ) {
    focusSessionKeyViaRegistry(focusedKey);
  }
}

export function selectSession(
  id: string,
  options: { revealInSidebar?: boolean } = {},
) {
  const intent = ++sessionSelectionIntent;
  const s = getState();
  // A newly created Session is persisted before the next project snapshot.
  // Never select against the stale tree: TerminalArea cannot mount a pane for
  // an ID it cannot resolve, which leaves the workspace blank on a fast switch.
  if (!findSession(s.projects, id)) {
    void refreshProjects().then(() => {
      if (
        intent === sessionSelectionIntent &&
        findSession(getState().projects, id)
      ) {
        selectSession(id, options);
      }
    });
    return;
  }
  const ses = findSession(s.projects, id);
  const key = activeKeyFor(id);
  const currentGroups = rememberedPaneGroups(s);
  const rememberedGroup = paneLayoutGroupContaining(currentGroups, key);
  const terminalLayout = rememberedGroup
    ? assignPaneGroupAccent(focusPane(rememberedGroup, key), currentGroups)
    : singletonPaneLayout(key);
  const terminalLayoutGroups = rememberedGroup
    ? [
        terminalLayout,
        ...currentGroups.filter((group) => group !== rememberedGroup),
      ]
    : currentGroups;
  const attachedIds = attachedPtyIdsForLayout(terminalLayout);
  // Selecting another pane of the maximized split keeps the workspace in
  // maximize mode, but the new Session must become the maximized pane.
  const maximizedSessionId =
    layoutContains(s.terminalLayout, key) && s.maximizedSessionId
      ? key
      : null;
  const revealInSidebar = options.revealInSidebar !== false;
  const proj = findProjectOf(s.projects, id);
  // Reveals are view-only: they must never overwrite the user's persisted
  // Project/Worktree collapse choice. Only explicit tree toggles persist.
  const revealProject =
    revealInSidebar && proj && s.expandedProjects[proj.id] === false;
  const revealedProjects = revealProject
    ? { ...s.revealedProjects, [proj.id]: true as const }
    : s.revealedProjects;
  const revealWorktree =
    revealInSidebar &&
    ses?.worktreeId &&
    s.collapsedWorktrees[ses.worktreeId] === true;
  const revealedWorktrees =
    revealWorktree && ses?.worktreeId
      ? { ...s.revealedWorktrees, [ses.worktreeId]: true as const }
      : s.revealedWorktrees;
  setState({
    activeSessionId: id,
    terminalLayout,
    terminalLayoutGroups,
    maximizedSessionId,
    attachedIds,
    revealedProjects,
    revealedWorktrees,
    // The open file tree follows the active Session's cwd, including a
    // Session focused after a device switch.
    ...(s.explorerOpen && ses?.cwd ? { explorerRoot: ses.cwd } : {}),
  });
  persistPaneGroups(terminalLayoutGroups, terminalLayout);
  releaseIdsOutside(s.attachedIds, attachedIds);
  acknowledgeSession(id);
}

export async function openSplitSessionDialog(
  targetKey: string,
  direction: PaneSplitDirection,
): Promise<boolean> {
  const state = getState();
  const target = findSessionByKey(targetKey);
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    activeSessionKey(state),
  );
  if (!target || !layoutContains(displayLayout, targetKey)) return false;
  // The target pane may belong to another device. Creation follows the
  // active device, so switch first and then re-resolve the target against
  // that device's project tree instead of passing a foreign project id.
  if (parseSessionKey(targetKey).deviceKey !== activeDeviceKey()) {
    if (!(await focusSessionKeyViaRegistryAsync(targetKey))) return false;
    const switched = findSessionByKey(targetKey);
    const switchedLayout = visiblePaneLayout(
      getState().terminalLayout,
      activeSessionKey(getState()),
    );
    if (!switched || !layoutContains(switchedLayout, targetKey)) return false;
    selectSession(switched.session.id);
    openDialog({
      kind: "newSession",
      projectId: switched.project.id,
      worktreeId: switched.session.worktreeId ?? undefined,
      splitTargetSessionId: targetKey,
      splitDirection: direction,
    });
    return true;
  }
  selectSession(target.session.id);
  openDialog({
    kind: "newSession",
    projectId: target.project.id,
    worktreeId: target.session.worktreeId ?? undefined,
    splitTargetSessionId: targetKey,
    splitDirection: direction,
  });
  return true;
}

/** Open the lightweight Agent chooser used by pane context-menu splits. */
export async function openSplitAgentPicker(
  targetKey: string,
  direction: PaneSplitDirection,
): Promise<boolean> {
  const state = getState();
  const target = findSessionByKey(targetKey);
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    activeSessionKey(state),
  );
  if (!target || !layoutContains(displayLayout, targetKey)) return false;
  if (parseSessionKey(targetKey).deviceKey !== activeDeviceKey()) {
    if (!(await focusSessionKeyViaRegistryAsync(targetKey))) return false;
    const switched = findSessionByKey(targetKey);
    const switchedLayout = visiblePaneLayout(
      getState().terminalLayout,
      activeSessionKey(getState()),
    );
    if (!switched || !layoutContains(switchedLayout, targetKey)) return false;
  }
  selectSession(target.session.id);
  openDialog({ kind: "splitAgentPicker", targetSessionId: targetKey, direction });
  return true;
}

export function splitSessionIntoPane(
  targetKey: string,
  newKey: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    activeSessionKey(state),
  );
  if (
    targetKey === newKey ||
    !findSessionByKey(targetKey) ||
    !findSessionByKey(newKey) ||
    !layoutContains(displayLayout, targetKey)
  ) {
    return false;
  }
  const terminalLayout = layoutContains(displayLayout, newKey)
    ? movePane(displayLayout, newKey, targetKey, direction)
    : splitPane(displayLayout, targetKey, newKey, direction);
  if (!layoutContains(terminalLayout, newKey)) return false;
  if (!samePaneLayout(terminalLayout, displayLayout)) {
    commitPaneLayout(terminalLayout, {
      maximizedSessionId: null,
      acknowledgeFocused: true,
      previousLayout: displayLayout,
      movingSessionId: newKey,
    });
  } else if (terminalLayout.focusedSessionId === newKey) {
    const plain = plainActiveId(newKey);
    if (plain) acknowledgeSession(plain);
  }
  return true;
}

/**
 * Show a Session that an external agent (the AgentPort MCP server) just opened.
 *
 * A split workspace gains a pane next to the focused one instead of being
 * replaced by a singleton view: the user may be watching work in the other
 * panes, and an Agent asking for a window must not take that away. Any other
 * case is an ordinary selection.
 */
export function openSessionForExternalAgent(
  sessionId: string,
  focus = true,
): boolean {
  const state = getState();
  if (!findSession(state.projects, sessionId)) {
    // The Session was created microseconds ago by another process; the sidebar
    // snapshot can still be one poll behind. Retry after a refresh rather than
    // silently dropping the request.
    void refreshProjects().then(() => {
      if (findSession(getState().projects, sessionId)) {
        openSessionForExternalAgent(sessionId, focus);
      }
    });
    return false;
  }
  const key = activeKeyFor(sessionId);
  const layout = visiblePaneLayout(state.terminalLayout, activeSessionKey(state));
  const focused = layout.focusedSessionId;
  if (
    focused &&
    focused !== key &&
    paneLayoutHasSplit(layout) &&
    !layoutContains(layout, key) &&
    splitSessionIntoPane(focused, key, "right")
  ) {
    if (!focus) {
      const previous = plainActiveId(focused);
      if (previous) selectSession(previous);
    }
    return true;
  }
  selectSession(sessionId);
  return true;
}

/**
 * Put a Session in a new pane beside the focused one (or beside `targetSessionId`).
 *
 * Used by the desktop-side pane intents the MCP queues, so a coordinator can
 * line up several delegated agents. A Session already on screen is focused
 * instead of duplicated, and a pane too small to split falls back to showing the
 * Session in the ordinary view — the intent must never leave a blank workspace.
 */
export function splitSessionForExternalAgent(
  // `auto` lets the layout planner place the pane; an axis forces a split of the
  // target pane (used by explicit `split_pane` requests).
  direction: PaneSplitDirection | "auto",
  sessionId: string,
  targetSessionId: string | null,
  focus = true,
): boolean {
  const state = getState();
  if (!findSession(state.projects, sessionId)) {
    void refreshProjects().then(() => {
      if (findSession(getState().projects, sessionId)) {
        splitSessionForExternalAgent(direction, sessionId, targetSessionId, focus);
      }
    });
    return false;
  }
  const key = activeKeyFor(sessionId);
  const layout = visiblePaneLayout(state.terminalLayout, activeSessionKey(state));
  if (layoutContains(layout, key)) {
    return openSessionForExternalAgent(sessionId, focus);
  }
  const anchorKey = targetSessionId ? activeKeyFor(targetSessionId) : null;

  // Automatic placement: rebuild the whole layout on the grid that keeps every
  // pane as large as the workspace allows (2 → two columns, 4 → 2x2, 9 → 3x3)
  // and put the new pane right after its anchor, i.e. beside the coordinating
  // Agent rather than wherever the cursor happens to be.
  if (direction === "auto") {
    const workspaceRect = paneWorkspaceRect();
    if (workspaceRect) {
      const rebuilt = buildGridPlacementForSessions(
        layout,
        [key],
        workspaceRect.width,
        workspaceRect.height,
        PANE_SEPARATOR_SIZE,
        anchorKey,
      );
      if (rebuilt && rebuilt.root) {
        const previous = plainActiveId(layout.focusedSessionId ?? activeSessionKey(state));
        const focusedKey = focus ? key : layout.focusedSessionId ?? activeSessionKey(state);
        commitPaneLayout(
          { ...rebuilt, focusedSessionId: focusedKey },
          {
            maximizedSessionId: null,
            acknowledgeFocused: focus,
            previousLayout: layout,
            movingSessionId: key,
          },
        );
        if (!focus && previous) selectSession(previous);
        return true;
      }
    }
  }

  // Explicit axis (or no measurable workspace): split the anchor/focused pane.
  const targetKey =
    anchorKey ?? layout.focusedSessionId ?? activeSessionKey(state);
  if (!targetKey || targetKey === key) {
    return openSessionForExternalAgent(sessionId, focus);
  }
  const requested: PaneSplitDirection =
    direction === "auto" ? "right" : direction;
  // A pane can be an awkward shape: try the other axis before giving up.
  const other: PaneSplitDirection = isHorizontalPaneSplitDirection(requested)
    ? "down"
    : "right";
  const chosen = canSplitSessionPane(targetKey, requested)
    ? requested
    : canSplitSessionPane(targetKey, other)
      ? other
      : null;
  if (!chosen || !splitSessionIntoPane(targetKey, key, chosen)) {
    // Never collapse a multi-pane workspace just because one more pane does not
    // fit: the user may be watching several Agents. The Session still appears in
    // the sidebar, and the caller is told the pane was not opened.
    if (paneLayoutHasSplit(layout)) return false;
    return openSessionForExternalAgent(sessionId, focus);
  }
  const previous = plainActiveId(layout.focusedSessionId ?? activeSessionKey(state));
  if (!focus && previous) selectSession(previous);
  return true;
}

/** Place a batch of newly delegated Sessions in one balanced grid transaction. */
export function splitSessionsForExternalAgent(
  sessionIds: readonly string[],
  focus = true,
  anchorSessionId: string | null = null,
): boolean {
  const state = getState();
  const uniqueKeys = [...new Set(sessionIds)]
    .map(activeKeyFor)
    .filter((key) => Boolean(findSessionByKey(key)));
  if (uniqueKeys.length === 0) return false;

  const layout = visiblePaneLayout(state.terminalLayout, activeSessionKey(state));
  const additions = uniqueKeys.filter((key) => !layoutContains(layout, key));
  if (additions.length === 0) {
    const last = additions[additions.length - 1] ?? uniqueKeys[uniqueKeys.length - 1];
    const plain = last ? plainActiveId(last) : null;
    if (focus && plain) selectSession(plain);
    return true;
  }

  const workspaceRect = paneWorkspaceRect();
  if (workspaceRect && layout.root) {
    // The grid shape (how many columns/rows) is always the planner's decision;
    // `anchorSessionId` only orders the new panes next to their parent.
    const rebuilt = buildGridPlacementForSessions(
      layout,
      additions,
      workspaceRect.width,
      workspaceRect.height,
      PANE_SEPARATOR_SIZE,
      anchorSessionId ? activeKeyFor(anchorSessionId) : null,
    );
    if (rebuilt?.root) {
      const previous = plainActiveId(
        layout.focusedSessionId ?? activeSessionKey(state),
      );
      const focusedKey = focus
        ? additions[additions.length - 1]!
        : layout.focusedSessionId ?? activeSessionKey(state);
      commitPaneLayout(
        { ...rebuilt, focusedSessionId: focusedKey },
        {
          maximizedSessionId: null,
          acknowledgeFocused: focus,
          previousLayout: layout,
        },
      );
      if (!focus && previous) selectSession(previous);
      return true;
    }
  }

  // A missing/zero-sized workspace can occur during boot. Preserve the old
  // single-item fallback instead of dropping the delegated Sessions.
  let inserted = false;
  for (const key of additions) {
    const plain = plainActiveId(key);
    if (!plain) continue;
    inserted = splitSessionForExternalAgent("right", plain, null, focus) || inserted;
  }
  return inserted;
}

/** Drop a Session's pane from the layout; the Session keeps running. */
export function closeSessionPaneForExternalAgent(sessionId: string): boolean {
  return removeSessionPane(activeKeyFor(sessionId));
}

/** One pane intent from the MCP queue (see `crates/agentport-mcp/src/ui.rs`). */
export interface ExternalPaneCommand {
  kind: string;
  sessionId: string;
  focus?: boolean;
  direction?: string;
  targetSessionId?: string;
  sessionIds?: string[];
}

/** Apply one queued pane intent. Unknown kinds are ignored, never guessed. */
export function applyExternalPaneCommand(command: ExternalPaneCommand): boolean {
  if (!command.sessionId) return false;
  if (command.kind === "batch_pane") {
    return splitSessionsForExternalAgent(
      command.sessionIds ?? [command.sessionId],
      command.focus !== false,
      command.targetSessionId ?? null,
    );
  }
  switch (command.kind) {
    case "open_pane":
      return openSessionForExternalAgent(command.sessionId, command.focus !== false);
    case "split_pane":
      return splitSessionForExternalAgent(
        isPaneSplitDirection(command.direction) ? command.direction : "auto",
        command.sessionId,
        command.targetSessionId ?? null,
        command.focus !== false,
      );
    case "focus_pane":
      return openSessionForExternalAgent(command.sessionId, true);
    case "close_pane":
      return closeSessionPaneForExternalAgent(command.sessionId);
    default:
      return false;
  }
}

export function removeSessionPane(key: string): boolean {
  const state = getState();
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    activeSessionKey(state),
  );
  if (!layoutContains(displayLayout, key)) return false;
  const groups = rememberedPaneGroups(state);
  if (!paneLayoutHasSplit(displayLayout) && groups[0]) {
    const restored = groups[0];
    commitPaneLayout(restored, {
      maximizedSessionId: null,
      acknowledgeFocused: restored.focusedSessionId !== null,
      previousLayout: displayLayout,
    });
    return true;
  }
  const terminalLayout = removePane(displayLayout, key);
  if (samePaneLayout(terminalLayout, displayLayout)) return false;
  commitPaneLayout(terminalLayout, {
    maximizedSessionId:
      state.maximizedSessionId === key ? null : state.maximizedSessionId,
    acknowledgeFocused:
      terminalLayout.focusedSessionId !== null &&
      terminalLayout.focusedSessionId !== activeSessionKey(state),
    previousLayout: displayLayout,
  });
  return true;
}

export function toggleSessionPaneMaximized(key: string): boolean {
  const state = getState();
  if (!layoutContains(state.terminalLayout, key)) return false;
  if (orderedLayoutSessionIds(state.terminalLayout).length <= 1) return false;
  const maximizedSessionId = state.maximizedSessionId === key ? null : key;
  const terminalLayout = focusPane(state.terminalLayout, key);
  const terminalLayoutGroups = paneGroupsAfterLayoutChange(
    rememberedPaneGroups(state),
    state.terminalLayout,
    terminalLayout,
  );
  const activeSessionId = plainActiveId(key);
  setState({
    terminalLayout,
    terminalLayoutGroups,
    activeSessionId,
    maximizedSessionId,
  });
  persistPaneGroups(terminalLayoutGroups, terminalLayout);
  if (activeSessionId && state.activeSessionId !== activeSessionId) {
    acknowledgeSession(activeSessionId);
  } else if (!activeSessionId) {
    focusSessionKeyViaRegistry(key);
  }
  return true;
}

export function setPaneSplitRatio(
  splitId: string,
  ratio: number,
  persist = true,
): boolean {
  const state = getState();
  const terminalLayout = updateSplitRatio(state.terminalLayout, splitId, ratio);
  if (terminalLayout === state.terminalLayout) return false;
  const terminalLayoutGroups = paneGroupsAfterLayoutChange(
    rememberedPaneGroups(state),
    state.terminalLayout,
    terminalLayout,
  );
  setState({ terminalLayout, terminalLayoutGroups });
  if (persist) persistPaneGroups(terminalLayoutGroups, terminalLayout);
  return true;
}

export function persistCurrentPaneLayout() {
  const state = getState();
  persistPaneGroups(rememberedPaneGroups(state), state.terminalLayout);
}

export function switchSessionByIndex(index: number) {
  const s = getState();
  const layout = visiblePaneLayout(s.terminalLayout, activeSessionKey(s));
  const archiving = new Set(s.archivingSessionIds);
  const keys = orderedLayoutSessionIds(layout).filter(
    (key) => !archiving.has(key),
  );
  const targetKey = keys[index];
  if (!targetKey) return;
  const located = findSessionByKey(targetKey);
  if (!located) return;
  if (located.deviceId === activeDeviceKey()) {
    selectSession(located.session.id);
  } else {
    focusSessionKeyViaRegistry(targetKey);
  }
}

// ---------------------------------------------------------------------------
// session lifecycle flows
// ---------------------------------------------------------------------------

const stoppingSessions = new Set<string>();

export async function stopSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  const ses = sessionOnDevice(sessionId, deviceId);
  const key = sessionKeyOn(deviceId, sessionId);
  if (!ses || stoppingSessions.has(key)) return;
  stoppingSessions.add(key);
  try {
    await deviceSessionApiFor(deviceId ?? activeDeviceKey()).stopSession(sessionId);
    toast(i18n.t("session:flow.stopped"), "success");
    if (!isActiveDeviceId(deviceId)) void refreshSessionOwner(deviceId);
  } catch (e) {
    toast(i18n.t("session:flow.stopFailed", { detail: errorText(e) }), "error");
  } finally {
    stoppingSessions.delete(key);
  }
}

export async function restartSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses) return;
  const key = sessionKeyOn(deviceId, sessionId);
  const sessionApi = deviceSessionApiFor(deviceId ?? activeDeviceKey());
  if (ses.lifecycle === "running" || ses.lifecycle === "creating") {
    try {
      await sessionApi.stopSession(sessionId);
    } catch (e) {
      toast(
        i18n.t("session:flow.stopFailed", { detail: errorText(e) }),
        "error",
      );
      return;
    }
  }
  try {
    // The selected Session already persists its permission mode. Restart it
    // directly instead of asking the user to acknowledge the same mode again.
    const res = await sessionApi.restartSession(sessionId, true);
    await resetForRestartAsync(key);
    await refreshSessionOwner(deviceId);
    if (isActiveDeviceId(deviceId)) {
      // Cold-start selection intentionally drops interrupted PTYs from the
      // mounted-terminal LRU. Once restart publishes the Session as live, run
      // selection again so the active Session gets a TerminalPane before the
      // renderer switches away from its recovery surface.
      if (getState().activeSessionId === sessionId) selectSession(sessionId);
      await attachHandleAsync(key);
    } else if (await getHandleAsync(key)) {
      // A background pane keeps its renderer; reattach it to the new run.
      await attachHandleAsync(key);
    }
    if (res.resumePrecision === "latest") {
      toast(i18n.t("session:flow.latestResumeNotice"), "info");
    } else if (res.resumePrecision === "unavailable") {
      toast(i18n.t("session:flow.freshStartNotice"), "info");
    }
    for (const notice of localizedNotices(res)) toast(notice, "info");
  } catch (e) {
    toast(
      i18n.t("session:flow.restartFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function interruptSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  try {
    await deviceSessionApiFor(deviceId ?? activeDeviceKey()).interruptSession(
      sessionId,
    );
  } catch (e) {
    toast(
      i18n.t("session:flow.interruptFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function resumeSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  try {
    await deviceSessionApiFor(deviceId ?? activeDeviceKey()).resumeSession(
      sessionId,
    );
    if (!isActiveDeviceId(deviceId)) void refreshSessionOwner(deviceId);
  } catch (e) {
    toast(
      i18n.t("session:flow.resumeFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function archiveSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  const initial = getState();
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses) return;
  const active = isActiveDeviceId(deviceId);
  const key = sessionKeyOn(deviceId, sessionId);
  if (initial.archivingSessionIds.includes(key)) return;
  const wasActive = active && initial.activeSessionId === sessionId;
  setSessionArchiving(key, true);
  try {
    await deviceSessionApiFor(deviceId ?? activeDeviceKey()).archiveSession(
      sessionId,
    );
    await disposeHandleAsync(key);
    clearSessionScopedState(key);
    if (!active) removeSessionFromSnapshot(key);
    if (wasActive && getState().activeSessionId === null) {
      selectReplacementSession(sessionId);
    }
    // The command already emitted `projects-changed`; this read is only a
    // reconciliation fallback and must not hold the interaction open.
    void refreshSessionOwner(deviceId);
  } catch (e) {
    setSessionArchiving(key, false);
    toast(
      i18n.t("session:flow.archiveFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

/** Replacement selection is implicit navigation: never rewrite the sidebar's
 * Project/Worktree expansion the user explicitly chose. */
function selectReplacementSession(removedSessionId: string) {
  const current = getState();
  const next = flattenSessions(current.projects).find(
    (session) =>
      session.id !== removedSessionId &&
      !current.archivingSessionIds.includes(activeKeyFor(session.id)),
  );
  if (next) selectSession(next.id, { revealInSidebar: false });
}

// Leave the removed pane immediately; process cleanup still runs to completion.
// Restore only if cleanup failed and the user has not navigated elsewhere.
function leaveRemovingSession(key: string): () => void {
  const before = getState();
  const layout = visiblePaneLayout(
    before.terminalLayout,
    activeSessionKey(before),
  );
  if (!layoutContains(layout, key)) return () => undefined;
  commitPaneLayout(removePane(layout, key), {
    maximizedSessionId: null,
    acknowledgeFocused: false,
    previousLayout: layout,
  });
  if (getState().activeSessionId === null) {
    selectReplacementSession(parseSessionKey(key).sessionId);
  }
  const intent = sessionSelectionIntent;
  const pendingLayout = getState().terminalLayout;
  return () => {
    if (sessionSelectionIntent !== intent || !samePaneLayout(getState().terminalLayout, pendingLayout)) return;
    commitPaneLayout(layout, { maximizedSessionId: before.maximizedSessionId,
      acknowledgeFocused: false, previousLayout: pendingLayout });
  };
}

export async function removeSessionFlow(
  sessionId: string,
  options: { confirm?: boolean; deviceId?: string } = {},
) {
  const initial = getState();
  const deviceId = options.deviceId;
  const active = isActiveDeviceId(deviceId);
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses) return;
  const key = sessionKeyOn(deviceId, sessionId);
  if (initial.archivingSessionIds.includes(key)) return;
  if (options.confirm) {
    const ok = await confirmDialog({
      title: i18n.t("session:flow.removeTitle", { title: ses.title }),
      body: i18n.t("session:flow.removeBody"),
      confirmLabel: i18n.t("common:actions.remove"),
      danger: true,
    });
    if (!ok) return;
  }

  const wasActive = active && initial.activeSessionId === sessionId;
  const sessionApi = deviceSessionApiFor(deviceId ?? activeDeviceKey());
  setSessionArchiving(key, true);
  const restorePane = active ? leaveRemovingSession(key) : () => undefined;
  let archived = false;
  try {
    await sessionApi.archiveSession(sessionId);
    archived = true;
    await sessionApi.deleteArchivedSession(sessionId);
    await disposeHandleAsync(key);
    clearSessionScopedState(key);
    if (!active) removeSessionFromSnapshot(key);
    if (wasActive && getState().activeSessionId === null) {
      selectReplacementSession(sessionId);
    }
    void refreshSessionOwner(deviceId);
  } catch (e) {
    setSessionArchiving(key, false);
    if (!archived) restorePane();
    else void refreshSessionOwner(deviceId);
    toast(
      i18n.t("session:flow.removeFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function renameSessionFlow(
  sessionId: string,
  deviceId?: string,
) {
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses) return;
  const title = await promptDialog({
    title: i18n.t("session:flow.renameTitle"),
    label: i18n.t("session:flow.newTitle"),
    initial: ses.title,
    okLabel: i18n.t("common:actions.rename"),
  });
  if (!title || !title.trim() || title.trim() === ses.title) return;
  try {
    await deviceSessionApiFor(
      deviceId ?? activeDeviceKey(),
    ).renameSession(sessionId, title.trim());
    await refreshSessionOwner(deviceId);
  } catch (e) {
    toast(
      i18n.t("session:flow.renameFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function renameSessionInlineFlow(
  sessionId: string,
  title: string,
  deviceId?: string,
) {
  const nextTitle = title.trim();
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses || !nextTitle || nextTitle === ses.title) return;
  try {
    await deviceSessionApiFor(
      deviceId ?? activeDeviceKey(),
    ).renameSession(sessionId, nextTitle);
    await refreshSessionOwner(deviceId);
  } catch (e) {
    toast(
      i18n.t("session:flow.renameFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

/** Pin state is backend-owned (sessions.pinned_at); patch optimistically so
 * the sidebar reorders immediately, then let the projects-changed snapshot
 * reconcile the persisted timestamp. */
export async function toggleSessionPinFlow(
  sessionId: string,
  deviceId?: string,
) {
  const ses = sessionOnDevice(sessionId, deviceId);
  if (!ses) return;
  const active = isActiveDeviceId(deviceId);
  const key = sessionKeyOn(deviceId, sessionId);
  const pinned = ses.pinnedAt === null;
  const patch = { pinnedAt: pinned ? new Date().toISOString() : null };
  if (active) patchSession(sessionId, patch);
  else patchSessionByKey(key, patch);
  try {
    await deviceSessionApiFor(
      deviceId ?? activeDeviceKey(),
    ).setSessionPinned(sessionId, pinned);
    if (!active) void refreshSessionOwner(deviceId);
  } catch (e) {
    toast(i18n.t("session:flow.pinFailed", { detail: errorText(e) }), "error");
    await refreshSessionOwner(deviceId);
  }
}

// ---------------------------------------------------------------------------
// project / worktree flows
// ---------------------------------------------------------------------------

export async function renameProjectFlow(projectId: string) {
  const proj = getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  const name = await promptDialog({
    title: i18n.t("shell:project.renameTitle"),
    label: i18n.t("shell:project.newName"),
    initial: proj.name,
    okLabel: i18n.t("common:actions.rename"),
  });
  if (!name || !name.trim() || name.trim() === proj.name) return;
  try {
    await api.renameProject(projectId, name.trim());
    await refreshProjects();
  } catch (e) {
    toast(
      i18n.t("shell:project.renameFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

function projectsInLayout(
  projects: ProjectView[],
  entries: ProjectLayoutEntry[],
): ProjectView[] | null {
  if (projects.length !== entries.length) return null;
  const byId = new Map(projects.map((project) => [project.id, project]));
  const next: ProjectView[] = [];
  for (const entry of entries) {
    const project = byId.get(entry.id);
    if (!project) return null;
    next.push({ ...project, pinned: entry.pinned });
    byId.delete(entry.id);
  }
  return byId.size === 0 ? next : null;
}

/** Persist one complete canonical Project order. Only one write may be active. */
export async function saveProjectLayoutFlow(
  entries: ProjectLayoutEntry[],
): Promise<boolean> {
  const current = getState();
  if (current.projectLayoutSaving) return false;
  const nextProjects = projectsInLayout(current.projects, entries);
  if (!nextProjects) {
    toast(i18n.t("shell:project.layoutInvalid"), "error");
    return false;
  }
  const changed = nextProjects.some(
    (project, index) =>
      project.id !== current.projects[index]?.id ||
      project.pinned !== current.projects[index]?.pinned,
  );
  if (!changed) return true;

  const previousProjects = current.projects;
  invalidateProjectsSnapshotRequests();
  setState({ projects: nextProjects, projectLayoutSaving: true });
  const authorityRevision = getState().projectsAuthorityRevision;
  try {
    const projects = await api.setProjectLayout(
      entries,
      current.activeSessionId,
    );
    invalidateProjectsSnapshotRequests();
    if (getState().projectsAuthorityRevision === authorityRevision) {
      applyProjectsSnapshot(projects);
    } else {
      const merged = projectsInLayout(getState().projects, entries);
      if (merged) setState({ projects: merged });
    }
    setState({
      projectLayoutSaving: false,
      announcement: i18n.t("shell:project.layoutSaved"),
    });
    return true;
  } catch (error) {
    const reconcileRevision = getState().projectsAuthorityRevision;
    const restored = await refreshProjects();
    if (
      !restored &&
      getState().projectsAuthorityRevision === reconcileRevision
    ) {
      invalidateProjectsSnapshotRequests();
      applyProjectsSnapshot(previousProjects);
    }
    const message = i18n.t("shell:project.layoutFailed", {
      detail: errorText(error),
    });
    setState({ projectLayoutSaving: false, announcement: message });
    toast(message, "error");
    return false;
  }
}

export async function removeProjectFlow(projectId: string) {
  const proj = getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  let preflight: ProjectRemovalPreflight;
  try {
    preflight = await api.projectRemovePreflight(projectId);
  } catch (e) {
    toast(
      i18n.t("shell:project.removeFailed", { detail: errorText(e) }),
      "error",
    );
    return;
  }

  const ok = await confirmDialog({
    title: i18n.t("shell:project.removeTitle", { name: proj.name }),
    body: i18n.t("shell:project.removeBody"),
    confirmLabel: i18n.t("common:actions.remove"),
  });
  if (!ok) return;
  try {
    await api.removeProject(preflight);
    if (
      findProjectOf(getState().projects, getState().activeSessionId)?.id ===
      projectId
    ) {
      setState({ activeSessionId: null });
    }
    await refreshProjects();
  } catch (e) {
    toast(
      i18n.t("shell:project.removeFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

function worktreeDeleteBlockerDetails(
  preflight: WorktreeDeletePreflight,
): string[] {
  const details: string[] = [];
  if (preflight.summaryError) {
    // Zero counts from a failed probe say nothing about local data, so the
    // confirmation must show the uncertainty instead of a clean summary.
    details.push(
      i18n.t("worktree:flow.unknownLocalDetail", {
        detail: preflight.summaryError,
      }),
    );
  }
  if (preflight.modified + preflight.staged + preflight.untracked > 0) {
    details.push(
      i18n.t("worktree:flow.changesBlocker", {
        modified: preflight.modified,
        staged: preflight.staged,
        untracked: preflight.untracked,
      }),
    );
  }
  if (preflight.ignored > 0) {
    details.push(
      i18n.t("worktree:flow.ignoredBlocker", {
        count: preflight.ignored,
        sample: preflight.ignoredSample.join(", "),
      }),
    );
  }
  if (preflight.sessionCount > 0) {
    details.push(
      i18n.t("worktree:flow.sessionsBlocker", {
        count: preflight.sessionCount,
        active: preflight.activeSessionCount,
      }),
    );
  }
  if (preflight.health === "locked") {
    details.push(i18n.t("worktree:flow.lockedBlocker"));
  }
  return details;
}

export async function removeWorktreeFlow(worktreeId: string) {
  const s = getState();
  for (const p of s.projects) {
    const w = p.worktrees.find((x) => x.id === worktreeId);
    if (!w) continue;
    let preflight: WorktreeDeletePreflight;
    try {
      preflight = await api.worktreeDeletePreflight(worktreeId);
    } catch (e) {
      toast(
        i18n.t("worktree:flow.deleteFailed", { detail: errorText(e) }),
        "error",
      );
      return;
    }
    const cleanupItems = worktreeDeleteBlockerDetails(preflight);
    let body: string;
    if (preflight.repositoryMissing) {
      body = i18n.t("worktree:flow.deleteOrphanedBody");
    } else if (preflight.health === "missing") {
      body = i18n.t("worktree:flow.deleteMissingBody");
    } else {
      body = i18n.t("worktree:flow.deleteBody");
    }
    const ok = await confirmDialog({
      title: i18n.t("worktree:flow.deleteTitle", { branch: preflight.branch }),
      body,
      details: [
        i18n.t("worktree:flow.pathDetail", { path: preflight.path }),
        // A failed local-change probe always contributes an item, so an
        // unverifiable Worktree never reaches the "nothing to clean up" copy.
        cleanupItems.length > 0
          ? i18n.t("worktree:flow.cleanupDetail", {
              detail: cleanupItems.join(
                i18n.t("worktree:flow.blockerSeparator"),
              ),
            })
          : i18n.t("worktree:flow.safeDetail"),
      ],
      confirmLabel: i18n.t("worktree:flow.deleteAction"),
      danger: true,
    });
    if (!ok) return;
    try {
      const outcome = await api.removeWorktree(worktreeId);
      await refreshProjects();
      const warnings = outcome.stopWarnings + outcome.cleanupWarnings;
      toast(
        warnings > 0
          ? i18n.t("worktree:flow.deletedWithWarnings", { count: warnings })
          : i18n.t("worktree:flow.deleted"),
        warnings > 0 ? "info" : "success",
      );
    } catch (e) {
      toast(
        i18n.t("worktree:flow.deleteFailed", { detail: errorText(e) }),
        "error",
      );
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// misc flows
// ---------------------------------------------------------------------------

export function openNewSessionDialog(
  projectId?: string,
  worktreeId?: string,
  agent?: string,
) {
  const s = getState();
  let pid = projectId;
  if (!pid) {
    pid = findProjectOf(s.projects, s.activeSessionId)?.id ?? s.projects[0]?.id;
  }
  if (!pid) {
    toast(i18n.t("session:flow.addProjectFirst"), "info");
    openDialog({ kind: "addProject" });
    return;
  }
  openDialog({ kind: "newSession", projectId: pid, worktreeId, agent });
}

export interface QuickStartSplitIntent {
  targetSessionId: string;
  direction: PaneSplitDirection;
}

/** Icon shortcuts start immediately, optionally inserting into a target pane. */
export async function quickStartSession(
  projectId: string,
  agent: string,
  worktreeId?: string,
  splitIntent?: QuickStartSplitIntent,
) {
  const shell = agent === "shell";
  const plain = agent === "pi" || isAddedAgent(agent);
  const deviceKey = deviceKeyForContext(getState().activeDevice);
  try {
    const res = await api.createSession({
      projectId,
      agent,
      title: null,
      presetId: null,
      worktreeId: worktreeId ?? null,
      // Newly supported agents preserve upstream defaults. Only the established
      // legacy shortcuts retain their explicit bypass behavior.
      permission: quickStartPermission(agent),
      transport: "pty",
      riskAck: true,
      cols: null,
      rows: null,
      extraArgs: null,
    });
    await refreshProjects();
    // A transient/superseded snapshot must not silently discard the requested
    // split. Retry once before falling back to the normal standalone selector.
    if (splitIntent && !findSession(getState().projects, res.id)) {
      await refreshProjects();
    }
    const inserted = splitIntent
      ? splitSessionIntoPane(
          splitIntent.targetSessionId,
          sessionKeyFor(deviceKey, res.id),
          splitIntent.direction,
        )
      : false;
    if (!inserted) selectSession(res.id);
    const launchNotices = isAddedAgent(agent)
      ? res
      : { notices: res.notices?.filter((notice) => notice.code === "notification_setup_degraded") };
    for (const notice of localizedNotices(launchNotices)) toast(notice, "info");
    toast(
      plain
        ? i18n.t("session:flow.quickStartedPlain", {
            agent: agentDisplay(agent),
          })
        : i18n.t("session:flow.quickStarted", {
            agent: agentDisplay(agent),
            access: shell
              ? i18n.t("session:flow.terminalAccess")
              : i18n.t("session:flow.fullAccess"),
          }),
      "success",
    );
  } catch (e) {
    toast(
      i18n.t("session:flow.startFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function ackTimelineFlow() {
  const snapshot = getState().timeline.ackSnapshots;
  try {
    await api.ackTimeline(snapshot);
    // A read started before this acknowledgement belongs to the old recovery
    // window and must not repopulate the just-cleared badge/list.
    timelineRefreshRequest += 1;
    // This recovery window is frozen at boot. Do not re-query a live DB here:
    // events arriving while the GUI is open belong to normal realtime UI, not
    // the just-acknowledged "while you were away" snapshot.
    setState({
      timeline: {
        completed: 0,
        waiting: 0,
        failed: 0,
        entries: [],
        ackSnapshots: [],
      },
      timelineError: null,
      timelineMessage: null,
    });
    await refreshProjects();
  } catch (e) {
    toast(
      i18n.t("session:flow.operationFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function dismissTimelineEntry(entry: TimelineEntry) {
  const timeline = getState().timeline;
  setState({
    timeline: {
      ...timeline,
      entries: timeline.entries.filter((candidate) => candidate !== entry),
    },
  });
  if (!entry.statusCursor) return;
  try {
    await api.ackTimeline([{
      sessionId: entry.sessionId,
      statusCursor: entry.statusCursor,
      logCursor: null,
    }]);
  } catch (e) {
    toast(
      i18n.t("session:flow.operationFailed", { detail: errorText(e) }),
      "error",
    );
  }
}
