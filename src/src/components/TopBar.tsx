// Minimal window chrome: macOS traffic lights sit over this bar, while all
// secondary application actions live in the compact terminal menu.

import {
  findSession,
  openContextMenu,
  openDialog,
  setState,
  useStore,
  type MenuItem,
} from "../store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";

function IconSidebarToggle({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      {collapsed ? (
        <path d="M4 4.25h12v11.5H4zM8 4.75v10.5m4.5-7.25 2 1.75-2 1.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M4 4.25h12v11.5H4zM8 4.75v10.5m4.5-1.75-2-1.75 2-1.75" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      )}
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

export default function TopBar() {
  const { t } = useTranslation(["shell", "common"]);
  const projectName = useStore((state) => {
    const session = findSession(state.projects, state.activeSessionId);
    return session
      ? state.projects.find((project) => project.id === session.projectId)?.name
      : undefined;
  });
  const projectBranch = useStore((state) => {
    const session = findSession(state.projects, state.activeSessionId);
    const repositoryStatus = session ? state.repositoryStatuses[session.projectId] : null;
    return repositoryStatus?.isGitRepository && repositoryStatus.head.kind === "branch"
      ? repositoryStatus.head.branch
      : null;
  });
  const pending = useStore((state) => state.timeline.entries.length);
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const sidebarShortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘B" : "Ctrl+B";

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
          onClick={() => setState({ sidebarCollapsed: !sidebarCollapsed })}
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
    </header>
  );
}
