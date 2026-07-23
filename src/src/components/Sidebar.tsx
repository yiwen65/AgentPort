// Sidebar (260px): project tree with sessions/worktrees, status dots with
// evidence tooltips, unread badges, context menus (PRD 7.2), empty states.

import StatusDot from "./StatusDot";
import ShellIcon from "./ShellIcon";
import { AgentIcon } from "./AgentIcons";
import { api, errorText } from "../api";
import {
  copyTextWithToast,
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
import { agentDisplay, healthLabel, relativeAge } from "../format";
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
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

type SidebarT = TFunction<["session", "shell", "common"]>;

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
  const theme = useStore((state) => state.themeEffective);
  if (agent === "shell") {
    return <ShellIcon className="quick-agent-mark shell" size={17} />;
  }
  const icon = <AgentIcon agent={agent} className={`quick-agent-mark ${agent}`} size={17} mono={theme === "light"} />;
  return icon ?? <span className="quick-agent-fallback" aria-hidden="true">{agent.slice(0, 1).toUpperCase()}</span>;
}

function quickAgentMode(agent: string, t: SidebarT) {
  if (agent === "shell") return t("shell:ui.sidebar.quickLaunch.terminal");
  if (agent === "pi") return t("shell:ui.sidebar.quickLaunch.localUserPermissions");
  return t("shell:ui.sidebar.quickLaunch.bypassPermissionChecks");
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
  const { t } = useTranslation(["session", "shell", "common"]);
  const agentOrder = useStore((state) => state.settings?.agentOrder);
  const adapters = useStore((state) => state.adapters);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; scrollLeft: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const agents = orderAgentIds(
    agentOrder,
    adapters.map((adapter) => adapter.agentType),
  );

  if (agents.length === 0) return null;

  return (
    <div
      ref={scrollerRef}
      className={`quick-agent-strip${dragging ? " dragging" : ""}`}
      aria-label={t("shell:ui.sidebar.quickLaunch.listLabel", { scope: scopeLabel })}
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
            aria-label={t("shell:ui.sidebar.quickLaunch.launchLabel", {
              scope: scopeLabel,
              agent: agentDisplay(agent),
              mode: quickAgentMode(agent, t),
            })}
            data-tip={t("shell:ui.sidebar.quickLaunch.launchTip", {
              agent: agentDisplay(agent),
              mode: quickAgentMode(agent, t),
            })}
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

function sessionMenu(ses: SessionView, onRemove: () => void, t: SidebarT): MenuItem[] {
  return [
    {
      label: t("session:ui.menu.copyId"),
      action: () => void copyTextWithToast(ses.id, t("session:ui.toast.idCopied")),
    },
    { label: "", separator: true },
    { label: t("session:ui.menu.exportMarkdown"), action: () => openDialog({ kind: "export", sessionId: ses.id, exportKind: "md" }) },
    { label: t("session:ui.menu.exportRawLog"), action: () => openDialog({ kind: "export", sessionId: ses.id, exportKind: "log" }) },
    { label: "", separator: true },
    { label: t("session:ui.menu.restartAndResume"), action: () => void restartSessionFlow(ses.id) },
    {
      label: t("session:ui.menu.interrupt"),
      disabled: ses.lifecycle !== "running",
      action: () => void interruptSessionFlow(ses.id),
    },
    { label: t("session:ui.menu.stop"), danger: true, action: () => void stopSessionFlow(ses.id) },
    { label: "", separator: true },
    { label: t("session:ui.menu.remove"), danger: true, action: onRemove },
  ];
}

function projectMenu(
  p: ProjectView,
  isGitRepository: boolean,
  t: SidebarT,
  opts?: { includeNewSession?: boolean },
): MenuItem[] {
  return [
    ...(opts?.includeNewSession === false
      ? []
      : [{ label: t("session:ui.actions.newEllipsis"), action: () => openNewSessionDialog(p.id) } as MenuItem]),
    {
      label: t("shell:ui.sidebar.projectMenu.newWorktree"),
      disabled: !p.gitRootPath,
      tip: p.gitRootPath ? undefined : t("shell:ui.sidebar.notGitRepository"),
      action: () => openDialog({ kind: "newWorktree", projectId: p.id }),
    },
    {
      label: t("shell:ui.sidebar.projectMenu.manageBranches"),
      disabled: !isGitRepository,
      tip: isGitRepository ? undefined : t("shell:ui.sidebar.notGitRepository"),
      action: () => openDialog({ kind: "branchPicker", projectId: p.id }),
    },
    { label: "", separator: true },
    {
      label: t("shell:ui.sidebar.projectMenu.revealInFileManager"),
      action: () =>
        void api
          .revealInFileManager(p.rootPath)
          .catch((e) => toast(t("shell:ui.sidebar.openFailed", { detail: errorText(e) }), "error")),
    },
    { label: "", separator: true },
    { label: t("shell:ui.sidebar.projectMenu.rename"), action: () => void renameProjectFlow(p.id) },
    { label: t("shell:ui.sidebar.projectMenu.remove"), danger: true, action: () => void removeProjectFlow(p.id) },
  ];
}

function worktreeMenu(
  p: ProjectView,
  w: WorktreeView,
  t: SidebarT,
  opts?: { includeNewSession?: boolean },
): MenuItem[] {
  return [
    ...(opts?.includeNewSession === false
      ? []
      : [{ label: t("session:ui.actions.newEllipsis"), action: () => openNewSessionDialog(p.id, w.id) } as MenuItem]),
    {
      label: t("shell:ui.sidebar.worktreeMenu.copyPath"),
      action: () => void copyTextWithToast(w.path, t("shell:ui.sidebar.toast.pathCopied")),
    },
    {
      label: t("shell:ui.sidebar.worktreeMenu.openInSystemTerminal"),
      action: () =>
        void api
          .openInSystemTerminal(w.path)
          .catch((e) => toast(t("shell:ui.sidebar.openFailed", { detail: errorText(e) }), "error")),
    },
    {
      label: t("shell:ui.sidebar.worktreeMenu.copyGitStatus"),
      action: () =>
        void api
          .worktreeStatusText(w.id)
          .then((st) => copyTextWithToast(st.raw || "(clean)", t("shell:ui.sidebar.toast.gitStatusCopied")))
          .catch((e) => toast(
            t("shell:ui.sidebar.gitStatusFailed", { detail: errorText(e) }),
            "error",
          )),
    },
    { label: "", separator: true },
    {
      label: t("shell:ui.sidebar.worktreeMenu.delete"),
      danger: true,
      disabled: w.health !== "clean",
      tip:
        w.health !== "clean"
          ? t("shell:ui.sidebar.worktreeMenu.deleteBlocked")
          : undefined,
      action: () => void removeWorktreeFlow(w.id),
    },
  ];
}

function SessionRow({ ses, nested }: { ses: SessionView; nested?: boolean }) {
  const { t } = useTranslation(["session", "shell", "common"]);
  const active = useStore((state) => state.activeSessionId === ses.id);
  const pinned = useStore((state) => state.pinnedSessionAt[ses.id] !== undefined);
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
        <span className="remove-confirm-label">{t("session:ui.sidebar.removeConfirm")}</span>
        <span className="remove-confirm-actions">
          <button
            className="btn small ghost"
            autoFocus
            onClick={(event) => { event.stopPropagation(); setConfirmingRemove(false); }}
          >
            {t("common:actions.cancel")}
          </button>
          <button
            className="btn small danger"
            onClick={(event) => { event.stopPropagation(); void removeSessionFlow(ses.id); }}
          >
            {t("common:actions.remove")}
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
        openContextMenu(e.clientX, e.clientY, sessionMenu(ses, () => setConfirmingRemove(true), t));
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
      aria-label={t("session:ui.sidebar.rowLabel", {
        title: ses.title,
        agent: agentDisplay(ses.adapter),
      })}
    >
      <StatusDot session={ses} />
      {editing ? (
        <input
          className="session-title-input"
          value={draftTitle}
          autoFocus
          ref={titleInputRef}
          aria-label={t("session:ui.sidebar.titleLabel")}
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
      <span className="session-row-actions" aria-label={t("session:ui.sidebar.actionsLabel")}>
        <span
          className={"session-action" + (pinned ? " pinned" : "")}
          role="button"
          tabIndex={0}
          aria-label={pinned ? t("session:ui.sidebar.unpin") : t("session:ui.sidebar.pin")}
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
          aria-label={t("session:ui.sidebar.archive")}
          onClick={(event) => { event.stopPropagation(); void archiveSessionFlow(ses.id); }}
        ><IconArchive /></span>
      </span>
      <span className="session-age" aria-label={t("session:ui.sidebar.createdAt", { date: ses.createdAt })}>
        {relativeAge(ses.createdAt)}
      </span>
      {ses.unread ? (
        <span
          className="unread-dot"
          aria-label={t("session:ui.sidebar.unread")}
          data-tip={t("session:ui.sidebar.unread")}
        />
      ) : null}
    </div>
  );
}

function WorktreeNode({ p, w, sessions, highlighted }: { p: ProjectView; w: WorktreeView; sessions: SessionView[]; highlighted: boolean }) {
  const { t } = useTranslation(["session", "shell", "common"]);
  const collapsed = useStore((state) => state.collapsedWorktrees[w.id] === true);
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
            openContextMenu(e.clientX, e.clientY, worktreeMenu(p, w, t));
          }}
          aria-expanded={!collapsed}
          aria-label={t("shell:ui.sidebar.worktreeSummary", {
            branch: w.branch,
            count: sessions.length,
            action: collapsed
              ? t("shell:ui.sidebar.expand")
              : t("shell:ui.sidebar.collapse"),
          })}
        >
          <span className="worktree-collapse-chevron" aria-hidden="true">
            <IconChevron dir={collapsed ? "right" : "down"} />
          </span>
          <span className="tree-label mono" style={{ fontSize: 12 }}>
            ⎇ {w.branch}
          </span>
          <span className={`health-badge ${w.health}`}>{healthLabel(w.health)}</span>
        </button>
        <div
          className="project-quick-actions"
          aria-label={t("shell:ui.sidebar.worktreeQuickActions", { branch: w.branch })}
        >
          <QuickAgentStrip
            projectId={p.id}
            worktreeId={w.id}
            scopeLabel={t("shell:ui.sidebar.worktreeScope", { branch: w.branch })}
          />
          <button
            className="icon-btn tree-action"
            aria-label={t("shell:ui.sidebar.worktreeMoreActions", { branch: w.branch })}
            data-tip={t("shell:ui.sidebar.moreActions")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // 与右键菜单同源，只去掉「新建 Session…」（与新建 Session 弹窗重复）。
              openContextMenu(
                rect.left,
                rect.bottom + 4,
                worktreeMenu(p, w, t, { includeNewSession: false }),
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
  const pinnedSessionAt = useStore((state) => state.pinnedSessionAt);
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
  const { t } = useTranslation("shell");
  return (
    <button
      className="tree-row worktrees-entry"
      onClick={() => openWorktreeView(p.id)}
      aria-label={t("ui.sidebar.worktreesEntryLabel")}
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
  const { t } = useTranslation(["session", "shell", "common"]);
  const expanded = useStore((state) => state.expandedProjects[p.id] !== false);
  const order = useSessionOrder();
  const archiving = useStore((state) => state.archivingSessionIds);
  const archivingSessionIds = new Set(archiving);
  const visibleSessions = p.sessions.filter(
    (session) => !archivingSessionIds.has(session.id),
  );
  const mainSessions = order(visibleSessions.filter((session) => !session.worktreeId));
  const repositoryStatus = useStore((state) => state.repositoryStatuses[p.id]);
  // Branch management is intentionally gated by a live backend probe. The
  // persisted gitRootPath can become stale when a directory is moved or its
  // .git metadata is removed while AgentPort is closed.
  const isGitRepository = repositoryStatus?.isGitRepository === true;
  const checkoutHead = !repositoryStatus
    ? t("shell:ui.sidebar.readingBranch")
    : repositoryStatus.head.kind === "detached"
      ? t("shell:ui.sidebar.detachedAt", {
        oid: repositoryStatus.head.shortOid
          ?? repositoryStatus.head.oid?.slice(0, 12)
          ?? t("common:status.unknown"),
      })
      : repositoryStatus.head.kind === "unborn"
        ? t("shell:ui.sidebar.unbornRepository")
        : repositoryStatus.head.branch ?? t("shell:ui.sidebar.readingBranch");
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
            openContextMenu(e.clientX, e.clientY, projectMenu(p, isGitRepository, t));
          }}
        >
          <IconFolder open={expanded} />
          <span className="tree-label">{p.name}</span>
        </button>
        <div
          className="project-quick-actions"
          aria-label={t("shell:ui.sidebar.projectQuickActions", { project: p.name })}
        >
          <QuickAgentStrip
            projectId={p.id}
            scopeLabel={t("shell:ui.sidebar.projectScope", { project: p.name })}
          />
          <button
            className="icon-btn tree-action"
            aria-label={t("shell:ui.sidebar.projectMoreActions", { project: p.name })}
            data-tip={t("shell:ui.sidebar.moreActions")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // 与右键菜单同源，只去掉「新建 Session…」（与新建 Session 弹窗重复）。
              openContextMenu(
                rect.left,
                rect.bottom + 4,
                projectMenu(p, isGitRepository, t, { includeNewSession: false }),
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
              aria-label={t("shell:ui.sidebar.currentCheckout", {
                head: checkoutHead,
              })}
            >
              <IconBranch />
              <span className="tree-label mono">
                {checkoutHead}
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
          {visibleSessions.length === 0 && p.worktrees.length === 0 ? (
            <div className="tree-empty">
              <span>{t("shell:ui.sidebar.noRunningTasks")}</span>
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
  const { t } = useTranslation(["session", "shell", "common"]);
  const order = useSessionOrder();
  const canCreate = Boolean(p.gitRootPath);
  const archiving = useStore((state) => state.archivingSessionIds);
  const highlightedWorktreeId = useStore((state) => state.highlightedWorktreeId);
  const archivingSessionIds = new Set(archiving);
  return (
    <div className="worktree-view">
      <button
        className="tree-row worktree-back"
        onClick={closeWorktreeView}
        aria-label={t("shell:ui.sidebar.worktreeView.back")}
        data-tip={t("shell:ui.sidebar.worktreeView.back")}
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
        <span className="tree-label">{t("shell:ui.sidebar.projectMenu.newWorktree")}</span>
      </button>
      {p.worktrees.length === 0 ? (
        <div className="tree-empty">
          <span>
            {canCreate
              ? t("shell:ui.sidebar.worktreeView.empty")
              : t("shell:ui.sidebar.worktreeView.unavailable")}
          </span>
        </div>
      ) : (
        p.worktrees.map((w) => (
          <WorktreeNode
            key={w.id}
            p={p}
            w={w}
            highlighted={highlightedWorktreeId === w.id}
            sessions={order(p.sessions.filter(
              (session) =>
                session.worktreeId === w.id &&
                !archivingSessionIds.has(session.id),
            ))}
          />
        ))
      )}
    </div>
  );
}

export default function Sidebar({ collapsed, width }: { collapsed: boolean; width: number }) {
  const { t } = useTranslation(["session", "shell", "common"]);
  const projects = useStore((state) => state.projects);
  const expandedProjects = useStore((state) => state.expandedProjects);
  const collapsedWorktrees = useStore((state) => state.collapsedWorktrees);
  const sidebarWorktreeProjectId = useStore((state) => state.sidebarWorktreeProjectId);
  const allProjectsCollapsed =
    projects.length > 0 && projects.every((project) => expandedProjects[project.id] === false);
  const allWorktreesCollapsed = projects.every((p) =>
    p.worktrees.every((w) => collapsedWorktrees[w.id] === true),
  );
  // Master toggle covers both project groups and worktree session groups.
  const allCollapsed = allProjectsCollapsed && allWorktreesCollapsed;
  const worktreeProject = sidebarWorktreeProjectId
    ? projects.find((p) => p.id === sidebarWorktreeProjectId) ?? null
    : null;
  return (
    <aside
      className={`sidebar${collapsed ? " collapsed" : ""}`}
      aria-label={t("shell:ui.sidebar.label")}
      aria-hidden={collapsed}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <div
        className="sidebar-scroll"
        role="tree"
        aria-label={worktreeProject
          ? t("shell:ui.sidebar.worktreeTreeLabel", { project: worktreeProject.name })
          : t("shell:ui.sidebar.projectTreeLabel")}
      >
        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              ⌘
            </div>
            <div>{t("shell:ui.empty.addDirectoryPrompt")}</div>
            <button className="btn primary" onClick={() => void addProjectFromPickerFlow()}>
              {t("shell:ui.actions.addProject")}
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
          aria-label={t("shell:ui.actions.settings")}
        >
          <IconSettings />
        </button>
        <button
          className="sidebar-footer-action"
          onClick={() => void addProjectFromPickerFlow()}
          aria-label={t("shell:ui.actions.addProject")}
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
          aria-label={allCollapsed
            ? t("shell:ui.sidebar.expandAll")
            : t("shell:ui.sidebar.collapseAll")}
        >
          <IconCollapseProjects collapsed={allCollapsed} />
        </button>
      </div>
    </aside>
  );
}
