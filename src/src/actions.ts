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
  isCurrentProjectsSnapshotRequest,
  isCurrentRepositoryStatusRequest,
  markRepositoryStatusUnavailable,
  openDialog,
  patchSession,
  promptDialog,
  setSessionArchiving,
  setState,
  toast,
  update,
  type EffectiveTheme,
} from "./store";
import {
  applyTerminalSettings,
  applyXtermTheme,
  attachHandle,
  clearUnreadOutputTracking,
  disposeHandle,
  jumpToRecoveryOutput,
  MAX_PERSISTENT_TERMINALS,
  pruneHandles,
  releaseTerminal,
  resetForRestart,
} from "./terminals";
import { agentDisplay } from "./format";
import { i18n } from "./i18n";
import type { LogCursorView } from "./types";

export function isMac(): boolean {
  const os = getState().platform?.os;
  if (os) return os === "macos";
  return navigator.platform.toLowerCase().includes("mac");
}

export async function copyTextWithToast(text: string, successText: string) {
  const copied = await copyText(text);
  toast(copied ? successText : i18n.t("common:feedback.copyFailed"), copied ? "success" : "error");
}

// ---------------------------------------------------------------------------
// boot / refresh
// ---------------------------------------------------------------------------

let refreshTimer: number | null = null;
let timelineRefreshRequest = 0;
let sessionSelectionIntent = 0;

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
    if (res.id) setState({ expandedProjects: {} });
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
        timelineMessage: { code: "timeline_load_failed", technicalDetail: detail },
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
  const theme: EffectiveTheme =
    st.theme === "system" ? (sysDark ? "dark" : "light") : st.theme;
  const sysReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced =
    st.reducedMotion === "system" ? sysReduced : st.reducedMotion === "on";
  document.documentElement.dataset.theme = theme;
  delete document.documentElement.dataset.prepaintTheme;
  document.documentElement.dataset.motion = reduced ? "reduced" : "full";
  // Keep the native window (and with it the sidebar's vibrancy material) on
  // the same appearance as the web content; otherwise a manual theme
  // override would mix a dark NSVisualEffectView with light chrome.
  void setNativeTheme(theme);
  // Native frosted glass is only installed on macOS. Elsewhere the sidebar
  // keeps its solid surface — translucency without a blur behind it reads
  // as dirt, not glass.
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
  applyXtermTheme(theme);
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

export function toggleSidebarCollapsed() {
  const s = getState();
  if (s.sidebarAnim) return; // let the in-flight slide finish
  if (s.reducedMotion) {
    // No slide under reduced motion — commit immediately instead.
    setState({ sidebarCollapsed: !s.sidebarCollapsed });
    return;
  }
  const token = ++sidebarAnimToken;
  if (!s.sidebarCollapsed) {
    setState({ sidebarAnim: "out" });
    window.setTimeout(() => {
      if (token !== sidebarAnimToken) return;
      setState({ sidebarCollapsed: true, sidebarAnim: null });
    }, SIDEBAR_ANIM_MS);
  } else {
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
}

// ---------------------------------------------------------------------------
// session selection
// ---------------------------------------------------------------------------

export function selectSession(id: string, recoveryTarget: LogCursorView | null = null) {
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
        selectSession(id, recoveryTarget);
      }
    });
    return;
  }
  const ses = findSession(s.projects, id);
  // Treat mounted PTY panes as an LRU. Each keeps xterm scrollback and a live
  // IPC channel. Structured JSON-RPC Sessions own a separate attachment and
  // must never acquire a hidden xterm channel. Retaining every PTY Session can
  // turn a long workday into hundreds of MiB of renderer memory.
  const existingPtyIds = s.attachedIds.filter((sessionId) => {
    const attachedSession = findSession(s.projects, sessionId);
    return sessionId !== id && attachedSession?.transport === "pty";
  });
  const orderedIds = ses?.transport === "pty" ? [...existingPtyIds, id] : existingPtyIds;
  const attachedIds = orderedIds.slice(-MAX_PERSISTENT_TERMINALS);
  const retainedIds = new Set(attachedIds);
  const evictedIds = s.attachedIds.filter((sessionId) => !retainedIds.has(sessionId));
  const proj = findProjectOf(s.projects, id);
  const expandedProjects =
    proj && s.expandedProjects[proj.id] === false
      ? { ...s.expandedProjects, [proj.id]: true }
      : s.expandedProjects;
  const collapsedWorktrees = { ...s.collapsedWorktrees };
  if (ses?.worktreeId) delete collapsedWorktrees[ses.worktreeId];
  setState({
    activeSessionId: id,
    attachedIds,
    expandedProjects,
    collapsedWorktrees,
    activeWorktreeStatus: s.activeSessionId === id ? s.activeWorktreeStatus : null,
    termSearchOpen: false,
  });
  for (const evictedId of evictedIds) void releaseTerminal(evictedId);
  clearUnreadOutputTracking(id);
  if (recoveryTarget && ses?.transport === "pty") {
    void jumpToRecoveryOutput(id, recoveryTarget).catch((error) => {
      toast(i18n.t("session:flow.locateRecoveryFailed", { detail: errorText(error) }), "error");
    });
  }
  // Confirm the view in persistent state; merely hiding the dot for the
  // active row would make it reappear as soon as the user switches away.
  void api.markSessionSeen(id, findSession(s.projects, id)?.status ?? null)
    .then(refreshProjects)
    .catch(() => undefined);
  void refreshActiveWorktreeStatus();
}

export function switchSessionByIndex(index: number) {
  const s = getState();
  const archiving = new Set(s.archivingSessionIds);
  const list = flattenSessions(s.projects).filter((session) => !archiving.has(session.id));
  const target = list[index];
  if (target) selectSession(target.id);
}

// ---------------------------------------------------------------------------
// worktree status / "结果尚未提交" notice
// ---------------------------------------------------------------------------

let worktreeStatusRequest = 0;

export async function refreshActiveWorktreeStatus() {
  const s = getState();
  const ses = findSession(s.projects, s.activeSessionId);
  const request = ++worktreeStatusRequest;
  const sessionId = s.activeSessionId;
  const worktreeId = ses?.worktreeId;
  if (!worktreeId) {
    if (request === worktreeStatusRequest && getState().activeSessionId === sessionId) {
      setState({ activeWorktreeStatus: null });
    }
    return;
  }
  try {
    const st = await api.worktreeStatusText(worktreeId);
    const current = getState();
    if (
      request !== worktreeStatusRequest ||
      current.activeSessionId !== sessionId ||
      findSession(current.projects, current.activeSessionId)?.worktreeId !== worktreeId
    ) {
      return;
    }
    setState({ activeWorktreeStatus: st });
  } catch {
    const current = getState();
    if (
      request === worktreeStatusRequest &&
      current.activeSessionId === sessionId &&
      findSession(current.projects, current.activeSessionId)?.worktreeId === worktreeId
    ) {
      setState({ activeWorktreeStatus: null });
    }
  }
}

export function dismissUncommittedNotice(sessionId: string, sequence: number) {
  update((s) => ({ noticeDismissed: { ...s.noticeDismissed, [sessionId]: sequence } }));
}

// ---------------------------------------------------------------------------
// session lifecycle flows
// ---------------------------------------------------------------------------

export async function stopSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  const ok = await confirmDialog({
    title: i18n.t("session:flow.stopTitle", { title: ses.title }),
    body: i18n.t("session:flow.stopBody"),
    confirmLabel: i18n.t("session:flow.stopAction"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.stopSession(sessionId);
    toast(i18n.t("session:flow.stopped"), "success");
  } catch (e) {
    toast(i18n.t("session:flow.stopFailed", { detail: errorText(e) }), "error");
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
      toast(i18n.t("session:flow.stopFailed", { detail: errorText(e) }), "error");
      return;
    }
  }
  try {
    // The selected Session already persists its permission mode. Restart it
    // directly instead of asking the user to acknowledge the same mode again.
    const res = await api.restartSession(sessionId, true);
    resetForRestart(sessionId);
    await refreshProjects();
    void attachHandle(sessionId);
    if (res.resumePrecision === "latest") {
      toast(i18n.t("session:flow.latestResumeNotice"), "info");
    } else if (res.resumePrecision === "unavailable") {
      toast(i18n.t("session:flow.freshStartNotice"), "info");
    }
    for (const notice of localizedNotices(res)) toast(notice, "info");
  } catch (e) {
    toast(i18n.t("session:flow.restartFailed", { detail: errorText(e) }), "error");
  }
}

export async function interruptSessionFlow(sessionId: string) {
  try {
    await api.interruptSession(sessionId);
  } catch (e) {
    toast(i18n.t("session:flow.interruptFailed", { detail: errorText(e) }), "error");
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
    toast(i18n.t("session:flow.archiveFailed", { detail: errorText(e) }), "error");
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
    toast(i18n.t("session:flow.renameFailed", { detail: errorText(e) }), "error");
  }
}

export async function renameSessionInlineFlow(sessionId: string, title: string) {
  const nextTitle = title.trim();
  const ses = findSession(getState().projects, sessionId);
  if (!ses || !nextTitle || nextTitle === ses.title) return;
  try {
    await api.renameSession(sessionId, nextTitle);
    await refreshProjects();
  } catch (e) {
    toast(i18n.t("session:flow.renameFailed", { detail: errorText(e) }), "error");
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
    toast(i18n.t("shell:project.renameFailed", { detail: errorText(e) }), "error");
  }
}

export async function removeProjectFlow(projectId: string) {
  const proj = getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  const ok = await confirmDialog({
    title: i18n.t("shell:project.removeTitle", { name: proj.name }),
    body: i18n.t("shell:project.removeBody"),
    confirmLabel: i18n.t("common:actions.remove"),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.removeProject(projectId);
    if (findProjectOf(getState().projects, getState().activeSessionId)?.id === projectId) {
      setState({ activeSessionId: null });
    }
    await refreshProjects();
  } catch (e) {
    toast(i18n.t("shell:project.removeFailed", { detail: errorText(e) }), "error");
  }
}

export async function removeWorktreeFlow(worktreeId: string) {
  const s = getState();
  for (const p of s.projects) {
    const w = p.worktrees.find((x) => x.id === worktreeId);
    if (!w) continue;
    if (w.health !== "clean") {
      toast(i18n.t("worktree:flow.dirtyDeleteBlocked"), "error");
      return;
    }
    const ok = await confirmDialog({
      title: i18n.t("worktree:flow.deleteTitle", { branch: w.branch }),
      body: i18n.t("worktree:flow.deleteBody", { path: w.path }),
      confirmLabel: i18n.t("worktree:flow.deleteAction"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeWorktree(worktreeId);
      toast(i18n.t("worktree:flow.deleted"), "success");
    } catch (e) {
      toast(i18n.t("worktree:flow.deleteFailed", { detail: errorText(e) }), "error");
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// misc flows
// ---------------------------------------------------------------------------

export function openNewSessionDialog(projectId?: string, worktreeId?: string, agent?: string) {
  const s = getState();
  let pid = projectId;
  if (!pid) {
    pid =
      findProjectOf(s.projects, s.activeSessionId)?.id ?? s.projects[0]?.id;
  }
  if (!pid) {
    toast(i18n.t("session:flow.addProjectFirst"), "info");
    openDialog({ kind: "addProject" });
    return;
  }
  openDialog({ kind: "newSession", projectId: pid, worktreeId, agent });
}

/** Hover shortcuts explicitly start a session in fully-authorized mode. */
export async function quickStartSession(projectId: string, agent: string, worktreeId?: string) {
  const shell = agent === "shell";
  const pi = agent === "pi";
  try {
    const res = await api.createSession({
      projectId,
      agent,
      title: null,
      presetId: null,
      worktreeId: worktreeId ?? null,
      // Generic Shell has no permission protocol; native is a compatibility
      // sentinel only. Agent shortcuts retain their explicit bypass behavior.
      permission: shell || pi ? "native" : "bypass",
      transport: "pty",
      riskAck: true,
      cols: null,
      rows: null,
      extraArgs: null,
    });
    await refreshProjects();
    selectSession(res.id);
    toast(
      i18n.t("session:flow.quickStarted", {
        agent: agentDisplay(agent),
        access: shell
          ? i18n.t("session:flow.terminalAccess")
          : i18n.t("session:flow.fullAccess"),
      }),
      "success",
    );
  } catch (e) {
    toast(i18n.t("session:flow.startFailed", { detail: errorText(e) }), "error");
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
      timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
      timelineError: null,
      timelineMessage: null,
    });
    await refreshProjects();
  } catch (e) {
    toast(i18n.t("session:flow.operationFailed", { detail: errorText(e) }), "error");
  }
}

/** Update a session's status locally (channel already does) and refresh tree. */
export function noteSessionExit(sessionId: string) {
  patchSession(sessionId, { lifecycle: "exited" });
  refreshProjectsSoon();
}
