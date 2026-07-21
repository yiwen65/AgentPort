// Sidebar (260px): project tree with sessions/worktrees, status dots with
// evidence tooltips, unread badges, context menus (PRD 7.2), empty states.

import StatusDot from "./StatusDot";
import ShellIcon from "./ShellIcon";
import { agentIconSrc } from "../agentIcons";
import { api, copyText, errorText } from "../api";
import {
  interruptSessionFlow,
  openNewSessionDialog,
  removeProjectFlow,
  removeWorktreeFlow,
  renameProjectFlow,
  renameSessionFlow,
  renameSessionInlineFlow,
  restartSessionFlow,
  quickStartSession,
  archiveSessionFlow,
  addProjectFromPickerFlow,
  removeSessionFlow,
  selectSession,
  stopSessionFlow,
} from "../actions";
import { agentDisplay, healthZh, relativeAge } from "../format";
import {
  openContextMenu,
  openDialog,
  toast,
  update,
  useStore,
  type MenuItem,
} from "../store";
import type { ProjectView, SessionView, WorktreeView } from "../types";
import { useEffect, useRef, useState, type CSSProperties } from "react";

function IconFolder({ open = false }: { open?: boolean }) {
  return (
    <svg className="tree-icon" width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {open ? (
        <path d="M2.75 6.5h5l1.55 1.75h7.95l-1.15 7.1a1.5 1.5 0 0 1-1.48 1.26H4.3a1.5 1.5 0 0 1-1.48-1.26L2.75 6.5Z" fill="currentColor" opacity=".86" />
      ) : (
        <path d="M3.25 5.25c0-.83.67-1.5 1.5-1.5H8l1.5 1.75h5.75c.83 0 1.5.67 1.5 1.5v7.25c0 .83-.67 1.5-1.5 1.5H4.75c-.83 0-1.5-.67-1.5-1.5V5.25Z" fill="currentColor" opacity=".86" />
      )}
    </svg>
  );
}

function IconSettings() {
  return <span className="settings-glyph" aria-hidden="true">⚙︎</span>;
}

function IconPlus() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function IconPin({ pinned }: { pinned: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {pinned ? (
        <path d="M6 4.5h8M7 4.5l.7 6H5.5l1.6 2.25h5.8l1.6-2.25h-2.2l.7-6M10 12.75v3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="m12.9 3.8 3.3 3.3-2.2 1.2-.5 3.1-2.2 2.2-2.1-2.1-3.1.5-1.2-2.2 3.3-3.3m2.1 6.2-3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function IconArchive() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.5 7.25h13v8.25H3.5zM2.75 4.5h14.5v2.75H2.75zM7.25 10.75h5.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function QuickAgentIcon({ agent }: { agent: "shell" | "codex" | "claude" | "kimi" }) {
  const theme = useStore().themeEffective;
  if (agent === "shell") {
    return <ShellIcon className="quick-agent-mark shell" size={17} />;
  }
  const src = agentIconSrc(agent, theme);
  if (!src) return null;
  return <img className={`quick-agent-mark ${agent}`} src={src} alt="" aria-hidden="true" />;
}

function IconCollapseProjects({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {collapsed ? (
        <path d="M5.5 5v4.25m-2.25-2.25L5.5 9.25 7.75 7M14.5 15v-4.25m-2.25 2.25 2.25-2.25L16.75 13" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M5.5 9.25V5m-2.25 2.25L5.5 5 7.75 7.25M14.5 10.75V15m-2.25-2.25 2.25 2.25 2.25-2.25" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function sessionMenu(ses: SessionView): MenuItem[] {
  return [
    { label: "打开", action: () => selectSession(ses.id) },
    { label: "重命名…", action: () => void renameSessionFlow(ses.id) },
    {
      label: "复制 Session ID",
      action: () => void copyText(ses.id).then((ok) => toast(ok ? "已复制 Session ID" : "复制失败", ok ? "success" : "error")),
    },
    { label: "", separator: true },
    { label: "导出 Markdown…", action: () => openDialog({ kind: "export", sessionId: ses.id, exportKind: "md" }) },
    { label: "导出原始日志…", action: () => openDialog({ kind: "export", sessionId: ses.id, exportKind: "log" }) },
    { label: "", separator: true },
    { label: "重启并恢复…", action: () => void restartSessionFlow(ses.id) },
    {
      label: "中断（Ctrl-C）",
      disabled: ses.lifecycle !== "running",
      action: () => void interruptSessionFlow(ses.id),
    },
    { label: "停止 Session…", danger: true, action: () => void stopSessionFlow(ses.id) },
    { label: "", separator: true },
    { label: "归档", action: () => void archiveSessionFlow(ses.id) },
    { label: "移除 Session…", danger: true, action: () => void removeSessionFlow(ses.id) },
  ];
}

function projectMenu(p: ProjectView): MenuItem[] {
  return [
    { label: "新建 Session…", action: () => openNewSessionDialog(p.id) },
    {
      label: "新建 Worktree…",
      disabled: !p.gitRootPath,
      tip: p.gitRootPath ? undefined : "该目录不是 Git 仓库",
      action: () => openDialog({ kind: "newWorktree", projectId: p.id }),
    },
    { label: "", separator: true },
    {
      label: "在系统文件管理器中显示",
      action: () =>
        void api
          .revealInFileManager(p.rootPath)
          .catch((e) => toast(`打开失败：${errorText(e)}`, "error")),
    },
    { label: "", separator: true },
    { label: "重命名项目…", action: () => void renameProjectFlow(p.id) },
    { label: "从 AgentPort 移除（不删除目录）", danger: true, action: () => void removeProjectFlow(p.id) },
  ];
}

function quickLaunchMenu(projectId: string): MenuItem[] {
  return [
    { label: "Claude Code", action: () => openNewSessionDialog(projectId, undefined, "claude") },
    { label: "Codex", action: () => openNewSessionDialog(projectId, undefined, "codex") },
    { label: "Kimi Code", action: () => openNewSessionDialog(projectId, undefined, "kimi") },
    { label: "Generic Shell", action: () => openNewSessionDialog(projectId, undefined, "shell") },
    { label: "", separator: true },
    { label: "详细配置…", action: () => openNewSessionDialog(projectId) },
  ];
}

function openQuickLaunch(projectId: string, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  openContextMenu(rect.left, rect.bottom + 4, quickLaunchMenu(projectId));
}

function worktreeMenu(p: ProjectView, w: WorktreeView): MenuItem[] {
  return [
    { label: "新建 Session…", action: () => openNewSessionDialog(p.id, w.id) },
    {
      label: "复制路径",
      action: () => void copyText(w.path).then((ok) => toast(ok ? "已复制路径" : "复制失败", ok ? "success" : "error")),
    },
    {
      label: "在系统终端中打开",
      action: () =>
        void api
          .openInSystemTerminal(w.path)
          .catch((e) => toast(`打开失败：${errorText(e)}`, "error")),
    },
    {
      label: "复制 git status",
      action: () =>
        void api
          .worktreeStatusText(w.id)
          .then((st) => copyText(st.raw || "(clean)"))
          .then((ok) => toast(ok ? "已复制 git status" : "复制失败", ok ? "success" : "error"))
          .catch((e) => toast(errorText(e), "error")),
    },
    { label: "", separator: true },
    {
      label: "删除 Worktree…",
      danger: true,
      disabled: w.health !== "clean",
      tip:
        w.health !== "clean"
          ? "该 Worktree 有未提交或未跟踪文件，已阻止删除。\n请先提交或清理后重试。"
          : undefined,
      action: () => void removeWorktreeFlow(w.id),
    },
  ];
}

function SessionRow({ ses, nested }: { ses: SessionView; nested?: boolean }) {
  const store = useStore();
  const active = store.activeSessionId === ses.id;
  const pinned = store.pinnedSessionAt[ses.id] !== undefined;
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(ses.title);
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) setDraftTitle(ses.title);
  }, [editing, ses.title]);
  useEffect(() => {
    if (editing) titleInputRef.current?.select();
  }, [editing]);
  const saveTitle = () => {
    setEditing(false);
    void renameSessionInlineFlow(ses.id, draftTitle);
  };
  return (
    <div
      className={"tree-row session" + (nested ? " nested" : "") + (active ? " active" : "")}
      onClick={() => selectSession(ses.id)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, sessionMenu(ses));
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSession(ses.id);
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={active ? "true" : undefined}
      aria-label={`${ses.title}，${agentDisplay(ses.adapter)}`}
    >
      <StatusDot session={ses} />
      {editing ? (
        <input
          className="session-title-input"
          value={draftTitle}
          autoFocus
          ref={titleInputRef}
          aria-label="Session 标题"
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={saveTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveTitle();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraftTitle(ses.title);
              setEditing(false);
            }
          }}
        />
      ) : <span className="tree-label">{ses.title}</span>}
      <span className="session-row-actions" aria-label="Session 操作">
        <span
          className={"session-action" + (pinned ? " pinned" : "")}
          role="button"
          tabIndex={0}
          aria-label={pinned ? "取消置顶" : "置顶"}
          onClick={(event) => {
            event.stopPropagation();
            update((state) => {
              const pinnedSessionAt = { ...state.pinnedSessionAt };
              if (pinned) delete pinnedSessionAt[ses.id];
              else pinnedSessionAt[ses.id] = Date.now();
              return { pinnedSessionAt };
            });
          }}
        ><IconPin pinned={pinned} /></span>
        <span
          className="session-action"
          role="button"
          tabIndex={0}
          aria-label="归档"
          onClick={(event) => { event.stopPropagation(); void archiveSessionFlow(ses.id); }}
        ><IconArchive /></span>
      </span>
      <span className="session-age" aria-label={`创建于 ${ses.createdAt}`}>
        {relativeAge(ses.createdAt)}
      </span>
      {ses.unread && !active ? <span className="unread-dot" aria-label="有未读更新" data-tip="有未读更新" /> : null}
    </div>
  );
}

function WorktreeNode({ p, w }: { p: ProjectView; w: WorktreeView }) {
  const sessions = p.sessions.filter((s) => s.worktreeId === w.id);
  return (
    <div role="treeitem" aria-expanded="true">
      <button
        className="tree-row worktree"
        onContextMenu={(e) => {
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, worktreeMenu(p, w));
        }}
        data-tip={`${w.branch}\n${w.path}`}
      >
        <span className="tree-label mono" style={{ fontSize: 12 }}>
          ⎇ {w.branch}
        </span>
        <span className={`health-badge ${w.health}`}>{healthZh(w.health)}</span>
      </button>
      {sessions.map((ses) => (
        <SessionRow key={ses.id} ses={ses} nested />
      ))}
    </div>
  );
}

function ProjectNode({ p }: { p: ProjectView }) {
  const store = useStore();
  const expanded = store.expandedProjects[p.id] !== false;
  const order = (sessions: SessionView[]) =>
    [...sessions].sort((a, b) => {
      const pinnedOrder = (store.pinnedSessionAt[b.id] ?? 0) - (store.pinnedSessionAt[a.id] ?? 0);
      if (pinnedOrder !== 0) return pinnedOrder;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  const mainSessions = order(p.sessions.filter((s) => !s.worktreeId));
  return (
    <div className="tree-project" role="treeitem" aria-expanded={expanded} aria-label={p.name}>
      <div className="tree-project-header">
        <button
          className="tree-row project"
          onClick={() =>
            update((s) => ({ expandedProjects: { ...s.expandedProjects, [p.id]: !expanded } }))
          }
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, projectMenu(p));
          }}
          data-tip={p.rootPath}
        >
          <IconFolder open={expanded} />
          <span className="tree-label">{p.name}</span>
        </button>
        <div className="project-quick-actions" aria-label={`在项目 ${p.name} 中快速启动 Agent`}>
          {(["shell", "codex", "claude", "kimi"] as const).map((agent) => (
            <button
              key={agent}
              className="project-agent-action"
              aria-label={`启动 ${agentDisplay(agent)}（${agent === "shell" ? "终端" : "完全权限"}）`}
              data-tip={`启动 ${agentDisplay(agent)}（${agent === "shell" ? "终端" : "完全权限"}）`}
              onClick={() => void quickStartSession(p.id, agent)}
            >
              <QuickAgentIcon agent={agent} />
            </button>
          ))}
          <button
            className="icon-btn tree-action"
            aria-label={`在项目 ${p.name} 中详细配置新 Session`}
            data-tip="详细配置…"
            onClick={(e) => openQuickLaunch(p.id, e.currentTarget)}
          >
            ＋
          </button>
        </div>
      </div>
      {expanded ? (
        <div role="group">
          {mainSessions.map((ses) => (
            <SessionRow key={ses.id} ses={ses} />
          ))}
          {p.worktrees.map((w) => (
            <WorktreeNode key={w.id} p={p} w={w} />
          ))}
          {p.sessions.length === 0 && p.worktrees.length === 0 ? (
            <div className="tree-empty">
              <span>还没有运行中的任务</span>
              <button
                className="btn small ghost"
                onClick={(e) => openQuickLaunch(p.id, e.currentTarget)}
              >
                新建 Session
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function Sidebar({ collapsed, width }: { collapsed: boolean; width: number }) {
  const s = useStore();
  const projects = s.projects;
  const allProjectsCollapsed =
    projects.length > 0 && projects.every((project) => s.expandedProjects[project.id] === false);
  return (
    <aside
      className={`sidebar${collapsed ? " collapsed" : ""}`}
      aria-label="项目与会话"
      aria-hidden={collapsed}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <div className="sidebar-scroll" role="tree" aria-label="项目树">
        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              ⌘
            </div>
            <div>添加一个代码目录，开始第一个持久 Session。</div>
            <button className="btn primary" onClick={() => void addProjectFromPickerFlow()}>
              添加项目
            </button>
          </div>
        ) : (
          projects.map((p) => <ProjectNode key={p.id} p={p} />)
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="sidebar-footer-action"
          onClick={() => openDialog({ kind: "settings" })}
          aria-label="设置"
        >
          <IconSettings />
        </button>
        <button
          className="sidebar-footer-action"
          onClick={() => void addProjectFromPickerFlow()}
          aria-label="添加项目"
        >
          <IconPlus />
        </button>
        <span className="sidebar-footer-spacer" />
        <button
          className="sidebar-footer-action collapse-projects"
          onClick={() =>
            update((state) => ({
              expandedProjects: Object.fromEntries(
                state.projects.map((project) => [project.id, allProjectsCollapsed]),
              ),
            }))
          }
          disabled={projects.length === 0}
          aria-label={allProjectsCollapsed ? "展开所有项目" : "折叠所有项目与 Session"}
        >
          <IconCollapseProjects collapsed={allProjectsCollapsed} />
        </button>
      </div>
    </aside>
  );
}
