// High-level user flows: confirm dialogs + backend calls + store updates.
// Components stay declarative; side effects live here.

import { api, errorText } from "./api";
import {
  applyProjectsSnapshot,
  clearSessionScopedState,
  confirmDialog,
  findProjectOf,
  findSession,
  flattenSessions,
  getState,
  openDialog,
  patchSession,
  promptDialog,
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
  MAX_PERSISTENT_TERMINALS,
  pruneHandles,
  releaseTerminal,
  resetForRestart,
} from "./terminals";
import { agentDisplay } from "./format";

export function isMac(): boolean {
  const os = getState().platform?.os;
  if (os) return os === "macos";
  return navigator.platform.toLowerCase().includes("mac");
}

// ---------------------------------------------------------------------------
// boot / refresh
// ---------------------------------------------------------------------------

let refreshTimer: number | null = null;

export async function refreshProjects() {
  const active = getState().activeSessionId;
  try {
    const projects = await api.listProjects(active);
    applyProjectsSnapshot(projects);
    pruneHandles();
  } catch {
    // The backend is the source of truth; keep the last good tree on error.
  }
}

/** Read the checkout state after every branch operation; no optimistic switch. */
export async function refreshRepositoryStatus(projectId: string) {
  try {
    const status = await api.getRepositoryStatus(projectId);
    update((state) => ({
      repositoryStatuses: { ...state.repositoryStatuses, [projectId]: status },
    }));
    return status;
  } catch {
    // A failed live probe must not leave branch entry points enabled from a
    // persisted gitRootPath or an older repository snapshot. A later focus or
    // manual refresh will repopulate the backend-confirmed status.
    update((state) => {
      const repositoryStatuses = { ...state.repositoryStatuses };
      delete repositoryStatuses[projectId];
      return { repositoryStatuses };
    });
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
    toast(res.focusedExisting ? "该项目已在列表中，已为你聚焦" : `已添加项目「${res.name ?? path}」`, res.focusedExisting ? "info" : "success");
    if (res.id) setState({ expandedProjects: {} });
  } catch (e) {
    toast(`添加项目失败：${errorText(e)}`, "error");
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
  try {
    const timeline = await api.getTimeline();
    setState({ timeline });
  } catch {
    // ignore — badge keeps stale count
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

// ---------------------------------------------------------------------------
// session selection
// ---------------------------------------------------------------------------

export function selectSession(id: string) {
  const s = getState();
  // A newly created Session is persisted before the next project snapshot.
  // Never select against the stale tree: TerminalArea cannot mount a pane for
  // an ID it cannot resolve, which leaves the workspace blank on a fast switch.
  if (!findSession(s.projects, id)) {
    void refreshProjects().then(() => {
      if (findSession(getState().projects, id)) selectSession(id);
    });
    return;
  }
  // Treat mounted terminal panes as an LRU. Each keeps an xterm scrollback
  // and a live IPC channel, so retaining every Session ever visited can turn a
  // long workday into hundreds of MiB of renderer memory.
  const orderedIds = [...s.attachedIds.filter((sessionId) => sessionId !== id), id];
  const evictedIds = orderedIds.slice(0, Math.max(0, orderedIds.length - MAX_PERSISTENT_TERMINALS));
  const attachedIds = orderedIds.slice(-MAX_PERSISTENT_TERMINALS);
  const proj = findProjectOf(s.projects, id);
  const expandedProjects =
    proj && s.expandedProjects[proj.id] === false
      ? { ...s.expandedProjects, [proj.id]: true }
      : s.expandedProjects;
  const ses = findSession(s.projects, id);
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
  // Confirm the view in persistent state; merely hiding the dot for the
  // active row would make it reappear as soon as the user switches away.
  void api.markSessionSeen(id, findSession(s.projects, id)?.status ?? null)
    .then(refreshProjects)
    .catch(() => undefined);
  void refreshActiveWorktreeStatus();
}

export function switchSessionByIndex(index: number) {
  const list = flattenSessions(getState().projects);
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
    title: `停止 Session「${ses.title}」？`,
    body: "将终止完整进程组并保留可恢复记录；Agent 未保存的上下文可能丢失。",
    confirmLabel: "停止 Session",
    danger: true,
  });
  if (!ok) return;
  try {
    await api.stopSession(sessionId);
    toast("已停止 Session（进程组已清理）", "success");
  } catch (e) {
    toast(`停止失败：${errorText(e)}`, "error");
  }
}

export async function restartSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  if (ses.lifecycle === "running" || ses.lifecycle === "creating") {
    const ok = await confirmDialog({
      title: `重启并恢复「${ses.title}」？`,
      body: "Session 正在运行。重启将先停止当前进程组，再按恢复信息重新启动。",
      confirmLabel: "停止并重启",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.stopSession(sessionId);
    } catch (e) {
      toast(`停止失败：${errorText(e)}`, "error");
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
      toast("将从最近会话恢复，可能不包含本次完整上下文", "info");
    } else if (res.resumePrecision === "unavailable") {
      toast("该 Agent 不支持恢复上下文，已启动全新会话", "info");
    }
    for (const n of res.notes ?? []) toast(n, "info");
  } catch (e) {
    toast(`重启失败：${errorText(e)}`, "error");
  }
}

export async function interruptSessionFlow(sessionId: string) {
  try {
    await api.interruptSession(sessionId);
  } catch (e) {
    toast(`中断失败：${errorText(e)}`, "error");
  }
}

export async function archiveSessionFlow(sessionId: string, requireConfirm = true) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  if (requireConfirm) {
    const ok = await confirmDialog({
      title: `归档 Session「${ses.title}」？`,
      body: "归档后从项目树移除并停止运行；日志与元数据保留，可在设置中恢复或手动永久删除。",
      confirmLabel: "归档",
    });
    if (!ok) return;
  }
  try {
    await api.archiveSession(sessionId);
    const wasActive = getState().activeSessionId === sessionId;
    disposeHandle(sessionId);
    clearSessionScopedState(sessionId);
    await refreshProjects();
    if (wasActive && getState().activeSessionId === null) {
      const next = flattenSessions(getState().projects).find((session) => session.id !== sessionId);
      if (next) selectSession(next.id);
    }
  } catch (e) {
    toast(`归档失败：${errorText(e)}`, "error");
  }
}

/** UI-level removal uses the archive operation; archived Sessions are kept
    until explicitly restored or permanently deleted in Settings. Confirmation
    happens inline in the Session row (Sidebar), not as a modal. */
export async function removeSessionFlow(sessionId: string) {
  await archiveSessionFlow(sessionId, false);
}

export async function renameSessionFlow(sessionId: string) {
  const ses = findSession(getState().projects, sessionId);
  if (!ses) return;
  const title = await promptDialog({
    title: "重命名 Session",
    label: "新标题",
    initial: ses.title,
    okLabel: "重命名",
  });
  if (!title || !title.trim() || title.trim() === ses.title) return;
  try {
    await api.renameSession(sessionId, title.trim());
  } catch (e) {
    toast(`重命名失败：${errorText(e)}`, "error");
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
    toast(`重命名失败：${errorText(e)}`, "error");
  }
}

// ---------------------------------------------------------------------------
// project / worktree flows
// ---------------------------------------------------------------------------

export async function renameProjectFlow(projectId: string) {
  const proj = getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  const name = await promptDialog({
    title: "重命名项目",
    label: "新名称",
    initial: proj.name,
    okLabel: "重命名",
  });
  if (!name || !name.trim() || name.trim() === proj.name) return;
  try {
    await api.renameProject(projectId, name.trim());
    await refreshProjects();
  } catch (e) {
    toast(`重命名失败：${errorText(e)}`, "error");
  }
}

export async function removeProjectFlow(projectId: string) {
  const proj = getState().projects.find((p) => p.id === projectId);
  if (!proj) return;
  const ok = await confirmDialog({
    title: `从 AgentPort 移除「${proj.name}」？`,
    body: "仅移除应用内记录与其 Session，不会删除磁盘上的项目目录。",
    confirmLabel: "移除",
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
    toast(`移除失败：${errorText(e)}`, "error");
  }
}

export async function removeWorktreeFlow(worktreeId: string) {
  const s = getState();
  for (const p of s.projects) {
    const w = p.worktrees.find((x) => x.id === worktreeId);
    if (!w) continue;
    if (w.health !== "clean") {
      toast("该 Worktree 有未提交或未跟踪文件，已阻止删除。", "error");
      return;
    }
    const ok = await confirmDialog({
      title: `删除 Worktree「${w.branch}」？`,
      body: `将删除目录 ${w.path} 并清理 Git Worktree 记录。`,
      confirmLabel: "删除 Worktree",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeWorktree(worktreeId);
      toast("Worktree 已删除", "success");
    } catch (e) {
      toast(`删除失败：${errorText(e)}`, "error");
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
    toast("请先添加一个项目", "info");
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
    toast(`Session 已启动（${agentDisplay(agent)} · ${shell ? "终端" : "完全权限"}）`, "success");
  } catch (e) {
    toast(`启动失败：${errorText(e)}`, "error");
  }
}

export async function ackTimelineFlow() {
  try {
    await api.ackTimeline();
    await refreshTimeline();
    await refreshProjects();
  } catch (e) {
    toast(`操作失败：${errorText(e)}`, "error");
  }
}

/** Update a session's status locally (channel already does) and refresh tree. */
export function noteSessionExit(sessionId: string) {
  patchSession(sessionId, { lifecycle: "exited" });
  refreshProjectsSoon();
}
