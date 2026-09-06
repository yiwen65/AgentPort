// High-level user flows: confirm dialogs + backend calls + store updates.
// Components stay declarative; side effects live here.

import { api, copyText, errorText } from "./api";
import { setTheme as setNativeTheme } from "@tauri-apps/api/app";
import { localizedNotices } from "./runtimeMessages";
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
  applyTerminalSettings,
  applyXtermTheme,
  attachHandle,
  clearUnreadOutputTracking,
  disposeHandle,
  jumpToRecoveryOutput,
  pruneHandles,
  releaseTerminal,
  resetForRestart,
} from "./terminals";
import { agentDisplay } from "./format";
import { i18n } from "./i18n";
import { applyTerminalThemeCss } from "./terminalThemes";
import {
  focusPane,
  layoutContains,
  movePane,
  orderedLayoutSessionIds,
  paneLayoutFitsSize,
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
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  type PaneLayout,
  type PaneSplitDirection,
} from "./paneLayout";
import type {
  LogCursorView,
  ProjectLayoutEntry,
  ProjectRemovalPreflight,
  ProjectView,
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
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberSelectedSessionId(sessionId: string) {
  try {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
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
    pruneHandles();
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
      const expandedProjects = { ...getState().expandedProjects, [res.id]: true };
      persistProjectExpansion(expandedProjects);
      setState({ expandedProjects });
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
  applyXtermTheme(theme, st.terminalTheme);
  applyTerminalSettings();
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

export function canSplitPaneSize(
  direction: PaneSplitDirection,
  width: number,
  height: number,
): boolean {
  if (width < MIN_PANE_WIDTH || height < MIN_PANE_HEIGHT) return false;
  return direction === "right"
    ? width >= MIN_PANE_WIDTH * 2 + PANE_SEPARATOR_SIZE
    : height >= MIN_PANE_HEIGHT * 2 + PANE_SEPARATOR_SIZE;
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
  sessionId: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const layout = visiblePaneLayout(state.terminalLayout, state.activeSessionId);
  const workspaceRect = paneWorkspaceRect();
  if (layout.root && workspaceRect) {
    const logicalSize = paneSessionSize(
      layout.root,
      sessionId,
      workspaceRect.width,
      workspaceRect.height,
      PANE_SEPARATOR_SIZE,
    );
    if (logicalSize) {
      return canSplitPaneSize(direction, logicalSize.width, logicalSize.height);
    }
  }
  const element = paneElement(sessionId);
  if (!element) return true;
  const rect = element.getBoundingClientRect();
  return canSplitPaneSize(direction, rect.width, rect.height);
}

function paneLayoutFitsWorkspace(layout: PaneLayout): boolean {
  if (!layout.root) return true;
  const workspaceRect = paneWorkspaceRect();
  return !workspaceRect || paneLayoutFitsSize(
    layout.root,
    workspaceRect.width,
    workspaceRect.height,
    PANE_SEPARATOR_SIZE,
  );
}

function attachedPtyIdsForLayout(
  layout: PaneLayout,
  projects = getState().projects,
): string[] {
  return orderedLayoutSessionIds(layout).filter(
    (sessionId) => findSession(projects, sessionId)?.transport === "pty",
  );
}

function releaseIdsOutside(previousIds: string[], nextIds: string[]) {
  const retained = new Set(nextIds);
  for (const sessionId of previousIds) {
    if (!retained.has(sessionId)) void releaseTerminal(sessionId);
  }
}

function acknowledgeSession(id: string) {
  rememberSelectedSessionId(id);
  clearUnreadOutputTracking(id);
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
  const groups = paneGroupsAfterLayoutChange(
    rememberedPaneGroups(current),
    options.previousLayout ?? current.terminalLayout,
    terminalLayout,
    options.movingSessionId,
  );
  const activeSessionId = terminalLayout.focusedSessionId;
  const attachedIds = attachedPtyIdsForLayout(terminalLayout, current.projects);
  const maximizedSessionId =
    options.maximizedSessionId !== undefined
      ? options.maximizedSessionId
      : current.maximizedSessionId &&
          layoutContains(terminalLayout, current.maximizedSessionId)
        ? current.maximizedSessionId
        : null;
  setState({
    terminalLayout,
    terminalLayoutGroups: groups,
    activeSessionId,
    attachedIds,
    maximizedSessionId,
    termSearchOpen:
      activeSessionId && activeSessionId === current.activeSessionId
        ? current.termSearchOpen
        : false,
  });
  persistPaneGroups(groups, terminalLayout);
  releaseIdsOutside(current.attachedIds, attachedIds);
  if (options.acknowledgeFocused && activeSessionId) acknowledgeSession(activeSessionId);
}

export function selectSession(
  id: string,
  recoveryTarget: LogCursorView | null = null,
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
        selectSession(id, recoveryTarget, options);
      }
    });
    return;
  }
  const ses = findSession(s.projects, id);
  const sessionLive = ses?.lifecycle === "creating" || ses?.lifecycle === "running";
  const currentGroups = rememberedPaneGroups(s);
  const rememberedGroup = paneLayoutGroupContaining(currentGroups, id);
  const terminalLayout = rememberedGroup
    ? focusPane(rememberedGroup, id)
    : singletonPaneLayout(id);
  const terminalLayoutGroups = rememberedGroup
    ? [
        terminalLayout,
        ...currentGroups.filter((group) => group !== rememberedGroup),
      ]
    : currentGroups;
  const attachedIds = attachedPtyIdsForLayout(terminalLayout, s.projects);
  const maximizedSessionId =
    layoutContains(s.terminalLayout, id) && s.maximizedSessionId ? id : null;
  const revealInSidebar = options.revealInSidebar !== false;
  const proj = findProjectOf(s.projects, id);
  const expandedProjects =
    revealInSidebar && proj && s.expandedProjects[proj.id] === false
      ? { ...s.expandedProjects, [proj.id]: true }
      : s.expandedProjects;
  const collapsedWorktrees = { ...s.collapsedWorktrees };
  if (revealInSidebar && ses?.worktreeId) delete collapsedWorktrees[ses.worktreeId];
  if (expandedProjects !== s.expandedProjects) {
    persistProjectExpansion(expandedProjects);
  }
  setState({
    activeSessionId: id,
    terminalLayout,
    terminalLayoutGroups,
    maximizedSessionId,
    attachedIds,
    expandedProjects,
    collapsedWorktrees,
    termSearchOpen: false,
  });
  persistPaneGroups(terminalLayoutGroups, terminalLayout);
  releaseIdsOutside(s.attachedIds, attachedIds);
  acknowledgeSession(id);
  if (recoveryTarget && ses?.transport === "pty" && sessionLive) {
    void jumpToRecoveryOutput(id, recoveryTarget).catch((error) => {
      toast(
        i18n.t("session:flow.locateRecoveryFailed", {
          detail: errorText(error),
        }),
        "error",
      );
    });
  }
}

export function openSplitSessionDialog(
  targetSessionId: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const target = findSession(state.projects, targetSessionId);
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    state.activeSessionId,
  );
  if (!target || !layoutContains(displayLayout, targetSessionId)) return false;
  if (!canSplitSessionPane(targetSessionId, direction)) {
    toast(i18n.t("shell:pane.tooSmall"), "info");
    return false;
  }
  selectSession(targetSessionId);
  openDialog({
    kind: "newSession",
    projectId: target.projectId,
    worktreeId: target.worktreeId ?? undefined,
    splitTargetSessionId: targetSessionId,
    splitDirection: direction,
  });
  return true;
}

/** Open the lightweight Agent chooser used by pane context-menu splits. */
export function openSplitAgentPicker(
  targetSessionId: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const target = findSession(state.projects, targetSessionId);
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    state.activeSessionId,
  );
  if (!target || !layoutContains(displayLayout, targetSessionId)) return false;
  if (!canSplitSessionPane(targetSessionId, direction)) {
    toast(i18n.t("shell:pane.tooSmall"), "info");
    return false;
  }
  selectSession(targetSessionId);
  openDialog({ kind: "splitAgentPicker", targetSessionId, direction });
  return true;
}

export function splitSessionIntoPane(
  targetSessionId: string,
  sessionId: string,
  direction: PaneSplitDirection,
): boolean {
  const state = getState();
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    state.activeSessionId,
  );
  if (
    targetSessionId === sessionId ||
    !findSession(state.projects, targetSessionId) ||
    !findSession(state.projects, sessionId) ||
    !layoutContains(displayLayout, targetSessionId)
  ) {
    return false;
  }
  const terminalLayout = layoutContains(displayLayout, sessionId)
    ? movePane(displayLayout, sessionId, targetSessionId, direction)
    : splitPane(displayLayout, targetSessionId, sessionId, direction);
  if (!layoutContains(terminalLayout, sessionId)) return false;
  if (!samePaneLayout(terminalLayout, displayLayout)) {
    if (!paneLayoutFitsWorkspace(terminalLayout)) {
      toast(i18n.t("shell:pane.tooSmall"), "info");
      return false;
    }
    commitPaneLayout(terminalLayout, {
      maximizedSessionId: null,
      acknowledgeFocused: true,
      previousLayout: displayLayout,
      movingSessionId: sessionId,
    });
  } else if (terminalLayout.focusedSessionId === sessionId) {
    acknowledgeSession(sessionId);
  }
  return true;
}

export function removeSessionPane(sessionId: string): boolean {
  const state = getState();
  const displayLayout = visiblePaneLayout(
    state.terminalLayout,
    state.activeSessionId,
  );
  if (!layoutContains(displayLayout, sessionId)) return false;
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
  const terminalLayout = removePane(displayLayout, sessionId);
  if (samePaneLayout(terminalLayout, displayLayout)) return false;
  commitPaneLayout(terminalLayout, {
    maximizedSessionId:
      state.maximizedSessionId === sessionId ? null : state.maximizedSessionId,
    acknowledgeFocused:
      terminalLayout.focusedSessionId !== null &&
      terminalLayout.focusedSessionId !== state.activeSessionId,
    previousLayout: displayLayout,
  });
  return true;
}

export function toggleSessionPaneMaximized(sessionId: string): boolean {
  const state = getState();
  if (!layoutContains(state.terminalLayout, sessionId)) return false;
  if (orderedLayoutSessionIds(state.terminalLayout).length <= 1) return false;
  const maximizedSessionId =
    state.maximizedSessionId === sessionId ? null : sessionId;
  const terminalLayout = focusPane(state.terminalLayout, sessionId);
  const terminalLayoutGroups = paneGroupsAfterLayoutChange(
    rememberedPaneGroups(state),
    state.terminalLayout,
    terminalLayout,
  );
  setState({
    terminalLayout,
    terminalLayoutGroups,
    activeSessionId: sessionId,
    maximizedSessionId,
    termSearchOpen:
      state.activeSessionId === sessionId ? state.termSearchOpen : false,
  });
  persistPaneGroups(terminalLayoutGroups, terminalLayout);
  if (state.activeSessionId !== sessionId) acknowledgeSession(sessionId);
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
  const archiving = new Set(s.archivingSessionIds);
  const list = flattenSessions(s.projects).filter(
    (session) => !archiving.has(session.id),
  );
  const target = list[index];
  if (target) selectSession(target.id);
}

// ---------------------------------------------------------------------------
// session lifecycle flows
// ---------------------------------------------------------------------------

const stoppingSessions = new Set<string>();

export async function stopSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses || stoppingSessions.has(sessionId)) return;
  stoppingSessions.add(sessionId);
  try {
    await api.stopSession(sessionId);
    toast(i18n.t("session:flow.stopped"), "success");
  } catch (e) {
    toast(i18n.t("session:flow.stopFailed", { detail: errorText(e) }), "error");
  } finally {
    stoppingSessions.delete(sessionId);
  }
}

export async function restartSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  if (ses.lifecycle === "running" || ses.lifecycle === "creating") {
    const ok = await confirmDialog({
      title: i18n.t("session:flow.restartTitle", { title: ses.title }),
      body: i18n.t("session:flow.restartBody"),
      confirmLabel: i18n.t("session:flow.stopAndRestart"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.stopSession(sessionId);
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
    const res = await api.restartSession(sessionId, true);
    resetForRestart(sessionId);
    await refreshProjects();
    // Cold-start selection intentionally drops interrupted PTYs from the
    // mounted-terminal LRU. Once restart publishes the Session as live, run
    // selection again so the active Session gets a TerminalPane before the
    // renderer switches away from its recovery surface.
    if (getState().activeSessionId === sessionId) selectSession(sessionId);
    void attachHandle(sessionId);
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

export async function interruptSessionFlow(sessionId: string) {
  try {
    await api.interruptSession(sessionId);
  } catch (e) {
    toast(
      i18n.t("session:flow.interruptFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function resumeSessionFlow(sessionId: string) {
  try {
    await api.resumeSession(sessionId);
  } catch (e) {
    toast(
      i18n.t("session:flow.resumeFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

export async function archiveSessionFlow(sessionId: string) {
  const initial = getState();
  const ses = findSession(initial.projects, sessionId);
  if (!ses) return;
  if (initial.archivingSessionIds.includes(sessionId)) return;
  const wasActive = initial.activeSessionId === sessionId;
  setSessionArchiving(sessionId, true);
  try {
    await api.archiveSession(sessionId);
    disposeHandle(sessionId);
    clearSessionScopedState(sessionId);
    if (wasActive && getState().activeSessionId === null) {
      const current = getState();
      const archiving = new Set(current.archivingSessionIds);
      const next = flattenSessions(current.projects).find(
        (session) => session.id !== sessionId && !archiving.has(session.id),
      );
      if (next) selectSession(next.id);
    }
    // The command already emitted `projects-changed`; this read is only a
    // reconciliation fallback and must not hold the interaction open.
    void refreshProjects();
  } catch (e) {
    setSessionArchiving(sessionId, false);
    toast(
      i18n.t("session:flow.archiveFailed", { detail: errorText(e) }),
      "error",
    );
  }
}

/** UI-level removal uses the archive operation; archived Sessions are kept
    until explicitly restored or permanently deleted in Settings. */
export async function removeSessionFlow(sessionId: string) {
  await archiveSessionFlow(sessionId);
}

export async function renameSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  const title = await promptDialog({
    title: i18n.t("session:flow.renameTitle"),
    label: i18n.t("session:flow.newTitle"),
    initial: ses.title,
    okLabel: i18n.t("common:actions.rename"),
  });
  if (!title || !title.trim() || title.trim() === ses.title) return;
  try {
    await api.renameSession(sessionId, title.trim());
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
) {
  const nextTitle = title.trim();
  const ses = findSession(getState().projects, sessionId);
  if (!ses || !nextTitle || nextTitle === ses.title) return;
  try {
    await api.renameSession(sessionId, nextTitle);
    await refreshProjects();
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
export async function toggleSessionPinFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  const pinned = ses.pinnedAt === null;
  patchSession(sessionId, {
    pinnedAt: pinned ? new Date().toISOString() : null,
  });
  try {
    await api.setSessionPinned(sessionId, pinned);
  } catch (e) {
    toast(i18n.t("session:flow.pinFailed", { detail: errorText(e) }), "error");
    await refreshProjects();
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
    body: i18n.t("shell:project.removeBody", {
      sessions: preflight.sessionCount,
      worktrees: preflight.worktreeCount,
      operations:
        preflight.recoverableOperationCount +
        preflight.pendingCommitOperationCount,
    }),
    confirmLabel: i18n.t("common:actions.remove"),
    danger: true,
  });
  if (!ok) return;
  try {
    const outcome = await api.removeProject(preflight);
    if (
      findProjectOf(getState().projects, getState().activeSessionId)?.id ===
      projectId
    ) {
      setState({ activeSessionId: null });
    }
    await refreshProjects();
    const warnings = outcome.stopWarnings + outcome.cleanupWarnings;
    if (warnings > 0) {
      toast(i18n.t("shell:project.removePartial", { count: warnings }), "info");
    }
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
  const pi = agent === "pi";
  try {
    const res = await api.createSession({
      projectId,
      agent,
      title: null,
      presetId: null,
      worktreeId: worktreeId ?? null,
      // Pi and Generic Shell have no permission mode; native is only the API's
      // persisted compatibility sentinel. Other shortcuts explicitly bypass.
      permission: shell || pi ? "native" : "bypass",
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
          res.id,
          splitIntent.direction,
        )
      : false;
    if (!inserted) selectSession(res.id);
    toast(
      pi
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
