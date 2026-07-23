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

export default function TopBar() {
  const s = useStore();
  const session = findSession(s.projects, s.activeSessionId);
  const project = session ? s.projects.find((item) => item.id === session.projectId) : null;
  const worktree = session?.worktreeId
    ? project?.worktrees.find((item) => item.id === session.worktreeId)
    : null;
  const pending = s.timeline.entries.length;
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
      { label: "命令面板", action: () => openDialog({ kind: "palette" }) },
      { label: "搜索…", action: () => openDialog({ kind: "search" }) },
      {
        label: pending > 0 ? `恢复时间线（${pending}）` : "恢复时间线",
        action: () => openDialog({ kind: "timeline" }),
      },
      { label: "", separator: true },
      { label: "设置…", action: () => openDialog({ kind: "settings" }) },
    ];
    openContextMenu(rect.right - 180, rect.bottom + 6, items);
  };

  return (
    <header className="topbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="topbar-leading" data-tauri-drag-region="false">
        <button
          className="window-control sidebar-toggle"
          onClick={() => setState({ sidebarCollapsed: !s.sidebarCollapsed })}
          aria-label={s.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏"}
          aria-pressed={s.sidebarCollapsed}
          data-tip={`${s.sidebarCollapsed ? "显示" : "隐藏"}项目与会话侧栏（${sidebarShortcut}）`}
          data-tauri-drag-region="false"
        >
          <IconSidebarToggle collapsed={s.sidebarCollapsed} />
        </button>
      </div>
      <div className="window-title">
        <span>{project?.name ?? "AgentPort"}</span>
        {worktree ? (
          <>
            <span className="window-title-separator" aria-hidden="true">/</span>
            <span className="window-title-branch">{worktree.branch}</span>
          </>
        ) : null}
      </div>
      <button
        className="window-control"
        onClick={() => openDialog({ kind: "timeline" })}
        aria-label={pending > 0 ? `恢复时间线，有 ${pending} 项待处理` : "恢复时间线，没有待处理项"}
        data-tip="仅显示 GUI 关闭期间尚未确认的事件"
        data-tauri-drag-region="false"
      >
        <span aria-hidden="true">恢复</span>
        {pending > 0 ? <span className="topbar-timeline-badge" aria-hidden="true">{pending}</span> : null}
      </button>
      <button
        className="window-control terminal-menu"
        onClick={(e) => openSurfaceMenu(e.currentTarget)}
        aria-label="工作区菜单"
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
