// App root: boot sequence, backend event wiring, global keyboard shortcuts
// (PRD 7.1), layout, dialog routing.

import { lazy, Suspense, useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  errorText,
  onNotificationActivated,
  onProjectsChanged,
  onRepositoryStateChanged,
  onGitStateInvalidated,
  onSessionAgentId,
  onSessionExit,
  onSessionState,
} from "./api";
import {
  applyThemeSettings,
  isMac,
  openNewSessionDialog,
  refreshActiveWorktreeStatus,
  refreshProjectsSoon,
  restartSessionFlow,
  toggleSidebarCollapsed,
  selectSession,
  switchSessionByIndex,
} from "./actions";
import {
  handleGitStateInvalidation,
  noteActiveSessionForGitCenter,
} from "./gitCenter";
import {
  applyProjectsSnapshot,
  applyRepositoryStatusSnapshot,
  findSession,
  flattenSessions,
  getState,
  invalidateProjectsSnapshotRequests,
  openDialog,
  patchSession,
  setState,
  useStore,
} from "./store";
import { applyTerminalLanguage, pruneHandles, scrollToBottom } from "./terminals";
import TopBar from "./components/TopBar";
import Sidebar from "./components/Sidebar";
import TooltipHost from "./components/Tooltip";
import Toasts from "./components/Toasts";
import ContextMenuHost from "./components/ContextMenu";
import { ConfirmDialogHost, PromptDialogHost } from "./components/Dialogs";
import { applyUiLanguage } from "./i18n";

const TerminalArea = lazy(() => import("./components/TerminalArea"));
const NewSessionDialog = lazy(() => import("./components/NewSessionDialog"));
const NewWorktreeDialog = lazy(() => import("./components/NewWorktreeDialog"));
const SettingsDialog = lazy(() => import("./components/SettingsDialog"));
const DiagnosticsDialog = lazy(() => import("./components/DiagnosticsDialog"));
const TimelineDialog = lazy(() => import("./components/TimelineDialog"));
const SearchDialog = lazy(() => import("./components/SearchDialog"));
const AddProjectDialog = lazy(() => import("./components/AddProjectDialog"));
const ExportDialog = lazy(() => import("./components/ExportDialog"));
const CommandPalette = lazy(() => import("./components/CommandPalette"));
const BranchPickerDialog = lazy(() => import("./components/BranchPickerDialog"));
const Onboarding = lazy(() => import("./components/Onboarding"));
const GitCenter = lazy(() => import("./components/GitCenter"));

function useBoot() {
  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    let booted = false;
    let notificationActivationPending = false;
    const pendingEvents: Array<() => void> = [];
    const applyWhenBooted = (fn: () => void) => {
      if (cancelled) return;
      if (booted) fn();
      else pendingEvents.push(fn);
    };

    void (async () => {
      try {
        // Finish registering listeners before boot takes its initial snapshot.
        // Events received during boot are replayed in arrival order afterwards.
        const listenerResults = await Promise.allSettled([
          onProjectsChanged((projects) => {
            applyWhenBooted(() => {
              invalidateProjectsSnapshotRequests();
              applyProjectsSnapshot(projects);
              pruneHandles();
              void refreshActiveWorktreeStatus();
            });
          }),
          onRepositoryStateChanged((status) => {
            applyWhenBooted(() => {
              applyRepositoryStatusSnapshot(status);
            });
          }),
          onGitStateInvalidated((event) => {
            applyWhenBooted(() => handleGitStateInvalidation(event));
          }),
          onSessionState((ev) => {
            applyWhenBooted(() => {
              // Receiving an event is not proof that the user saw it. The
              // backend decides whether it is actionable, and selecting the
              // Session is the explicit acknowledgement boundary.
              patchSession(ev.sessionId, { status: ev });
              refreshProjectsSoon();
            });
          }),
          onSessionExit(({ sessionId, reason }) => {
            applyWhenBooted(() => {
              patchSession(sessionId, {
                lifecycle: reason === "user_stop" ? "stopped" : "exited",
              });
              refreshProjectsSoon();
            });
          }),
          onSessionAgentId(({ sessionId, agentSessionId }) => {
            applyWhenBooted(() => {
              patchSession(sessionId, { agentSessionId, resumePrecision: "exact" });
            });
          }),
          onNotificationActivated((sessionId) => {
            notificationActivationPending = true;
            applyWhenBooted(() => {
              selectSession(sessionId);
              notificationActivationPending = false;
            });
          }),
        ]);
        const listeners = listenerResults.flatMap((result) =>
          result.status === "fulfilled" ? [result.value] : [],
        );
        const listenerFailure = listenerResults.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (listenerFailure) {
          for (const unlisten of listeners) unlisten();
          throw listenerFailure.reason;
        }
        if (cancelled) {
          for (const unlisten of listeners) unlisten();
          return;
        }
        unlistens.push(...listeners);

        const info = await api.boot();
        const notificationSessionId = await api
          .takePendingNotificationSession()
          .catch(() => null);
        if (cancelled) return;
        await applyUiLanguage(info.settings.uiLanguage);
        applyTerminalLanguage();
        if (cancelled) return;
        applyProjectsSnapshot(info.projects);
        setState({
          ready: true,
          platform: info.platform,
          settings: info.settings,
          adapters: info.adapters,
          timeline: info.timeline,
          timelineError: info.timelineMessage ? null : info.timelineError,
          timelineMessage: info.timelineMessage ?? null,
          secretBackend: info.secretBackend,
          indexState: info.indexState,
          exportsDir: info.exportsDir,
          showOnboarding: info.adapters.length === 0,
        });
        applyThemeSettings();
        booted = true;
        for (const applyEvent of pendingEvents.splice(0)) applyEvent();
        const first = flattenSessions(getState().projects)[0];
        const notificationSession = findSession(getState().projects, notificationSessionId);
        if (notificationSession) selectSession(notificationSession.id);
        else if (!notificationActivationPending && !getState().activeSessionId && first) {
          selectSession(first.id);
        }
        if (info.adapters.length > 0) {
          void api
            .probeAgents()
            .then((outcomes) => {
              if (cancelled) return;
              const installs = outcomes.flatMap((outcome) =>
                outcome.install ? [outcome.install] : [],
              );
              if (installs.length > 0) setState({ adapters: installs });
            })
            .catch(() => undefined);
        }
      } catch (e) {
        if (!cancelled) {
          for (const unlisten of unlistens.splice(0)) unlisten();
          booted = true;
          pendingEvents.length = 0;
          setState({ ready: true, bootError: errorText(e) });
        }
      }
    })();

    // Follow OS theme / motion preference when settings say "system".
    const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMedia = () => applyThemeSettings();
    darkMq.addEventListener("change", onMedia);
    motionMq.addEventListener("change", onMedia);

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
      darkMq.removeEventListener("change", onMedia);
      motionMq.removeEventListener("change", onMedia);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const mac = isMac();
      const key = e.key.toLowerCase();
      const anyModal = s.dialog !== null || s.confirm !== null || s.prompt !== null;

      // Command palette toggle works everywhere.
      const paletteCombo = mac
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === "p"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "p";
      if (paletteCombo) {
        e.preventDefault();
        e.stopPropagation();
        openDialog({ kind: "palette" });
        return;
      }

      if (anyModal || s.showOnboarding) return;

      const sidebarCombo = mac
        ? e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === "b"
        : e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && key === "b";
      if (sidebarCombo) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebarCollapsed();
        return;
      }

      // New session: ⌘N / Ctrl+Shift+N
      const newCombo = mac
        ? e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === "n"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "n";
      if (newCombo) {
        e.preventDefault();
        e.stopPropagation();
        openNewSessionDialog();
        return;
      }

      // Restart & resume: ⌘⇧R / Ctrl+Shift+R (running sessions re-confirm).
      const restartCombo = mac
        ? e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && key === "r"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "r";
      if (restartCombo) {
        e.preventDefault();
        e.stopPropagation();
        if (s.activeSessionId) void restartSessionFlow(s.activeSessionId);
        return;
      }

      // Terminal search: ⌘F / Ctrl+Shift+F — page-local, never sent to PTY.
      const findCombo = mac
        ? e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey && key === "f"
        : e.ctrlKey && e.shiftKey && !e.altKey && key === "f";
      if (findCombo) {
        e.preventDefault();
        e.stopPropagation();
        if (s.activeSessionId) setState({ termSearchOpen: true });
        return;
      }

      // Jump to latest output: ⌘↓ / Ctrl+Shift+↓
      const bottomCombo = mac
        ? e.metaKey && !e.ctrlKey && !e.altKey && e.key === "ArrowDown"
        : e.ctrlKey && e.shiftKey && !e.altKey && e.key === "ArrowDown";
      if (bottomCombo) {
        e.preventDefault();
        e.stopPropagation();
        if (s.activeSessionId) scrollToBottom(s.activeSessionId);
        return;
      }

      // Switch to nth visible session: ⌘1…9 / Alt+1…9
      const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      if (digit > 0) {
        const digitCombo = mac
          ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
          : e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        if (digitCombo) {
          e.preventDefault();
          e.stopPropagation();
          switchSessionByIndex(digit - 1);
          return;
        }
      }
      // Plain Ctrl+C/D/Z, Esc, IME keys: always passed through to the PTY.
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

function DialogRouter() {
  const d = useStore((state) => state.dialog);
  if (!d) return null;
  switch (d.kind) {
    case "newSession":
      return (
        <NewSessionDialog
          projectId={d.projectId}
          worktreeId={d.worktreeId}
          agent={d.agent}
        />
      );
    case "newWorktree":
      return <NewWorktreeDialog projectId={d.projectId} />;
    case "branchPicker":
      return <BranchPickerDialog projectId={d.projectId} />;
    case "settings":
      return <SettingsDialog />;
    case "diagnostics":
      return <DiagnosticsDialog />;
    case "timeline":
      return <TimelineDialog />;
    case "search":
      return <SearchDialog />;
    case "addProject":
      return <AddProjectDialog />;
    case "export":
      return <ExportDialog sessionId={d.sessionId} exportKind={d.exportKind} />;
    case "palette":
      return <CommandPalette />;
    default:
      return null;
  }
}

const DEFAULT_SIDEBAR_WIDTH = 296;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function SplitHandle({ collapsed, width }: { collapsed: boolean; width: number }) {
  const { t } = useTranslation("shell");
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const viewportMax = Math.min(MAX_SIDEBAR_WIDTH, Math.floor(window.innerWidth * 0.46));
      setState({
        sidebarWidth: Math.round(
          Math.min(viewportMax, Math.max(MIN_SIDEBAR_WIDTH, start.width + event.clientX - start.x)),
        ),
      });
    };
    const onEnd = () => {
      dragStart.current = null;
      document.body.classList.remove("is-resizing-split");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, []);

  if (collapsed) return null;
  const resizeBy = (delta: number) =>
    setState({ sidebarWidth: clampSidebarWidth(width + delta) });

  return (
    <div
      className="split-handle"
      role="separator"
      aria-label={t("sidebar.resize")}
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragStart.current = { x: event.clientX, width };
        document.body.classList.add("is-resizing-split");
      }}
      onDoubleClick={() => setState({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH })}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 16;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          resizeBy(-step);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          resizeBy(step);
        } else if (event.key === "Home") {
          event.preventDefault();
          setState({ sidebarWidth: MIN_SIDEBAR_WIDTH });
        } else if (event.key === "End") {
          event.preventDefault();
          setState({ sidebarWidth: MAX_SIDEBAR_WIDTH });
        }
      }}
      data-tip={t("sidebar.resizeHint")}
    />
  );
}

export default function App() {
  const { t } = useTranslation(["shell", "common"]);
  const ready = useStore((state) => state.ready);
  const bootError = useStore((state) => state.bootError);
  const workspaceState = useStore((state) => {
    const activeSession = findSession(state.projects, state.activeSessionId);
    if (!activeSession) return "empty";
    return activeSession.lifecycle === "exited" ||
      activeSession.lifecycle === "stopped" ||
      activeSession.lifecycle === "interrupted"
      ? "ended"
      : "live";
  });
  const sidebarCollapsed = useStore((state) => state.sidebarCollapsed);
  const sidebarWidth = useStore((state) => state.sidebarWidth);
  const sidebarAnim = useStore((state) => state.sidebarAnim);
  const showOnboarding = useStore((state) => state.showOnboarding);
  const announcement = useStore((state) => state.announcement);
  const activeSessionId = useStore((state) => state.activeSessionId);
  const gitCenterOpen = useStore((state) => state.gitCenter.open);
  useBoot();
  useHotkeys();
  useEffect(() => {
    noteActiveSessionForGitCenter(activeSessionId);
  }, [activeSessionId]);

  if (!ready) {
    return (
      <div className="boot-screen" role="status">
        <span className="spin" aria-hidden="true" style={{ width: 20, height: 20 }} />
        <div>{t("shell:boot.starting")}</div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="boot-screen" role="alert">
        <div className="error-bar" style={{ maxWidth: 480 }}>
          {t("shell:boot.failed", { detail: bootError })}
        </div>
        <button className="btn" onClick={() => window.location.reload()}>
          {t("common:actions.retry")}
        </button>
      </div>
    );
  }

  return (
    <div
      className="app"
      data-workspace-state={workspaceState}
      data-sidebar-anim={sidebarAnim ?? undefined}
      style={
        {
          "--sidebar-width": sidebarCollapsed ? "0px" : `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <TopBar />
      <div className="main">
        <Sidebar collapsed={sidebarCollapsed} width={sidebarWidth} anim={sidebarAnim} />
        <SplitHandle collapsed={sidebarCollapsed} width={sidebarWidth} />
        <div className="workspace-stack">
          <div
            className={`workspace-surface terminal-surface${gitCenterOpen ? " git-surface-hidden" : ""}`}
            aria-hidden={gitCenterOpen || undefined}
          >
            <Suspense fallback={<section className="workspace" aria-label={t("shell:app.workspaceLabel")} aria-busy="true" />}>
              <TerminalArea />
            </Suspense>
          </div>
          {gitCenterOpen ? (
            <div className="workspace-surface git-surface">
              <Suspense fallback={<section className="workspace" aria-busy="true" />}>
                <GitCenter />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>
      <Suspense fallback={null}>
        <DialogRouter />
      </Suspense>
      <ConfirmDialogHost />
      <PromptDialogHost />
      <ContextMenuHost />
      <TooltipHost />
      <Toasts />
      {showOnboarding ? (
        <Suspense fallback={null}>
          <Onboarding />
        </Suspense>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}
