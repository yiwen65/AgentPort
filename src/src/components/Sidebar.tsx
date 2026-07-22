// Sidebar (260px): project tree with sessions/worktrees, status dots with
// evidence tooltips, unread badges, context menus (PRD 7.2), empty states.

import StatusDot from "./StatusDot";
import ShellIcon from "./ShellIcon";
import { AgentIcon } from "./AgentIcons";
import { api, copyText, errorText } from "../api";
import {
  interruptSessionFlow,
  openNewSessionDialog,
  removeProjectFlow,
  removeWorktreeFlow,
  renameProjectFlow,
  renameSessionInlineFlow,
  restartSessionFlow,
  quickStartSession,
  archiveSessionFlow,
  addProjectFromPickerFlow,
  removeSessionFlow,
  selectSession,
  stopSessionFlow,
  refreshRepositoryStatus,
} from "../actions";
import { agentDisplay, healthZh, relativeAge } from "../format";
import { orderAgentIds } from "../agentOrder";
import {
  closeWorktreeView,
  openContextMenu,
  openDialog,
  openWorktreeView,
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
        <path d="m12.9 3.8 3.3 3.3-2.2 1.2-.5 3.1-2.2 2.2-2.1-2.1-3.1.5-1.2-2.2 3.3-3.3m2.1 6.2-3.5 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M6 4.5h8M7 4.5l.7 6H5.5l1.6 2.25h5.8l1.6-2.25h-2.2l.7-6M10 12.75v3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
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

function IconBranch() {
  return (
    <svg className="tree-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="15" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 7.2v5.6M15 7.2a7.8 7.8 0 0 1-7.8 7.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// Worktree entry: two overlapping checkouts (copy/layers metaphor) — must not
// be confused with the git-branch glyph used for actual branch rows.
function IconWorktree() {
  return (
    <svg className="tree-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconChevron({ dir }: { dir: "left" | "right" | "down" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {dir === "down" ? (
        <path d="m4.5 7.5 5.5 5.5 5.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : dir === "right" ? (
        <path d="m7.5 4.5 5.5 5.5-5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="m12.5 4.5-5.5 5.5 5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

function QuickAgentIcon({ agent }: { agent: string }) {
  const theme = useStore().themeEffective;
  if (agent === "shell") {
    return <ShellIcon className="quick-agent-mark shell" size={17} />;
  }
  const icon = <AgentIcon agent={agent} className={`quick-agent-mark ${agent}`} size={17} mono={theme === "light"} />;
  return icon ?? <span className="quick-agent-fallback" aria-hidden="true">{agent.slice(0, 1).toUpperCase()}</span>;
}

function quickAgentMode(agent: string) {
  if (agent === "shell") return "终端";
  if (agent === "pi") return "本地用户权限";
  return "完全权限";
}

function QuickAgentStrip({
  projectId,
  worktreeId,
  scopeLabel,
}: {
  projectId: string;
  worktreeId?: string;
  scopeLabel: string;
}) {
  const store = useStore();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; scrollLeft: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const agents = orderAgentIds(
    store.settings?.agentOrder,
    store.adapters.map((adapter) => adapter.agentType),
  );

  if (agents.length === 0) return null;

  return (
    <div
      ref={scrollerRef}
      className={`quick-agent-strip${dragging ? " dragging" : ""}`}
      aria-label={`在${scopeLabel}快速启动 Agent；拖动查看全部`}
      onWheel={(event) => {
        const scroller = scrollerRef.current;
        if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        if (delta === 0) return;
        scroller.scrollLeft += delta;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const scroller = scrollerRef.current;
        if (!scroller) return;
        dragRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          scrollLeft: scroller.scrollLeft,
          moved: false,
        };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        const scroller = scrollerRef.current;
        if (!drag || !scroller || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.x;
        if (!drag.moved && Math.abs(delta) > 3) {
          drag.moved = true;
          scroller.setPointerCapture(event.pointerId);
          setDragging(true);
        }
        if (!drag.moved) return;
        scroller.scrollLeft = drag.scrollLeft - delta;
        event.preventDefault();
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        const scroller = scrollerRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
        suppressClickRef.current = drag.moved;
        dragRef.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onClickCapture={(event) => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="quick-agent-strip-track">
        {agents.map((agent) => (
          <button
            key={agent}
            className="project-agent-action"
            aria-label={`在${scopeLabel}启动 ${agentDisplay(agent)}（${quickAgentMode(agent)}）`}
            data-tip={`启动 ${agentDisplay(agent)}（${quickAgentMode(agent)}）`}
            onClick={() => void quickStartSession(projectId, agent, worktreeId)}
          >
            <QuickAgentIcon agent={agent} />
          </button>
        ))}
      </div>
    </div>
  );
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

function sessionMenu(ses: SessionView, onRemove: () => void): MenuItem[] {
  return [
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
    { label: "移除 Session…", danger: true, action: onRemove },
  ];
}

function projectMenu(
  p: ProjectView,
  isGitRepository: boolean,
  opts?: { includeNewSession?: boolean },
): MenuItem[] {
  return [
    ...(opts?.includeNewSession === false
      ? []
      : [{ label: "新建 Session…", action: () => openNewSessionDialog(p.id) } as MenuItem]),
    {
      label: "新建 Worktree…",
      disabled: !p.gitRootPath,
      tip: p.gitRootPath ? undefined : "该目录不是 Git 仓库",
      action: () => openDialog({ kind: "newWorktree", projectId: p.id }),
    },
    {
      label: "管理本地分支…",
      disabled: !isGitRepository,
      tip: isGitRepository ? undefined : "该目录不是 Git 仓库",
      action: () => openDialog({ kind: "branchPicker", projectId: p.id }),
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

function worktreeMenu(
  p: ProjectView,
  w: WorktreeView,
  opts?: { includeNewSession?: boolean },
): MenuItem[] {
  return [
    ...(opts?.includeNewSession === false
      ? []
      : [{ label: "新建 Session…", action: () => openNewSessionDialog(p.id, w.id) } as MenuItem]),
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
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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
  if (confirmingRemove) {
    return (
      <div
        className={"tree-row session remove-confirm" + (nested ? " nested" : "")}
        role="alert"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setConfirmingRemove(false);
          }
        }}
      >
        <span className="remove-confirm-label">从列表移除？</span>
        <span className="remove-confirm-actions">
          <button
            className="btn small ghost"
            autoFocus
            onClick={(event) => { event.stopPropagation(); setConfirmingRemove(false); }}
          >
            取消
          </button>
          <button
            className="btn small danger"
            onClick={(event) => { event.stopPropagation(); void removeSessionFlow(ses.id); }}
          >
            移除
          </button>
        </span>
      </div>
    );
  }
  return (
    <div
      className={"tree-row session" + (nested ? " nested" : "") + (active ? " active" : "")}
      onClick={() => selectSession(ses.id)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, sessionMenu(ses, () => setConfirmingRemove(true)));
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
          onClick={(event) => { event.stopPropagation(); void archiveSessionFlow(ses.id, false); }}
        ><IconArchive /></span>
      </span>
      <span className="session-age" aria-label={`创建于 ${ses.createdAt}`}>
        {relativeAge(ses.createdAt)}
      </span>
      {ses.unread && !active ? <span className="unread-dot" aria-label="有未读更新" data-tip="有未读更新" /> : null}
    </div>
  );
}

function WorktreeNode({ p, w, sessions, highlighted }: { p: ProjectView; w: WorktreeView; sessions: SessionView[]; highlighted: boolean }) {
  const collapsed = useStore().collapsedWorktrees[w.id] === true;
  return (
    <div role="treeitem" aria-expanded={!collapsed}>
      <div className="tree-project-header">
        <button
          className={"tree-row worktree" + (highlighted ? " highlighted" : "")}
          onClick={() =>
            update((s) => ({
              collapsedWorktrees: { ...s.collapsedWorktrees, [w.id]: !collapsed },
            }))
          }
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, worktreeMenu(p, w));
          }}
          aria-expanded={!collapsed}
          aria-label={`Worktree ${w.branch}，${sessions.length} 个会话，${collapsed ? "展开" : "折叠"}`}
        >
          <span className="worktree-collapse-chevron" aria-hidden="true">
            <IconChevron dir={collapsed ? "right" : "down"} />
          </span>
          <span className="tree-label mono" style={{ fontSize: 12 }}>
            ⎇ {w.branch}
          </span>
          <span className={`health-badge ${w.health}`}>{healthZh(w.health)}</span>
        </button>
        <div className="project-quick-actions" aria-label={`在 Worktree ${w.branch} 中快速启动 Agent`}>
          <QuickAgentStrip projectId={p.id} worktreeId={w.id} scopeLabel={`Worktree ${w.branch}`} />
          <button
            className="icon-btn tree-action"
            aria-label={`Worktree ${w.branch} 的更多操作`}
            data-tip="更多操作…"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // 与右键菜单同源，只去掉「新建 Session…」（与新建 Session 弹窗重复）。
              openContextMenu(
                rect.left,
                rect.bottom + 4,
                worktreeMenu(p, w, { includeNewSession: false }),
              );
            }}
          >
            ＋
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div role="group">
          {sessions.map((ses) => (
            <SessionRow key={ses.id} ses={ses} nested />
          ))}
        </div>
      )}
    </div>
  );
}

/** Sidebar session ordering: pinned first (latest pin wins), then newest. */
function useSessionOrder() {
  const pinnedSessionAt = useStore().pinnedSessionAt;
  return (sessions: SessionView[]) =>
    [...sessions].sort((a, b) => {
      const pinnedOrder = (pinnedSessionAt[b.id] ?? 0) - (pinnedSessionAt[a.id] ?? 0);
      if (pinnedOrder !== 0) return pinnedOrder;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
}

/**
 * Pinned "Worktrees" drill-down entry at the top of every project group.
 * It is not a session: no sorting, no inline rename, no context menu.
 */
function WorktreesEntryRow({ p }: { p: ProjectView }) {
  return (
    <button
      className="tree-row worktrees-entry"
      onClick={() => openWorktreeView(p.id)}
      aria-label="Worktrees，进入管理视图"
      aria-haspopup="true"
    >
      <IconWorktree />
      <span className="tree-label">Worktrees</span>
      <span className="worktrees-entry-chevron">
        <IconChevron dir="right" />
      </span>
    </button>
  );
}

function ProjectNode({ p }: { p: ProjectView }) {
  const store = useStore();
  const expanded = store.expandedProjects[p.id] !== false;
  const order = useSessionOrder();
  const mainSessions = order(p.sessions.filter((s) => !s.worktreeId));
  const repositoryStatus = store.repositoryStatuses[p.id];
  // Branch management is intentionally gated by a live backend probe. The
  // persisted gitRootPath can become stale when a directory is moved or its
  // .git metadata is removed while AgentPort is closed.
  const isGitRepository = repositoryStatus?.isGitRepository === true;
  useEffect(() => {
    const refresh = () => void refreshRepositoryStatus(p.id);
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [p.id]);
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
            openContextMenu(e.clientX, e.clientY, projectMenu(p, isGitRepository));
          }}
        >
          <IconFolder open={expanded} />
          <span className="tree-label">{p.name}</span>
        </button>
        <div className="project-quick-actions" aria-label={`在项目 ${p.name} 中快速启动 Agent`}>
          <QuickAgentStrip projectId={p.id} scopeLabel={`项目 ${p.name}`} />
          <button
            className="icon-btn tree-action"
            aria-label={`项目 ${p.name} 的更多操作`}
            data-tip="更多操作…"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // 与右键菜单同源，只去掉「新建 Session…」（与新建 Session 弹窗重复）。
              openContextMenu(
                rect.left,
                rect.bottom + 4,
                projectMenu(p, isGitRepository, { includeNewSession: false }),
              );
            }}
          >
            ＋
          </button>
        </div>
      </div>
      {expanded ? (
        <div role="group">
          {isGitRepository ? (
            <button
              className="tree-row current-branch-row"
              onClick={() => openDialog({ kind: "branchPicker", projectId: p.id })}
              aria-current="page"
              aria-label={`当前 checkout：${repositoryStatus?.head.kind === "detached" ? `Detached @ ${repositoryStatus.head.shortOid ?? repositoryStatus.head.oid?.slice(0, 12) ?? "unknown"}` : repositoryStatus?.head.branch ?? "正在读取"}。管理本地分支`}
            >
              <IconBranch />
              <span className="tree-label mono">
                {repositoryStatus?.head.kind === "detached"
                  ? `Detached @ ${repositoryStatus.head.shortOid ?? repositoryStatus.head.oid?.slice(0, 12) ?? "unknown"}`
                  : repositoryStatus?.head.kind === "unborn"
                    ? "未初始化仓库"
                    : repositoryStatus?.head.branch ?? "读取分支中…"}
              </span>
            </button>
          ) : null}
          {/* The Worktrees drill-down entry appears only after at least one
              worktree was created under the project (creation stays in the
              project context menu). */}
          {p.worktrees.length > 0 ? <WorktreesEntryRow p={p} /> : null}
          {mainSessions.map((ses) => (
            <SessionRow key={ses.id} ses={ses} />
          ))}
          {p.sessions.length === 0 && p.worktrees.length === 0 ? (
            <div className="tree-empty">
              <span>还没有运行中的任务</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Worktree management view: replaces the sidebar project list when a
 * "Worktrees" entry row is activated. Sessions stay grouped under their
 * worktree so branch context and the guarded delete flow remain intact.
 */
function WorktreeSessionsView({ p }: { p: ProjectView }) {
  const store = useStore();
  const order = useSessionOrder();
  const canCreate = Boolean(p.gitRootPath);
  return (
    <div className="worktree-view">
      <button
        className="tree-row worktree-back"
        onClick={closeWorktreeView}
        aria-label="返回主会话列表"
        data-tip="返回主会话列表"
      >
        <span className="worktree-back-icon">
          <IconChevron dir="left" />
        </span>
        <span className="tree-label">{p.name}</span>
      </button>
      <button
        className="tree-row worktree-new"
        disabled={!canCreate}
        onClick={() => openDialog({ kind: "newWorktree", projectId: p.id })}
      >
        <IconPlus />
        <span className="tree-label">新建 Worktree…</span>
      </button>
      {p.worktrees.length === 0 ? (
        <div className="tree-empty">
          <span>{canCreate ? "还没有 Worktree" : "该目录不是 Git 仓库，无法使用 Worktree"}</span>
        </div>
      ) : (
        p.worktrees.map((w) => (
          <WorktreeNode
            key={w.id}
            p={p}
            w={w}
            highlighted={store.highlightedWorktreeId === w.id}
            sessions={order(p.sessions.filter((session) => session.worktreeId === w.id))}
          />
        ))
      )}
    </div>
  );
}

export default function Sidebar({ collapsed, width }: { collapsed: boolean; width: number }) {
  const s = useStore();
  const projects = s.projects;
  const allProjectsCollapsed =
    projects.length > 0 && projects.every((project) => s.expandedProjects[project.id] === false);
  const allWorktreesCollapsed = projects.every((p) =>
    p.worktrees.every((w) => s.collapsedWorktrees[w.id] === true),
  );
  // Master toggle covers both project groups and worktree session groups.
  const allCollapsed = allProjectsCollapsed && allWorktreesCollapsed;
  const worktreeProject = s.sidebarWorktreeProjectId
    ? projects.find((p) => p.id === s.sidebarWorktreeProjectId) ?? null
    : null;
  return (
    <aside
      className={`sidebar${collapsed ? " collapsed" : ""}`}
      aria-label="项目与会话"
      aria-hidden={collapsed}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <div
        className="sidebar-scroll"
        role="tree"
        aria-label={worktreeProject ? `${worktreeProject.name} 的 Worktree 会话` : "项目树"}
      >
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
        ) : worktreeProject ? (
          <WorktreeSessionsView p={worktreeProject} />
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
            update((state) => {
              const collapse = !allCollapsed;
              return {
                expandedProjects: Object.fromEntries(
                  state.projects.map((project) => [project.id, !collapse]),
                ),
                collapsedWorktrees: Object.fromEntries(
                  state.projects.flatMap((p) => p.worktrees.map((w) => [w.id, collapse])),
                ),
              };
            })
          }
          disabled={projects.length === 0}
          aria-label={allCollapsed ? "展开所有项目与 Worktree" : "折叠所有项目与 Session"}
        >
          <IconCollapseProjects collapsed={allCollapsed} />
        </button>
      </div>
    </aside>
  );
}
