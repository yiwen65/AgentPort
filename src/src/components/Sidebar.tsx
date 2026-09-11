// Sidebar (260px): project tree with sessions/worktrees, status dots with
// evidence tooltips, unread badges, context menus (PRD 7.2), empty states.

import StatusDot from "./StatusDot";
import ShellIcon from "./ShellIcon";
import { AgentIcon, hasAgentIcon } from "./AgentIcons";
import { isAddedAgent } from "../agentCapabilities";
import { api, errorText } from "../api";
import {
  copyTextWithToast,
  openNewSessionDialog,
  removeProjectFlow,
  removeWorktreeFlow,
  renameProjectFlow,
  renameSessionInlineFlow,
  resumeSessionFlow,
  restartSessionFlow,
  quickStartSession,
  archiveSessionFlow,
  addProjectFromPickerFlow,
  removeSessionFlow,
  selectSession,
  stopSessionFlow,
  refreshRepositoryStatus,
  saveProjectLayoutFlow,
  toggleSessionPinFlow,
} from "../actions";
import { agentDisplay, healthLabel, relativeAge } from "../format";
import { orderAgentIds, visibleAgentIds } from "../agentOrder";
import {
  closeWorktreeView,
  openContextMenu,
  openDialog,
  openWorktreeView,
  persistProjectExpansion,
  toast,
  update,
  useStore,
  type MenuItem,
} from "../store";
import type {
  ProjectView,
  SessionView,
  WorktreeHealthStr,
  WorktreeView,
} from "../types";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { openGitCenter } from "../gitCenter";
import {
  orderedLayoutSessionIds,
  type PaneLayout,
} from "../paneLayout";
import { writeSessionPaneDragPayload } from "../paneSessionDrag";
import { beginNativeSessionDrag } from "../sessionNativeDrag";
import {
  moveProjectInLayout,
  projectDropTarget,
  projectLayoutEntries,
  sameProjectLayout,
  setProjectPinnedAtFront,
} from "../projectLayout";

import "./SidebarGroups.css";

type SidebarT = TFunction<["session", "shell", "common", "git"]>;

function IconFolder({ open = false }: { open?: boolean }) {
  return (
    <svg
      className="tree-icon"
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {open ? (
        <path
          d="M2.75 6.5h5l1.55 1.75h7.95l-1.15 7.1a1.5 1.5 0 0 1-1.48 1.26H4.3a1.5 1.5 0 0 1-1.48-1.26L2.75 6.5Z"
          fill="currentColor"
          opacity=".86"
        />
      ) : (
        <path
          d="M3.25 5.25c0-.83.67-1.5 1.5-1.5H8l1.5 1.75h5.75c.83 0 1.5.67 1.5 1.5v7.25c0 .83-.67 1.5-1.5 1.5H4.75c-.83 0-1.5-.67-1.5-1.5V5.25Z"
          fill="currentColor"
          opacity=".86"
        />
      )}
    </svg>
  );
}

function IconSettings() {
  return (
    <span className="settings-glyph" aria-hidden="true">
      ⚙︎
    </span>
  );
}

function IconPlus() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10 4v12M4 10h12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconPin({ pinned }: { pinned: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {pinned ? (
        <path
          d="m12.9 3.8 3.3 3.3-2.2 1.2-.5 3.1-2.2 2.2-2.1-2.1-3.1.5-1.2-2.2 3.3-3.3m2.1 6.2-3.5 3.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M6 4.5h8M7 4.5l.7 6H5.5l1.6 2.25h5.8l1.6-2.25h-2.2l.7-6M10 12.75v3"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function IconArchive() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 7.25h13v8.25H3.5zM2.75 4.5h14.5v2.75H2.75zM7.25 10.75h5.5"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconBranch() {
  return (
    <svg
      className="tree-icon"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="5" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="15" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="5" r="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M5 7.2v5.6M15 7.2a7.8 7.8 0 0 1-7.8 7.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

// Worktree entry: two overlapping checkouts (copy/layers metaphor) — must not
// be confused with the git-branch glyph used for actual branch rows.
function IconWorktree() {
  return (
    <svg
      className="tree-icon"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="7"
        y="7"
        width="10"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.4"
      />
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
    <svg
      width="14"
      height="14"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {dir === "down" ? (
        <path
          d="m4.5 7.5 5.5 5.5 5.5-5.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : dir === "right" ? (
        <path
          d="m7.5 4.5 5.5 5.5-5.5 5.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="m12.5 4.5-5.5 5.5 5.5 5.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function QuickAgentIcon({ agent }: { agent: string }) {
  const theme = useStore((state) => state.themeEffective);
  if (agent === "shell") {
    return <ShellIcon className="quick-agent-mark shell" size={17} />;
  }
  if (!hasAgentIcon(agent)) {
    return <span className="quick-agent-fallback" aria-hidden="true">{agent.slice(0, 1).toUpperCase()}</span>;
  }
  return (
    <AgentIcon
      agent={agent}
      className={`quick-agent-mark ${agent}`}
      size={agent === "easy_pi" ? 22 : 17}
      mono={theme === "light"}
    />
  );
}

function quickAgentMode(agent: string, t: SidebarT) {
  if (agent === "pi") return null;
  if (agent === "shell") return t("shell:ui.sidebar.quickLaunch.terminal");
  if (isAddedAgent(agent)) return t("shell:ui.sidebar.quickLaunch.nativeDefaults");
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
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const agentOrder = useStore((state) => state.settings?.agentOrder);
  const agentHidden = useStore((state) => state.settings?.agentHidden);
  const adapters = useStore((state) => state.adapters);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    scrollLeft: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const agents = visibleAgentIds(
    orderAgentIds(
      agentOrder,
      adapters.map((adapter) => adapter.agentType),
    ),
    agentHidden,
  );

  if (agents.length === 0) return null;

  return (
    <div
      ref={scrollerRef}
      className={`quick-agent-strip${dragging ? " dragging" : ""}`}
      aria-label={t("shell:ui.sidebar.quickLaunch.listLabel", {
        scope: scopeLabel,
      })}
      onWheel={(event) => {
        const scroller = scrollerRef.current;
        if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
        const delta =
          Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        if (delta === 0) return;
        const previousScrollLeft = scroller.scrollLeft;
        scroller.scrollLeft += delta;
        if (scroller.scrollLeft !== previousScrollLeft) event.preventDefault();
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
        if (scroller?.hasPointerCapture(event.pointerId))
          scroller.releasePointerCapture(event.pointerId);
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
        {agents.map((agent) => {
          const mode = quickAgentMode(agent, t);
          return (
            <button
              key={agent}
              className="project-agent-action"
              aria-label={
                mode
                  ? t("shell:ui.sidebar.quickLaunch.launchLabel", {
                      scope: scopeLabel,
                      agent: agentDisplay(agent),
                      mode,
                    })
                  : t("shell:ui.sidebar.quickLaunch.launchPlainLabel", {
                      scope: scopeLabel,
                      agent: agentDisplay(agent),
                    })
              }
              data-tip={
                mode
                  ? t("shell:ui.sidebar.quickLaunch.launchTip", {
                      agent: agentDisplay(agent),
                      mode,
                    })
                  : t("shell:ui.sidebar.quickLaunch.launchPlainTip", {
                      agent: agentDisplay(agent),
                    })
              }
              onClick={() => void quickStartSession(projectId, agent, worktreeId)}
            >
              <QuickAgentIcon agent={agent} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function IconCollapseProjects({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {collapsed ? (
        <path
          d="M5.5 5v4.25m-2.25-2.25L5.5 9.25 7.75 7M14.5 15v-4.25m-2.25 2.25 2.25-2.25L16.75 13"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M5.5 9.25V5m-2.25 2.25L5.5 5 7.75 7.25M14.5 10.75V15m-2.25-2.25 2.25 2.25 2.25-2.25"
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function sessionMenu(
  ses: SessionView,
  suspended: boolean,
  onRemove: () => void,
  t: SidebarT,
): MenuItem[] {
  return [
    {
      label: t("session:ui.menu.copyId"),
      action: () =>
        void copyTextWithToast(ses.id, t("session:ui.toast.idCopied")),
    },
    { label: "", separator: true },
    {
      label: t("session:ui.menu.exportMarkdown"),
      action: () =>
        openDialog({ kind: "export", sessionId: ses.id, exportKind: "md" }),
    },
    {
      label: t("session:ui.menu.exportRawLog"),
      action: () =>
        openDialog({ kind: "export", sessionId: ses.id, exportKind: "json" }),
    },
    { label: "", separator: true },
    {
      label: t("session:ui.menu.restartAndResume"),
      action: () => void restartSessionFlow(ses.id),
    },
    ...(suspended
      ? [
          {
            label: t("session:ui.menu.resume"),
            action: () => void resumeSessionFlow(ses.id),
          },
        ]
      : []),
    {
      label: t("session:ui.menu.stop"),
      danger: true,
      action: () => void stopSessionFlow(ses.id),
    },
    { label: "", separator: true },
    { label: t("session:ui.menu.remove"), danger: true, action: onRemove },
  ];
}

function projectMenu(
  p: ProjectView,
  isGitRepository: boolean,
  t: SidebarT,
  opts?: {
    includeNewSession?: boolean;
    layoutSaving?: boolean;
    onTogglePin?: () => void;
  },
): MenuItem[] {
  return [
    ...(opts?.includeNewSession === false
      ? []
      : [
          {
            label: t("session:ui.actions.newEllipsis"),
            action: () => openNewSessionDialog(p.id),
          } as MenuItem,
        ]),
    {
      label: t("git:open"),
      disabled: !isGitRepository,
      tip: isGitRepository ? undefined : t("shell:ui.sidebar.notGitRepository"),
      action: () =>
        void openGitCenter({ kind: "projectMain", projectId: p.id }),
    },
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
      label: p.pinned
        ? t("shell:ui.sidebar.projectMenu.unpin")
        : t("shell:ui.sidebar.projectMenu.pin"),
      disabled: opts?.layoutSaving,
      action: opts?.onTogglePin,
    },
    {
      label: t("shell:ui.sidebar.projectMenu.revealInFileManager"),
      action: () =>
        void api
          .revealInFileManager(p.rootPath)
          .catch((e) =>
            toast(
              t("shell:ui.sidebar.openFailed", { detail: errorText(e) }),
              "error",
            ),
          ),
    },
    { label: "", separator: true },
    {
      label: t("shell:ui.sidebar.projectMenu.rename"),
      action: () => void renameProjectFlow(p.id),
    },
    {
      label: t("shell:ui.sidebar.projectMenu.remove"),
      danger: true,
      action: () => void removeProjectFlow(p.id),
    },
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
      : [
          {
            label: t("session:ui.actions.newEllipsis"),
            action: () => openNewSessionDialog(p.id, w.id),
          } as MenuItem,
        ]),
    {
      label: t("git:open"),
      action: () =>
        void openGitCenter({
          kind: "worktree",
          projectId: p.id,
          worktreeId: w.id,
        }),
    },
    {
      label: t("shell:ui.sidebar.worktreeMenu.copyPath"),
      action: () =>
        void copyTextWithToast(w.path, t("shell:ui.sidebar.toast.pathCopied")),
    },
    {
      label: t("shell:ui.sidebar.worktreeMenu.openInSystemTerminal"),
      action: () =>
        void api
          .openInSystemTerminal(w.path)
          .catch((e) =>
            toast(
              t("shell:ui.sidebar.openFailed", { detail: errorText(e) }),
              "error",
            ),
          ),
    },
    {
      label: t("shell:ui.sidebar.worktreeMenu.copyGitStatus"),
      action: () =>
        void api
          .worktreeStatusText(w.id)
          .then((st) =>
            copyTextWithToast(
              st.raw || "(clean)",
              t("shell:ui.sidebar.toast.gitStatusCopied"),
            ),
          )
          .catch((e) =>
            toast(
              t("shell:ui.sidebar.gitStatusFailed", { detail: errorText(e) }),
              "error",
            ),
          ),
    },
    { label: "", separator: true },
    {
      label: t("shell:ui.sidebar.worktreeMenu.delete"),
      danger: true,
      action: () => void removeWorktreeFlow(w.id),
    },
  ];
}

let cachedPaneLayout: PaneLayout | null = null;
let cachedPaneLayoutGroups: PaneLayout[] | null = null;
let cachedPaneSessionIds: ReadonlySet<string> = new Set();

/**
 * Session rows share this reference-keyed cache. Production pane transforms
 * replace layout references, so unrelated store updates only pay Set lookups.
 */
function paneSessionIds(
  terminalLayout: PaneLayout,
  terminalLayoutGroups: PaneLayout[],
): ReadonlySet<string> {
  if (
    terminalLayout === cachedPaneLayout &&
    terminalLayoutGroups === cachedPaneLayoutGroups
  ) {
    return cachedPaneSessionIds;
  }

  const sessionIds = new Set(orderedLayoutSessionIds(terminalLayout));
  for (const group of terminalLayoutGroups) {
    if (group === terminalLayout) continue;
    for (const sessionId of orderedLayoutSessionIds(group)) {
      sessionIds.add(sessionId);
    }
  }
  cachedPaneLayout = terminalLayout;
  cachedPaneLayoutGroups = terminalLayoutGroups;
  cachedPaneSessionIds = sessionIds;
  return sessionIds;
}

const SESSION_ROW_ACTIVE = 1;
const SESSION_ROW_IN_PANE_LAYOUT = 2;
const SESSION_ROW_SUSPENDED = 4;

function SessionRow({
  ses,
  nested,
  sourceLabel,
}: {
  ses: SessionView;
  nested?: boolean;
  sourceLabel?: string;
}) {
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const rowState = useStore((state) =>
    (state.activeSessionId === ses.id ? SESSION_ROW_ACTIVE : 0) |
    (paneSessionIds(state.terminalLayout, state.terminalLayoutGroups).has(ses.id)
      ? SESSION_ROW_IN_PANE_LAYOUT
      : 0) |
    (state.runtime[ses.id]?.suspended === true ? SESSION_ROW_SUSPENDED : 0),
  );
  const active = (rowState & SESSION_ROW_ACTIVE) !== 0;
  const inPaneLayout = (rowState & SESSION_ROW_IN_PANE_LAYOUT) !== 0;
  const pinned = ses.pinnedAt !== null;
  const suspended = (rowState & SESSION_ROW_SUSPENDED) !== 0;
  const [editing, setEditing] = useState(false);
  const [draggingPaneSession, setDraggingPaneSession] = useState(false);
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
        className={
          "tree-row session remove-confirm" + (nested ? " nested" : "")
        }
        role="alert"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setConfirmingRemove(false);
          }
        }}
      >
        <span className="remove-confirm-label">
          {t("session:ui.sidebar.removeConfirm")}
        </span>
        <span className="remove-confirm-actions">
          <button
            className="btn small ghost"
            autoFocus
            onClick={(event) => {
              event.stopPropagation();
              setConfirmingRemove(false);
            }}
          >
            {t("common:actions.cancel")}
          </button>
          <button
            className="btn small danger"
            onClick={(event) => {
              event.stopPropagation();
              void removeSessionFlow(ses.id);
            }}
          >
            {t("common:actions.remove")}
          </button>
        </span>
      </div>
    );
  }
  return (
    <div
      className={
        "tree-row session" +
        (nested ? " nested" : "") +
        (sourceLabel ? " active-agent-session" : "") +
        (active ? " active" : "") +
        (inPaneLayout && !active ? " in-pane-layout" : "") +
        (draggingPaneSession ? " dragging-pane-session" : "")
      }
      draggable={!editing}
      data-pane-drag-label={t("shell:pane.dragLabel", { title: ses.title })}
      onDragStart={(event) => {
        if (editing) {
          event.preventDefault();
          return;
        }
        writeSessionPaneDragPayload(event.dataTransfer, ses.id);
        beginNativeSessionDrag(ses.id);
        setDraggingPaneSession(true);
      }}
      onDragEnd={() => setDraggingPaneSession(false)}
      onClick={() => selectSession(ses.id)}
      onDoubleClick={() => setEditing(true)}
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(
          e.clientX,
          e.clientY,
          sessionMenu(ses, suspended, () => setConfirmingRemove(true), t),
        );
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
      aria-label={
        sourceLabel
          ? t("session:ui.sidebar.activeRowLabel", {
              title: ses.title,
              agent: agentDisplay(ses.adapter),
              source: sourceLabel,
            })
          : t("session:ui.sidebar.rowLabel", {
              title: ses.title,
              agent: agentDisplay(ses.adapter),
            })
      }
    >
      <StatusDot session={ses} />
      <span className="session-copy">
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
        ) : (
          <span className="tree-label">{ses.title}</span>
        )}
        {sourceLabel ? (
          <span className="active-session-source">{sourceLabel}</span>
        ) : null}
      </span>
      <span
        className="session-row-actions"
        aria-label={t("session:ui.sidebar.actionsLabel")}
      >
        <span
          className={"session-action" + (pinned ? " pinned" : "")}
          role="button"
          tabIndex={0}
          aria-label={
            pinned ? t("session:ui.sidebar.unpin") : t("session:ui.sidebar.pin")
          }
          onClick={(event) => {
            event.stopPropagation();
            void toggleSessionPinFlow(ses.id);
          }}
        >
          <IconPin pinned={pinned} />
        </span>
        <span
          className="session-action"
          role="button"
          tabIndex={0}
          aria-label={t("session:ui.sidebar.archive")}
          onClick={(event) => {
            event.stopPropagation();
            void archiveSessionFlow(ses.id);
          }}
        >
          <IconArchive />
        </span>
      </span>
      <span
        className="session-age"
        aria-label={t("session:ui.sidebar.createdAt", { date: ses.createdAt })}
      >
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

function WorktreeNode({
  p,
  w,
  sessions,
  highlighted,
}: {
  p: ProjectView;
  w: WorktreeView;
  sessions: SessionView[];
  highlighted: boolean;
}) {
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const collapsed = useStore(
    (state) => state.collapsedWorktrees[w.id] === true,
  );
  return (
    <div role="treeitem" aria-expanded={!collapsed}>
      <div className="tree-project-header">
        <button
          className={"tree-row worktree" + (highlighted ? " highlighted" : "")}
          onClick={() =>
            update((s) => ({
              collapsedWorktrees: {
                ...s.collapsedWorktrees,
                [w.id]: !collapsed,
              },
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
          <span className={`health-badge ${w.health}`}>
            {healthLabel(w.health)}
          </span>
        </button>
        <div
          className="project-quick-actions"
          aria-label={t("shell:ui.sidebar.worktreeQuickActions", {
            branch: w.branch,
          })}
        >
          <QuickAgentStrip
            projectId={p.id}
            worktreeId={w.id}
            scopeLabel={t("shell:ui.sidebar.worktreeScope", {
              branch: w.branch,
            })}
          />
          <button
            className="icon-btn tree-action"
            aria-label={t("shell:ui.sidebar.worktreeMoreActions", {
              branch: w.branch,
            })}
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
export function orderSessionsForSidebar(sessions: SessionView[]): SessionView[] {
  return [...sessions].sort((a, b) => {
    const pinnedOrder =
      (b.pinnedAt ? Date.parse(b.pinnedAt) : 0) -
      (a.pinnedAt ? Date.parse(a.pinnedAt) : 0);
    if (pinnedOrder !== 0) return pinnedOrder;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

function useSessionOrder() {
  return orderSessionsForSidebar;
}

function sessionTime(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function activeSessionPriority(
  session: SessionView,
  suspendedSessionIds: ReadonlySet<string>,
): number {
  if (
    suspendedSessionIds.has(session.id) ||
    session.unread ||
    session.status?.state === "needs_input"
  ) {
    return 0;
  }
  if (
    session.lifecycle === "creating" ||
    session.status?.state === "working"
  ) {
    return 1;
  }
  if (session.status?.state === "idle") return 2;
  return 3;
}

/** Flat active-Agent ordering: attention, working, idle, then unknown. */
export function orderActiveAgentSessionsForSidebar(
  sessions: SessionView[],
  suspendedSessionIds: ReadonlySet<string> = new Set(),
): SessionView[] {
  return [...sessions].sort((a, b) => {
    const priority =
      activeSessionPriority(a, suspendedSessionIds) -
      activeSessionPriority(b, suspendedSessionIds);
    if (priority !== 0) return priority;

    const pinned = Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null);
    if (pinned !== 0) return pinned;

    const recent =
      sessionTime(b.status?.occurredAt ?? b.createdAt) -
      sessionTime(a.status?.occurredAt ?? a.createdAt);
    if (recent !== 0) return recent;
    return a.id.localeCompare(b.id);
  });
}

interface ActiveAgentSessionEntry {
  session: SessionView;
  project: ProjectView;
}

const ActiveAgentSessionItem = memo(function ActiveAgentSessionItem({
  entry,
  sourceLabel,
}: {
  entry: ActiveAgentSessionEntry;
  sourceLabel: string;
}) {
  return (
    <div role="listitem">
      <SessionRow ses={entry.session} sourceLabel={sourceLabel} />
    </div>
  );
});

function ActiveAgentSessionsView({ projects }: { projects: ProjectView[] }) {
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const archivingSessionIds = useStore((state) => state.archivingSessionIds);
  const suspendedSessionIds = useStore((state) => state.suspendedSessionIds);
  const repositoryStatuses = useStore((state) => state.repositoryStatuses);
  const { entries, projectKey } = useMemo(() => {
    const archiving = new Set(archivingSessionIds);
    const projectBySession = new Map<string, ProjectView>();
    const sessions: SessionView[] = [];
    const activeProjectIds: string[] = [];

    for (const project of projects) {
      let projectHasActiveAgent = false;
      for (const session of project.sessions) {
        if (
          session.hostAlive &&
          !archiving.has(session.id)
        ) {
          projectBySession.set(session.id, project);
          sessions.push(session);
          projectHasActiveAgent = true;
        }
      }
      if (projectHasActiveAgent) activeProjectIds.push(project.id);
    }

    const entries: ActiveAgentSessionEntry[] = [];
    for (const session of orderActiveAgentSessionsForSidebar(
      sessions,
      suspendedSessionIds,
    )) {
      const project = projectBySession.get(session.id);
      if (project) entries.push({ session, project });
    }
    return { entries, projectKey: activeProjectIds.join("\0") };
  }, [archivingSessionIds, projects, suspendedSessionIds]);

  useEffect(() => {
    const projectIds = projectKey ? projectKey.split("\0") : [];
    const refresh = () => {
      for (const projectId of projectIds) {
        void refreshRepositoryStatus(projectId);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectKey]);

  if (entries.length === 0) {
    return (
      <div className="active-agent-empty" role="status">
        {t("shell:ui.sidebar.activeAgentsEmpty")}
      </div>
    );
  }

  return (
    <div
      className="active-agent-session-list"
      role="list"
      aria-label={t("shell:ui.sidebar.activeAgentListLabel")}
    >
      {entries.map((entry) => {
        const { session, project } = entry;
        const branch = session.worktreeId
          ? project.worktrees.find(
              (worktree) => worktree.id === session.worktreeId,
            )?.branch
          : repositoryStatuses[project.id]?.isGitRepository &&
              repositoryStatuses[project.id]?.head.kind === "branch"
            ? repositoryStatuses[project.id]?.head.branch
            : null;
        const sourceLabel = branch
          ? `${project.name} · ${branch}`
          : project.name;
        return (
          <ActiveAgentSessionItem
            key={session.id}
            entry={entry}
            sourceLabel={sourceLabel}
          />
        );
      })}
    </div>
  );
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

const PROJECT_DRAG_THRESHOLD_PX = 5;
const PROJECT_AUTO_SCROLL_EDGE_PX = 36;
const PROJECT_AUTO_SCROLL_STEP_PX = 10;

interface PendingProjectDrag {
  projectId: string;
  pointerId: number;
  startX: number;
  startY: number;
  source: HTMLButtonElement;
  origin: ProjectView[];
  preview: ProjectView[];
  sourceMidpoint: number;
  active: boolean;
}

function useProjectDrag(projects: ProjectView[], layoutSaving: boolean) {
  const { t } = useTranslation("shell");
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRef = useRef<PendingProjectDrag | null>(null);
  const suppressClickProjectRef = useRef<{
    projectId: string;
    expiresAt: number;
  } | null>(null);
  const pointerYRef = useRef(0);
  const autoScrollFrameRef = useRef<number | null>(null);
  const [preview, setPreview] = useState<{
    projectId: string;
    projects: ProjectView[];
  } | null>(null);

  const registerHeader = (projectId: string, node: HTMLDivElement | null) => {
    if (node) headerRefs.current.set(projectId, node);
    else headerRefs.current.delete(projectId);
  };

  const updatePreviewAt = (pointerY: number) => {
    const pending = pendingRef.current;
    if (!pending?.active) return;
    const midpoints = new Map<string, number>();
    for (const project of pending.preview) {
      if (project.id === pending.projectId) {
        midpoints.set(project.id, pending.sourceMidpoint);
        continue;
      }
      const rect = headerRefs.current.get(project.id)?.getBoundingClientRect();
      if (rect) midpoints.set(project.id, rect.top + rect.height / 2);
    }
    const target = projectDropTarget(
      pending.origin,
      pending.projectId,
      midpoints,
      pointerY,
    );
    if (!target) return;
    const next = moveProjectInLayout(pending.origin, pending.projectId, target);
    if (sameProjectLayout(next, pending.preview)) return;
    pending.preview = next;
    setPreview({ projectId: pending.projectId, projects: next });
  };

  const stopAutoScroll = () => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  };

  const runAutoScroll = () => {
    const scroller = scrollRef.current;
    const pending = pendingRef.current;
    if (!scroller || !pending?.active) {
      autoScrollFrameRef.current = null;
      return;
    }
    const bounds = scroller.getBoundingClientRect();
    const pointerY = pointerYRef.current;
    let delta = 0;
    if (pointerY < bounds.top + PROJECT_AUTO_SCROLL_EDGE_PX) {
      delta = -PROJECT_AUTO_SCROLL_STEP_PX;
    } else if (pointerY > bounds.bottom - PROJECT_AUTO_SCROLL_EDGE_PX) {
      delta = PROJECT_AUTO_SCROLL_STEP_PX;
    }
    if (delta === 0) {
      autoScrollFrameRef.current = null;
      return;
    }
    const previousScrollTop = scroller.scrollTop;
    scroller.scrollTop += delta;
    const scrollDelta = scroller.scrollTop - previousScrollTop;
    if (scrollDelta === 0) {
      autoScrollFrameRef.current = null;
      return;
    }
    pending.sourceMidpoint -= scrollDelta;
    updatePreviewAt(pointerY);
    autoScrollFrameRef.current = requestAnimationFrame(runAutoScroll);
  };

  const scheduleAutoScroll = (pointerY: number) => {
    pointerYRef.current = pointerY;
    if (autoScrollFrameRef.current === null) {
      autoScrollFrameRef.current = requestAnimationFrame(runAutoScroll);
    }
  };

  const cleanUpDrag = (pending: PendingProjectDrag) => {
    if (pending.source.hasPointerCapture(pending.pointerId)) {
      pending.source.releasePointerCapture(pending.pointerId);
    }
    stopAutoScroll();
    document.body.classList.remove("is-project-dragging");
    pendingRef.current = null;
    setPreview(null);
  };

  const cancelDrag = () => {
    const pending = pendingRef.current;
    if (!pending?.active) return;
    const projectName =
      pending.origin.find((project) => project.id === pending.projectId)
        ?.name ?? pending.projectId;
    suppressClickProjectRef.current = {
      projectId: pending.projectId,
      expiresAt: Date.now() + 1000,
    };
    cleanUpDrag(pending);
    update(() => ({
      announcement: t("ui.sidebar.projectDragCancelled", {
        project: projectName,
      }),
    }));
  };

  useEffect(() => {
    if (!preview) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelDrag();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [preview]);

  useEffect(
    () => () => {
      stopAutoScroll();
      document.body.classList.remove("is-project-dragging");
    },
    [],
  );

  const onPointerDown = (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (layoutSaving || event.button !== 0) return;
    const sourceRect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    pendingRef.current = {
      projectId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      source: event.currentTarget,
      origin: projects,
      preview: projects,
      sourceMidpoint: sourceRect.top + sourceRect.height / 2,
      active: false,
    };
  };

  const onPointerMove = (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const pending = pendingRef.current;
    if (
      !pending ||
      pending.projectId !== projectId ||
      pending.pointerId !== event.pointerId
    )
      return;
    if (!pending.active) {
      const distance = Math.hypot(
        event.clientX - pending.startX,
        event.clientY - pending.startY,
      );
      if (distance <= PROJECT_DRAG_THRESHOLD_PX) return;
      pending.active = true;
      document.body.classList.add("is-project-dragging");
      setPreview({ projectId, projects: pending.preview });
      const projectName =
        pending.origin.find((project) => project.id === projectId)?.name ??
        projectId;
      update(() => ({
        announcement: t("ui.sidebar.projectDragStarted", {
          project: projectName,
        }),
      }));
    }
    event.preventDefault();
    updatePreviewAt(event.clientY);
    scheduleAutoScroll(event.clientY);
  };

  const onPointerUp = (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const pending = pendingRef.current;
    if (
      !pending ||
      pending.projectId !== projectId ||
      pending.pointerId !== event.pointerId
    )
      return;
    if (!pending.active) {
      if (pending.source.hasPointerCapture(pending.pointerId)) {
        pending.source.releasePointerCapture(pending.pointerId);
      }
      pendingRef.current = null;
      return;
    }
    suppressClickProjectRef.current = {
      projectId,
      expiresAt: Date.now() + 1000,
    };
    const next = pending.preview;
    const changed = !sameProjectLayout(pending.origin, next);
    cleanUpDrag(pending);
    if (changed) void saveProjectLayoutFlow(projectLayoutEntries(next));
  };

  const onPointerCancel = (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const pending = pendingRef.current;
    if (
      !pending ||
      pending.projectId !== projectId ||
      pending.pointerId !== event.pointerId
    )
      return;
    if (pending.active) cancelDrag();
    else {
      if (pending.source.hasPointerCapture(pending.pointerId)) {
        pending.source.releasePointerCapture(pending.pointerId);
      }
      pendingRef.current = null;
    }
  };

  const consumeSuppressedClick = (
    projectId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ): boolean => {
    const suppression = suppressClickProjectRef.current;
    if (!suppression) return false;
    if (suppression.expiresAt < Date.now()) {
      suppressClickProjectRef.current = null;
      return false;
    }
    if (suppression.projectId !== projectId) return false;
    suppressClickProjectRef.current = null;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const togglePin = (project: ProjectView) => {
    if (layoutSaving) return;
    const next = setProjectPinnedAtFront(projects, project.id, !project.pinned);
    if (!sameProjectLayout(projects, next)) {
      void saveProjectLayoutFlow(projectLayoutEntries(next));
    }
  };

  return {
    projects: preview?.projects ?? projects,
    draggingProjectId: preview?.projectId ?? null,
    scrollRef,
    registerHeader,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    consumeSuppressedClick,
    togglePin,
  };
}

interface ProjectNodeProps {
  p: ProjectView;
  dragging: boolean;
  startsUnpinnedGroup: boolean;
  layoutSaving: boolean;
  registerHeader: (projectId: string, node: HTMLDivElement | null) => void;
  onPointerDown: (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerMove: (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerUp: (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  onPointerCancel: (
    projectId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => void;
  consumeSuppressedClick: (
    projectId: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => boolean;
  onTogglePin: (project: ProjectView) => void;
}

function ProjectNode({
  p,
  dragging,
  startsUnpinnedGroup,
  layoutSaving,
  registerHeader,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  consumeSuppressedClick,
  onTogglePin,
}: ProjectNodeProps) {
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const expanded = useStore((state) => state.expandedProjects[p.id] !== false);
  const order = useSessionOrder();
  const archiving = useStore((state) => state.archivingSessionIds);
  const archivingSessionIds = new Set(archiving);
  const visibleSessions = p.sessions.filter(
    (session) => !archivingSessionIds.has(session.id),
  );
  const mainSessions = order(
    visibleSessions.filter((session) => !session.worktreeId),
  );
  const repositoryStatus = useStore((state) => state.repositoryStatuses[p.id]);
  // Branch management is intentionally gated by a live backend probe. The
  // persisted gitRootPath can become stale when a directory is moved or its
  // .git metadata is removed while AgentPort is closed.
  const isGitRepository = repositoryStatus?.isGitRepository === true;
  const checkoutHead = repositoryStatus
    ? repositoryStatus.head.kind === "detached"
      ? t("shell:ui.sidebar.detachedAt", {
          oid:
            repositoryStatus.head.shortOid ??
            repositoryStatus.head.oid?.slice(0, 12) ??
            t("common:status.unknown"),
        })
      : repositoryStatus.head.kind === "unborn"
        ? t("shell:ui.sidebar.unbornRepository")
        : (repositoryStatus.head.branch ?? t("shell:ui.sidebar.readingBranch"))
    : t("shell:ui.sidebar.readingBranch");
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
  const menuOptions = {
    layoutSaving,
    onTogglePin: () => onTogglePin(p),
  };
  const projectLabel = p.pinned
    ? t("shell:ui.sidebar.pinnedProject", { project: p.name })
    : p.name;
  return (
    <div
      className={`tree-project${dragging ? " dragging" : ""}${startsUnpinnedGroup ? " unpinned-start" : ""}`}
      role="treeitem"
      aria-expanded={expanded}
      aria-label={projectLabel}
      data-project-id={p.id}
    >
      {dragging ? (
        <div className="project-drop-indicator" aria-hidden="true" />
      ) : null}
      <div
        className="tree-project-header"
        ref={(node) => registerHeader(p.id, node)}
      >
        <button
          type="button"
          className="tree-row project"
          aria-grabbed={dragging}
          onPointerDown={(event) => onPointerDown(p.id, event)}
          onPointerMove={(event) => onPointerMove(p.id, event)}
          onPointerUp={(event) => onPointerUp(p.id, event)}
          onPointerCancel={(event) => onPointerCancel(p.id, event)}
          onClick={(event) => {
            if (consumeSuppressedClick(p.id, event)) return;
            update((state) => {
              const expandedProjects = {
                ...state.expandedProjects,
                [p.id]: !expanded,
              };
              persistProjectExpansion(expandedProjects);
              return { expandedProjects };
            });
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openContextMenu(
              event.clientX,
              event.clientY,
              projectMenu(p, isGitRepository, t, menuOptions),
            );
          }}
        >
          <IconFolder open={expanded} />
          <span className="tree-label">{p.name}</span>
          {p.pinned ? (
            <span
              className="project-pin-indicator"
              aria-label={t("shell:ui.sidebar.projectPinned")}
              data-tip={t("shell:ui.sidebar.projectPinned")}
            >
              <IconPin pinned />
            </span>
          ) : null}
        </button>
        <div
          className="project-quick-actions"
          aria-label={t("shell:ui.sidebar.projectQuickActions", {
            project: p.name,
          })}
        >
          <QuickAgentStrip
            projectId={p.id}
            scopeLabel={t("shell:ui.sidebar.projectScope", { project: p.name })}
          />
          <button
            className="icon-btn tree-action"
            aria-label={t("shell:ui.sidebar.projectMoreActions", {
              project: p.name,
            })}
            data-tip={t("shell:ui.sidebar.moreActions")}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              // 与右键菜单同源，只去掉「新建 Session…」（与新建 Session 弹窗重复）。
              openContextMenu(
                rect.left,
                rect.bottom + 4,
                projectMenu(p, isGitRepository, t, {
                  ...menuOptions,
                  includeNewSession: false,
                }),
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
              onClick={() =>
                openDialog({ kind: "branchPicker", projectId: p.id })
              }
              aria-current="page"
              aria-label={t("shell:ui.sidebar.currentCheckout", {
                head: checkoutHead,
              })}
            >
              <IconBranch />
              <span className="tree-label mono">{checkoutHead}</span>
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
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const order = useSessionOrder();
  const canCreate = Boolean(p.gitRootPath);
  const archiving = useStore((state) => state.archivingSessionIds);
  const highlightedWorktreeId = useStore(
    (state) => state.highlightedWorktreeId,
  );
  const [liveHealth, setLiveHealth] = useState<
    Record<string, WorktreeHealthStr>
  >({});
  const worktreeIds = p.worktrees.map((worktree) => worktree.id).join("\0");
  const archivingSessionIds = new Set(archiving);
  useEffect(() => {
    let disposed = false;
    let requestSequence = 0;

    const refresh = async () => {
      const sequence = ++requestSequence;
      try {
        const worktrees = await api.listWorktrees(p.id);
        if (disposed || sequence !== requestSequence) return;
        setLiveHealth(
          Object.fromEntries(
            worktrees.map((worktree) => [worktree.id, worktree.health]),
          ),
        );
      } catch {
        // Keep the last known project snapshot when a background refresh fails.
      }
    };
    const refreshOnFocus = () => {
      void refresh();
    };

    setLiveHealth({});
    void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [p.id, worktreeIds]);

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
        <span className="tree-label">
          {t("shell:ui.sidebar.projectMenu.newWorktree")}
        </span>
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
            w={{ ...w, health: liveHealth[w.id] ?? w.health }}
            highlighted={highlightedWorktreeId === w.id}
            sessions={order(
              p.sessions.filter(
                (session) =>
                  session.worktreeId === w.id &&
                  !archivingSessionIds.has(session.id),
              ),
            )}
          />
        ))
      )}
    </div>
  );
}

function PaneGroupNode({ group, projects }: { group: PaneLayout; projects: ProjectView[] }) {
  const { t } = useTranslation("shell");
  const [expanded, setExpanded] = useState(true);
  const ids = orderedLayoutSessionIds(group);
  const sessions = ids.flatMap((id) => {
    const session = projects.flatMap((project) => project.sessions).find((item) => item.id === id);
    return session ? [session] : [];
  });
  const title = sessions.map((session) => session.title).join(" · ");
  const label = t("sidebarGroups.group", { title });
  if (!sessions.length) return null;
  return (
    <section className="tree-project sidebar-pane-group">
      <div className="sidebar-group-heading">
        <button type="button" className="sidebar-group-fold" aria-expanded={expanded}
          aria-label={t("sidebarGroups.fold", { title })} onClick={() => setExpanded(!expanded)}>
          <IconChevron dir={expanded ? "down" : "right"} />
        </button>
        <button type="button" className="tree-row project sidebar-group-open" title={label}
          onClick={() => selectSession(group.focusedSessionId ?? sessions[0].id)}>
          <svg className="sidebar-group-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" />
            <path d="M8 3v10" stroke="currentColor" />
          </svg>
          <span className="tree-label">{label}</span>
          <span className="sidebar-group-count">{sessions.length}</span>
        </button>
      </div>
      {expanded ? sessions.map((ses) => <SessionRow key={ses.id} ses={ses} nested />) : null}
    </section>
  );
}

export default function Sidebar({
  collapsed,
  width,
  anim = null,
}: {
  collapsed: boolean;
  width: number;
  anim?: "out" | "inPrep" | "in" | null;
}) {
  const { t } = useTranslation(["session", "shell", "common", "git"]);
  const projects = useStore((state) => state.projects);
  const sidebarViewMode = useStore((state) => state.sidebarViewMode);
  const activeAgentsView = sidebarViewMode === "activeAgents";
  const [groupsPage, setGroupsPage] = useState(false);
  const groups = useStore((state) => state.terminalLayoutGroups);
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = sidebarRef.current;
    if (!element || activeAgentsView || collapsed) return;
    let distance = 0;
    let lastEvent = 0;
    let switched = false;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      if (now - lastEvent > 180) { distance = 0; switched = false; }
      lastEvent = now;
      if (switched) return;
      distance += event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1);
      if (Math.abs(distance) < 60) return;
      setGroupsPage(distance > 0);
      switched = true;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [activeAgentsView, collapsed]);
  const showGroups = groupsPage && !activeAgentsView;
  const projectLayoutSaving = useStore((state) => state.projectLayoutSaving);
  const projectDrag = useProjectDrag(projects, projectLayoutSaving);
  const expandedProjects = useStore((state) => state.expandedProjects);
  const collapsedWorktrees = useStore((state) => state.collapsedWorktrees);
  const sidebarWorktreeProjectId = useStore(
    (state) => state.sidebarWorktreeProjectId,
  );
  const allProjectsCollapsed =
    projects.length > 0 &&
    projects.every((project) => expandedProjects[project.id] === false);
  const allWorktreesCollapsed = projects.every((p) =>
    p.worktrees.every((w) => collapsedWorktrees[w.id] === true),
  );
  // Master toggle covers both project groups and worktree session groups.
  const allCollapsed = allProjectsCollapsed && allWorktreesCollapsed;
  const worktreeProject = sidebarWorktreeProjectId
    ? (projects.find((p) => p.id === sidebarWorktreeProjectId) ?? null)
    : null;
  return (
    <aside
      ref={sidebarRef}
      className={`sidebar${collapsed ? " collapsed" : ""}${anim ? ` anim-${anim}` : ""}`}
      aria-label={t(
        showGroups ? "shell:sidebarGroups.groups" : activeAgentsView
          ? "shell:ui.sidebar.activeAgentSidebarLabel"
          : "shell:ui.sidebar.label",
      )}
      aria-hidden={collapsed}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}
    >
      <div
        ref={projectDrag.scrollRef}
        className="sidebar-scroll"
        role={activeAgentsView || showGroups ? "region" : "tree"}
        aria-label={
          showGroups ? t("shell:sidebarGroups.groups") : activeAgentsView
            ? t("shell:ui.sidebar.activeAgentListLabel")
            : worktreeProject
              ? t("shell:ui.sidebar.worktreeTreeLabel", {
                  project: worktreeProject.name,
                })
              : t("shell:ui.sidebar.projectTreeLabel")
        }
      >
        {showGroups ? (
          <div className="sidebar-groups-page">
            <div className="sidebar-groups-caption">{t("shell:sidebarGroups.groups")}</div>
            {groups.length ? groups.map((group) => (
              <PaneGroupNode key={[...orderedLayoutSessionIds(group)].sort().join("/")} group={group} projects={projects} />
            )) : <div className="empty-state"><div>{t("shell:sidebarGroups.empty")}</div><p>{t("shell:sidebarGroups.hint")}</p></div>}
          </div>
        ) : activeAgentsView ? (
          <ActiveAgentSessionsView projects={projects} />
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              ⌘
            </div>
            <div>{t("shell:ui.empty.addDirectoryPrompt")}</div>
            <button
              className="btn primary"
              onClick={() => void addProjectFromPickerFlow()}
            >
              {t("shell:ui.actions.addProject")}
            </button>
          </div>
        ) : worktreeProject ? (
          <WorktreeSessionsView p={worktreeProject} />
        ) : (
          projectDrag.projects.map((project, index) => {
            const startsUnpinnedGroup =
              !project.pinned &&
              index > 0 &&
              projectDrag.projects[index - 1]?.pinned === true;
            return (
              <ProjectNode
                key={project.id}
                p={project}
                dragging={projectDrag.draggingProjectId === project.id}
                startsUnpinnedGroup={startsUnpinnedGroup}
                layoutSaving={projectLayoutSaving}
                registerHeader={projectDrag.registerHeader}
                onPointerDown={projectDrag.onPointerDown}
                onPointerMove={projectDrag.onPointerMove}
                onPointerUp={projectDrag.onPointerUp}
                onPointerCancel={projectDrag.onPointerCancel}
                consumeSuppressedClick={projectDrag.consumeSuppressedClick}
                onTogglePin={projectDrag.togglePin}
              />
            );
          })
        )}
      </div>
      {!activeAgentsView ? <nav className="sidebar-page-dots" aria-label={t("shell:sidebarGroups.views")}>
        {[false, true].map((page) => <button key={String(page)} type="button"
          aria-label={t(page ? "shell:sidebarGroups.groups" : "shell:sidebarGroups.projects")}
          aria-current={groupsPage === page ? "page" : undefined}
          title={t(page ? "shell:sidebarGroups.groups" : "shell:sidebarGroups.projects")}
          onClick={() => setGroupsPage(page)}><span /></button>)}
      </nav> : null}
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
        {activeAgentsView || showGroups ? null : (
          <button
            className="sidebar-footer-action collapse-projects"
            onClick={() =>
              update((state) => {
                const collapse = !allCollapsed;
                const expandedProjects = Object.fromEntries(
                  state.projects.map((project) => [project.id, !collapse]),
                );
                persistProjectExpansion(expandedProjects);
                return {
                  expandedProjects,
                  collapsedWorktrees: Object.fromEntries(
                    state.projects.flatMap((p) =>
                      p.worktrees.map((w) => [w.id, collapse]),
                    ),
                  ),
                };
              })
            }
            disabled={projects.length === 0}
            aria-label={
              allCollapsed
                ? t("shell:ui.sidebar.expandAll")
                : t("shell:ui.sidebar.collapseAll")
            }
          >
            <IconCollapseProjects collapsed={allCollapsed} />
          </button>
        )}
      </div>
    </aside>
  );
}
