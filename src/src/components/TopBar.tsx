// Minimal window chrome: macOS traffic lights sit over this bar, while all
// secondary application actions live in the compact terminal menu.

import {
  findSession,
  openContextMenu,
  openDialog,
  useStore,
  type MenuItem,
} from "../store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { toggleActiveAgentsView, toggleSidebarCollapsed } from "../actions";
import { toggleExplorer } from "../documents";
import { closeGitCenter, openGitCenter } from "../gitCenter";

function IconFolder() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.5 5.25a1.5 1.5 0 0 1 1.5-1.5h3.2l1.8 2h5.5a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExplorerToggleButton() {
  const { t } = useTranslation("shell");
  const explorerOpen = useStore((state) => state.explorerOpen);
  return (
    <button
      className="window-control sidebar-toggle"
      onClick={toggleExplorer}
      aria-label={t("ui.topBar.explorer")}
      aria-pressed={explorerOpen}
      data-tip={t("ui.topBar.explorerTip")}
      data-tauri-drag-region="false"
    >
      <IconFolder />
    </button>
  );
}

function IconSidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {!collapsed ? (
        <path d="M4.5 4h3.25v12H4.5A1.5 1.5 0 0 1 3 14.5v-9A1.5 1.5 0 0 1 4.5 4Z" fill="currentColor" opacity=".28" />
      ) : null}
      <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.45" />
      <path d="M7.75 4v12" stroke="currentColor" strokeWidth="1.45" />
    </svg>
  );
}

function IconTerminal() {
  return (
    <svg width="19" height="19" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="m7.25 6.5-3 3.5 3 3.5M11.25 13.5h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4.5 6.25 3.5 3.5 3.5-3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconBranch() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.6v4.8M12 5.6A6.4 6.4 0 0 1 5.6 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconGitCenter() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="5" cy="4.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="15.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="15" cy="10" r="1.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6.3v7.4M6.8 5.1c4.5.6 2.1 4.9 6.4 4.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5.25 8.25a4.75 4.75 0 0 1 9.5 0c0 4 1.5 4.75 1.5 4.75H3.75s1.5-.75 1.5-4.75Z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.25 15.25a2 2 0 0 0 3.5 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export default function TopBar() {
  const { t } = useTranslation(["shell", "common", "git"]);
  const activeSession = useStore((state) =>
    findSession(state.projects, state.activeSessionId),
  );
  const activeProject = useStore((state) =>
    activeSession
      ? state.projects.find((project) => project.id === activeSession.projectId) ?? null
      : null,
  );
  const mainBranch = useStore((state) => {
    if (!activeSession) return null;
    const status = state.repositoryStatuses[activeSession.projectId];
    return status?.isGitRepository && status.head.kind === "branch"
      ? status.head.branch ?? null
      : null;
  });
  const activeRepositoryIsGit = useStore((state) =>
    activeSession
      ? state.repositoryStatuses[activeSession.projectId]?.isGitRepository === true
      : false,
  );
  const worktreeBranch = activeSession?.worktreeId
    ? activeProject?.worktrees.find(
      (worktree) => worktree.id === activeSession.worktreeId,
    )?.branch ?? null
    : null;
  const gitTarget = activeSession && activeRepositoryIsGit
    ? { locator: { kind: "session", sessionId: activeSession.id } as const }
    : null;
  const projectName = activeProject?.name;
  const projectBranch = worktreeBranch ?? mainBranch;
  const pending = useStore((state) => state.timeline.entries.length);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const sidebarViewMode = useStore((state) => state.sidebarViewMode);
  const gitCenterOpen = useStore((state) => state.gitCenter.open);
  const sidebarShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B";
  const gitCenterToggleLabel = t(gitCenterOpen ? "git:close" : "git:open");
  const activeAgentsOpen = sidebarViewMode === "activeAgents";
  const activeAgentsToggleLabel = t(activeAgentsOpen
    ? "shell:ui.topBar.showProjects"
    : "shell:ui.topBar.showActiveAgents");
  const activeAgentsToggleTip = t(activeAgentsOpen
    ? "shell:ui.topBar.showProjectsTip"
    : "shell:ui.topBar.showActiveAgentsTip");

  // WebKit does not consistently forward `data-tauri-drag-region` through
  // translucent compositing layers on macOS. Start the native drag explicitly
  // for unused title-bar space; controls opt out with the false marker below.
  const startWindowDrag = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-tauri-drag-region="false"]')) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  const openSurfaceMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const items: MenuItem[] = [
      { label: t("shell:ui.topBar.commandPalette"), action: () => openDialog({ kind: "palette" }) },
      { label: `${t("common:actions.search")}…`, action: () => openDialog({ kind: "search" }) },
      {
        label: t("git:open"),
        disabled: !gitTarget,
        action: gitTarget
          ? () => void openGitCenter(gitTarget.locator)
          : undefined,
      },
      {
        label: pending > 0
          ? t("shell:ui.topBar.recoveryTimelineCount", { count: pending })
          : t("shell:ui.topBar.recoveryTimeline"),
        action: () => openDialog({ kind: "timeline" }),
      },
      { label: "", separator: true },
      { label: t("shell:ui.topBar.settingsEllipsis"), action: () => openDialog({ kind: "settings" }) },
    ];
    openContextMenu(rect.right - 180, rect.bottom + 6, items);
  };

  return (
    <header className="topbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="topbar-leading" data-tauri-drag-region="false">
        <button
          className="window-control sidebar-toggle"
          onClick={toggleSidebarCollapsed}
          aria-label={sidebarCollapsed
            ? t("shell:ui.topBar.showSidebar")
            : t("shell:ui.topBar.hideSidebar")}
          aria-pressed={sidebarCollapsed}
          data-tip={sidebarCollapsed
            ? t("shell:ui.topBar.showSidebarTip", { shortcut: sidebarShortcut })
            : t("shell:ui.topBar.hideSidebarTip", { shortcut: sidebarShortcut })}
          data-tauri-drag-region="false"
        >
          <IconSidebarToggle collapsed={sidebarCollapsed} />
        </button>
        <button
          className="window-control sidebar-toggle"
          onClick={() => {
            if (gitCenterOpen) closeGitCenter();
            else if (gitTarget) void openGitCenter(gitTarget.locator);
          }}
          disabled={!gitCenterOpen && !gitTarget}
          aria-label={gitCenterToggleLabel}
          aria-pressed={gitCenterOpen}
          data-tip={gitCenterToggleLabel}
          data-tauri-drag-region="false"
        >
          <IconGitCenter />
        </button>
        <button
          className="window-control sidebar-toggle"
          onClick={toggleActiveAgentsView}
          aria-label={activeAgentsToggleLabel}
          aria-pressed={activeAgentsOpen}
          data-tip={activeAgentsToggleTip}
          data-tauri-drag-region="false"
        >
          <IconBell />
        </button>
      </div>
      <div className="window-title">
        <span>{projectName ?? "AgentPort"}</span>
        {projectBranch ? (
          <>
            <span className="window-title-branch-icon"><IconBranch /></span>
            <span className="window-title-branch">{projectBranch}</span>
          </>
        ) : null}
      </div>
      <div className="topbar-trailing" data-tauri-drag-region="false">
        <ExplorerToggleButton />
        <button
          className="window-control terminal-menu"
          onClick={(e) => openSurfaceMenu(e.currentTarget)}
          aria-label={t("shell:ui.topBar.workspaceMenu")}
          aria-haspopup="menu"
          data-tauri-drag-region="false"
        >
          <IconTerminal />
          <span className="window-control-divider" aria-hidden="true" />
          <IconChevron />
        </button>
      </div>
    </header>
  );
}
