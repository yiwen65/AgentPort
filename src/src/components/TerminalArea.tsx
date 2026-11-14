// Terminal workspace: persistent xterm panes (display:none toggling), header
// with session actions, reconnect/suspension banners, lifecycle overlays,
// status line and "回到最新" (⌘↓).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { watchEndedSessions } from "../endedSessionRefresh";
import {
  copyText,
  errorText,
  readClipboardText,
} from "../api";
import {
  getRuntime,
  getState,
  hasOpenDocuments,
  openContextMenu,
  openDialog,
  toast,
  useStore,
  type MenuItem,
} from "../store";
import {
  findSessionByKey,
  findSessionByKeyForState,
  refreshDeviceSnapshot,
  useDeviceSessions,
} from "../deviceSessions";
import {
  connectDevice,
  isDeviceConnected,
  useDeviceConnections,
} from "../deviceConnections";
import { useDevicesStore } from "../devicesStore";
import {
  activeSessionKey,
  deviceKeyForContext,
  parseSessionKey,
} from "../sessionIdentity";
import { focusSessionKey, reconnectActiveDevice } from "../deviceSwitch";
import { resolveCopySelection } from "../copySelection";
import {
  attachHandle,
  fitSession,
  focusSession,
  getHandle,
  hasWarmTerminalPreview,
  isTerminalPreviewRendered,
  loadOlderNativeHistory,
  mountTerminal,
  scrollTerminalViewport,
  scrollToBottom,
  setTerminalActive,
  restoreDesktopTerminalSize,
} from "../terminals";
import {
  dropTreeEntryIntoTerminal,
  hasTreeDragPayload,
  mustHandleTerminalDrop,
  readDragPayload,
} from "../terminalDrop";
import {
  canSplitSessionPane,
  PANE_SEPARATOR_SIZE,
  openNewSessionDialog,
  openSplitAgentPicker,
  persistCurrentPaneLayout,
  removeSessionPane,
  removeSessionFlow,
  renameSessionFlow,
  resumeSessionFlow,
  restartSessionFlow,
  setPaneSplitRatio,
  splitSessionIntoPane,
  stopSessionFlow,
  toggleSessionPaneMaximized,
} from "../actions";
import {
  clampPaneSplitRatio,
  layoutContains,
  orderedLayoutSessionIds,
  visiblePaneLayout,
  type PaneLayoutNode,
  type PaneSplit,
  type PaneSplitDirection,
} from "../paneLayout";
import {
  hasSessionPaneDragPayload,
  readSessionPaneDragPayload,
} from "../paneSessionDrag";
import { agentDisplay, precisionLabel } from "../format";
import type { SessionView } from "../types";
import { AgentIcon } from "./AgentIcons";
import ShellIcon from "./ShellIcon";
import PiStructuredTimeline from "./PiStructuredTimeline";
import DocumentPanel from "./DocumentPanel";
import StatusDot from "./StatusDot";
import { useTranslation } from "react-i18next";
import { shouldShowTerminalAttachOverlay } from "../terminalAttachVisibility";
import {
  readDismissedGeometryRevision,
  terminalGeometryPromptState,
} from "../terminalGeometryPrompt";
import { loadTerminalRuntime } from "../terminalRuntime";

// The pane chunk already owns the real terminal module; publish it to the
// eager facade so synchronous drop/shortcut helpers can use mounted handles.
void loadTerminalRuntime();

// ---------------------------------------------------------------------------
// persistent pane
// ---------------------------------------------------------------------------

const TERMINAL_SCROLL_THUMB_PX = 72;

/** Active-device flows keep the historical one-argument call shape. */
function flowDeviceIdFor(sessionKey: string): string | undefined {
  const { deviceKey } = parseSessionKey(sessionKey);
  return deviceKey === deviceKeyForContext(getState().activeDevice)
    ? undefined
    : deviceKey;
}

interface TerminalScrollPosition {
  value: number;
  max: number;
}

function readTerminalScrollPosition(
  sessionId: string,
  viewportY?: number,
): TerminalScrollPosition {
  const buffer = getHandle(sessionId)?.term.buffer.active;
  return buffer
    ? {
        value: Math.min(viewportY ?? buffer.viewportY, buffer.baseY),
        max: buffer.baseY,
      }
    : { value: 0, max: 0 };
}

/**
 * A fixed-size overlay thumb. Native scrollbar thumbs grow with the viewport
 * ratio and can become a full-height "shadow" for short buffers. This short
 * handle maps its complete travel to xterm's complete scrollback, so dragging
 * it remains fast even when a Session has a very large log.
 */
export function TerminalScrollbar({
  sessionId,
  active = true,
}: {
  sessionId: string;
  active?: boolean;
}) {
  const { t } = useTranslation("shell");
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef(TERMINAL_SCROLL_THUMB_PX / 2);
  const draggingRef = useRef(false);
  const positionFrameRef = useRef(0);
  const pendingViewportRef = useRef<{ buffer: object; value: number }>();
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState<TerminalScrollPosition>(() =>
    readTerminalScrollPosition(sessionId),
  );

  const applyThumbPosition = useCallback((next: TerminalScrollPosition) => {
    const track = trackRef.current;
    if (!track) return;
    const ratio = next.max > 0 ? next.value / next.max : 0;
    track.style.setProperty(
      "--terminal-scroll-top",
      `calc(${ratio * 100}% - ${ratio * TERMINAL_SCROLL_THUMB_PX}px)`,
    );
  }, []);

  const schedulePositionSync = useCallback((viewportY?: number) => {
    if (viewportY !== undefined) {
      const buffer = getHandle(sessionId)?.term.buffer.active;
      pendingViewportRef.current = buffer
        ? { buffer, value: viewportY }
        : undefined;
    }
    if (positionFrameRef.current) return;
    positionFrameRef.current = requestAnimationFrame(() => {
      positionFrameRef.current = 0;
      const activeBuffer = getHandle(sessionId)?.term.buffer.active;
      const pendingViewport = pendingViewportRef.current;
      pendingViewportRef.current = undefined;
      const pendingViewportY =
        activeBuffer && pendingViewport?.buffer === activeBuffer
          ? pendingViewport.value
          : undefined;
      const next = readTerminalScrollPosition(sessionId, pendingViewportY);
      applyThumbPosition(next);
      setPosition((current) =>
        current.value === next.value && current.max === next.max ? current : next,
      );
    });
  }, [applyThumbPosition, sessionId]);

  /** xterm suppresses its public onScroll event for viewport-originated
   * scrolling, so wheel/trackpad movement is only observable on the native
   * scroll element. Paint the thumb in the same frame as that event instead of
   * waiting for output or another scroll source to refresh it. */
  const syncNativeScrollPosition = useCallback(() => {
    const next = readTerminalScrollPosition(sessionId);
    applyThumbPosition(next);
    schedulePositionSync(next.value);
  }, [applyThumbPosition, schedulePositionSync, sessionId]);

  useEffect(() => {
    if (!active) return;
    let connectFrame = 0;
    let viewport: HTMLElement | null = null;
    let scrollDisposable: { dispose(): void } | undefined;
    let writeDisposable: { dispose(): void } | undefined;
    const onViewportScroll = () => syncNativeScrollPosition();

    const connect = () => {
      const handle = getHandle(sessionId);
      if (!handle) {
        connectFrame = requestAnimationFrame(connect);
        return;
      }
      viewport =
        handle.term.element?.querySelector<HTMLElement>(".xterm-viewport") ??
        null;
      viewport?.addEventListener("scroll", onViewportScroll, {
        passive: true,
      });
      schedulePositionSync();
      scrollDisposable = handle.term.onScroll((viewportY) => {
        schedulePositionSync(viewportY);
      });
      writeDisposable = handle.term.onWriteParsed(() => {
        schedulePositionSync();
      });
    };

    connectFrame = requestAnimationFrame(connect);
    return () => {
      cancelAnimationFrame(connectFrame);
      if (positionFrameRef.current) {
        cancelAnimationFrame(positionFrameRef.current);
        positionFrameRef.current = 0;
      }
      pendingViewportRef.current = undefined;
      viewport?.removeEventListener("scroll", onViewportScroll);
      scrollDisposable?.dispose();
      writeDisposable?.dispose();
    };
  }, [active, sessionId, schedulePositionSync, syncNativeScrollPosition]);

  const scrollFromPointer = (clientY: number) => {
    const track = trackRef.current;
    const handle = getHandle(sessionId);
    if (!track || !handle) return;
    const max = handle.term.buffer.active.baseY;
    const rect = track.getBoundingClientRect();
    const travel = Math.max(1, rect.height - TERMINAL_SCROLL_THUMB_PX);
    const thumbTop = Math.max(
      0,
      Math.min(travel, clientY - rect.top - dragOffsetRef.current),
    );
    const ratio = thumbTop / travel;
    if (ratio === 0) {
      scrollTerminalViewport(sessionId, { type: "top" });
    } else if (ratio === 1) {
      scrollTerminalViewport(sessionId, { type: "bottom" });
    } else {
      scrollTerminalViewport(sessionId, {
        type: "line",
        line: Math.round(ratio * max),
      });
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (position.max <= 0) return;
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const travel = Math.max(1, rect.height - TERMINAL_SCROLL_THUMB_PX);
    const currentTop = (position.value / position.max) * travel;
    dragOffsetRef.current = thumbRef.current?.contains(event.target as Node)
      ? Math.max(
          0,
          Math.min(TERMINAL_SCROLL_THUMB_PX, event.clientY - rect.top - currentTop),
        )
      : TERMINAL_SCROLL_THUMB_PX / 2;
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setDragging(true);
    scrollFromPointer(event.clientY);
    event.preventDefault();
    event.stopPropagation();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    scrollFromPointer(event.clientY);
    event.preventDefault();
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = false;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!getHandle(sessionId)) return;
    switch (event.key) {
      case "ArrowUp":
        scrollTerminalViewport(sessionId, { type: "lines", amount: -3 });
        break;
      case "ArrowDown":
        scrollTerminalViewport(sessionId, { type: "lines", amount: 3 });
        break;
      case "PageUp":
        scrollTerminalViewport(sessionId, { type: "pages", amount: -1 });
        break;
      case "PageDown":
        scrollTerminalViewport(sessionId, { type: "pages", amount: 1 });
        break;
      case "Home":
        scrollTerminalViewport(sessionId, { type: "top" });
        break;
      case "End":
        scrollTerminalViewport(sessionId, { type: "bottom" });
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const ratio = position.max > 0 ? position.value / position.max : 0;

  return (
    <div
      ref={trackRef}
      className={"terminal-scrollbar" + (dragging ? " dragging" : "")}
      role="scrollbar"
      aria-label={t("ui.terminal.scrollbarLabel")}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={position.max}
      aria-valuenow={position.value}
      aria-valuetext={`${Math.round(ratio * 100)}%`}
      aria-hidden={position.max <= 0}
      tabIndex={position.max > 0 ? 0 : -1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onKeyDown={onKeyDown}
    >
      <div ref={thumbRef} className="terminal-scrollbar-thumb" />
    </div>
  );
}

function TerminalPane({
  sessionKey,
  focused,
  visible,
}: {
  sessionKey: string;
  focused: boolean;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ses = useStore((state) => findSessionByKeyForState(state, sessionKey)?.session);
  const runtime = useStore((state) => state.runtime[sessionKey]);
  const scrolledUp = getRuntime(sessionKey).scrolledUp;
  const [dropActive, setDropActive] = useState(false);
  const sessionId = sessionKey;
  const paneDeviceId = parseSessionKey(sessionKey).deviceKey;
  const deviceConnected = useDeviceConnections(
    (state) =>
      paneDeviceId === "local" ||
      state.connections[paneDeviceId]?.phase === "connected",
  );

  useLayoutEffect(() => {
    if (hostRef.current) mountTerminal(sessionKey, hostRef.current);
  }, [sessionKey]);

  useLayoutEffect(() => {
    setTerminalActive(sessionKey, visible);
    if (!visible) return;
    // Every visible split pane owns a live attachment. Focus is independent:
    // only one xterm textarea receives keyboard input, while all panes stream.
    const sesNow = findSessionByKey(sessionKey)?.session;
    if (
      deviceConnected &&
      sesNow &&
      (sesNow.lifecycle === "running" || sesNow.lifecycle === "creating")
    ) {
      void attachHandle(sessionKey);
    }
    let secondRaf: number | null = null;
    const firstRaf = requestAnimationFrame(() => {
      secondRaf = requestAnimationFrame(() => {
        fitSession(sessionId, true);
        if (focused) focusSession(sessionId);
      });
    });
    return () => {
      cancelAnimationFrame(firstRaf);
      if (secondRaf !== null) cancelAnimationFrame(secondRaf);
    };
  }, [
    deviceConnected,
    focused,
    sessionId,
    visible,
    ses?.lifecycle,
    ses?.hostAlive,
    ses?.status?.runId,
    ses?.status?.runOrdinal,
  ]);

  const ended =
    ses?.lifecycle === "exited" ||
    ses?.lifecycle === "stopped" ||
    ses?.lifecycle === "interrupted" || Boolean(runtime?.exit);


  return (
    <div
      className={
        "term-pane" +
        (visible ? "" : " hidden") +
        (ended ? " ended" : "") +
        (scrolledUp ? " scrolled-up" : "") +
        (dropActive ? " drop-target" : "")
      }
      data-terminal-session-id={sessionId}
      onWheelCapture={(event: WheelEvent<HTMLDivElement>) => {
        if (!visible || event.deltaY >= 0) return;
        const buffer = getHandle(sessionId)?.term.buffer.active;
        if (
          ses?.adapter === "shell" ||
          !buffer ||
          buffer.type !== "normal" ||
          buffer.viewportY > 0
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void loadOlderNativeHistory(sessionId);
      }}
      onDragOver={(event) => {
        if (!visible || !hasTreeDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        // xterm descendants are the actual drag targets. Clear on leaving
        // the pane, not on moves between children within the same pane.
        const next = event.relatedTarget as Node | null;
        if (!next || !event.currentTarget.contains(next)) setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!visible) return;
        const ownedDrop = mustHandleTerminalDrop(event.dataTransfer);
        const payload = readDragPayload(event.dataTransfer);
        // Plain non-path text falls through to the native drop, which inserts
        // the text into the terminal as-is. File/URI drops are different: if
        // WebKit cannot expose a usable local path, suppress the browser's
        // default image/document navigation instead of letting it replace the app.
        if (!payload) {
          if (ownedDrop) event.preventDefault();
          return;
        }
        event.preventDefault();
        dropTreeEntryIntoTerminal(sessionId, ses?.adapter ?? "shell", payload);
      }}
    >
      <div className="term-host" ref={hostRef} />
      <TerminalScrollbar sessionId={sessionId} active={visible} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// lifecycle overlays
// ---------------------------------------------------------------------------

function SkeletonOverlay() {
  const { t } = useTranslation("session");
  return (
    // Opaque veil: attach replay streams retained output through xterm while
    // this overlay is up; the default translucent veil would let the terminal
    // visibly race through history (高频刷屏). Ended-session overlays stay
    // translucent on purpose so their read-only history remains visible.
    <div className="term-overlay term-overlay-solid">
      <div className="overlay-card skeleton-card" style={{ alignItems: "stretch", textAlign: "left" }}>
        <h3>{t("ui.lifecycle.connectingHost")}</h3>
        <div className="skeleton" aria-hidden="true">
          <div className="skeleton-line" style={{ width: "88%" }} />
          <div className="skeleton-line" style={{ width: "64%" }} />
          <div className="skeleton-line" style={{ width: "76%" }} />
        </div>
      </div>
    </div>
  );
}

function RestartGlyph() {
  return (
    <svg
      className="session-restart-glyph"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M23 4v6h-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SessionRestartButton({
  label,
  tip,
  onRestart,
}: {
  label: string;
  tip?: string;
  onRestart: () => void;
}) {
  const [turn, setTurn] = useState(0);
  return (
    <button
      type="button"
      className="session-restart-orb"
      aria-label={label}
      data-tip={tip ?? label}
      onClick={() => {
        setTurn((value) => value + 1);
        onRestart();
      }}
    >
      <RestartGlyph key={turn} />
    </button>
  );
}

function SessionOverlay({ ses, sessionKey }: { ses: SessionView; sessionKey: string }) {
  const { t } = useTranslation("session");
  const rt = useStore((state) => state.runtime[sessionKey]);
  const r = getRuntime(sessionKey);
  void rt; // subscribe

  if (ses.lifecycle === "interrupted") {
    const p = ses.resumePrecision;
    const warnings = [
      precisionLabel(p),
      p === "latest" ? t("ui.lifecycle.latestContextWarning") : "",
      p === "unavailable" ? t("ui.lifecycle.unavailableResumeWarning") : "",
    ].filter(Boolean);
    return (
      <div className="term-overlay">
        <span className="sr-only" role="status">
          {[t("ui.lifecycle.interrupted"), ...warnings].join(" ")}
        </span>
        <SessionRestartButton
          label={t("ui.actions.restart")}
          tip={[t("ui.actions.restart"), ...warnings].join("\n")}
          onRestart={() => {
            const deviceId = flowDeviceIdFor(sessionKey);
            if (deviceId) void restartSessionFlow(ses.id, deviceId);
            else void restartSessionFlow(ses.id);
          }}
        />
      </div>
    );
  }

  if (ses.lifecycle === "exited" || ses.lifecycle === "stopped" || r.exit) {
    const code = r.exit?.code;
    const signal = r.exit?.signal;
    return (
      <div className="term-overlay">
        <span className="sr-only" role="status">
          {[
            t("ui.lifecycle.stopped"),
            code !== null && code !== undefined
              ? t("ui.lifecycle.exitedWithCode", { code })
              : "",
            signal !== null && signal !== undefined
              ? t("ui.lifecycle.terminatedBySignal", { signal })
              : "",
            r.exit?.groupCleaned === false
              ? t("ui.lifecycle.groupCleanupUnconfirmed")
              : "",
            r.historyNote
              ? t("ui.lifecycle.readOnlyHistory", { note: r.historyNote })
              : "",
          ].filter(Boolean).join(" ")}
        </span>
        <SessionRestartButton
          label={t("ui.actions.restart")}
          onRestart={() => {
            const deviceId = flowDeviceIdFor(sessionKey);
            if (deviceId) void restartSessionFlow(ses.id, deviceId);
            else void restartSessionFlow(ses.id);
          }}
        />
      </div>
    );
  }

  // Cold attach/restart still needs the solid veil because xterm paints each
  // intermediate replay state. A normal switch restores its persisted
  // checkpoint behind a silent solid veil, then reveals it on xterm's first
  // actual render while suffix replay/attach continue in the background.
  const warmPreview = hasWarmTerminalPreview(sessionKey);
  const attachActive = r.attaching || r.attached;
  if (
    attachActive &&
    warmPreview &&
    !r.startupPending &&
    !isTerminalPreviewRendered(sessionKey)
  ) {
    return <div className="term-overlay term-overlay-solid" aria-hidden />;
  }
  if (shouldShowTerminalAttachOverlay(r, warmPreview)) {
    return <SkeletonOverlay />;
  }
  if (attachActive && !isTerminalPreviewRendered(sessionKey)) {
    return <SkeletonOverlay />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// banners
// ---------------------------------------------------------------------------

function ReconnectBanner({ ses, sessionKey }: { ses: SessionView; sessionKey: string }) {
  const { t } = useTranslation("session");
  const r = getRuntime(sessionKey);
  useStore((state) => state.runtime[sessionKey]);
  const show =
    r.detached &&
    !r.exit &&
    (ses.lifecycle === "running" || ses.lifecycle === "creating");
  if (!show) return null;
  return (
    <div className="banner warn" role="alert">
      <span>{t("ui.disconnected.checking")}</span>
      {r.error ? <span className="dim">{t("ui.disconnected.errorDetail", { detail: r.error })}</span> : null}
      <span className="spacer" />
      <button className="btn small" onClick={() => void attachHandle(sessionKey)}>
        {t("ui.actions.reconnect")}
      </button>
      <button className="btn small ghost" onClick={() => openDialog({ kind: "diagnostics" })}>
        {t("ui.actions.openDiagnostics")}
      </button>
    </div>
  );
}

function SuspendedBanner({ ses, sessionKey }: { ses: SessionView; sessionKey: string }) {
  const { t } = useTranslation("session");
  const suspended = useStore((state) => state.runtime[sessionKey]?.suspended === true);
  if (!suspended) return null;
  return (
    <div className="banner warn" role="status">
      <span>{t("ui.suspended.message")}</span>
      <span className="spacer" />
      <button
        className="btn small primary"
        onClick={() => {
          const deviceId = flowDeviceIdFor(sessionKey);
          if (deviceId) void resumeSessionFlow(ses.id, deviceId);
          else void resumeSessionFlow(ses.id);
        }}
      >
        {t("ui.suspended.resume")}
      </button>
    </div>
  );
}

function PhoneGeometryBanner({ ses, sessionKey }: { ses: SessionView; sessionKey: string }) {
  const { t } = useTranslation("session");
  const geometry = useStore(
    (state) => state.runtime[sessionKey]?.terminalGeometry ?? null,
  );
  const [restoring, setRestoring] = useState(false);
  const dismissedRevision = readDismissedGeometryRevision(ses.id, geometry);
  const prompt = terminalGeometryPromptState(geometry, dismissedRevision);
  if (!prompt.visible || !geometry || prompt.revision === null) return null;

  const label = restoring
    ? t("ui.phoneGeometry.restoring")
    : t("ui.phoneGeometry.restore");
  return (
    <div className="phone-geometry-banner">
      <button
        type="button"
        className="btn small phone-geometry-restore"
        aria-label={label}
        title={label}
        disabled={restoring}
        onClick={() => {
          setRestoring(true);
          void restoreDesktopTerminalSize(sessionKey, geometry.revision)
            .catch((error) => {
              toast(
                t("ui.phoneGeometry.restoreFailed", { detail: errorText(error) }),
                "error",
              );
            })
            .finally(() => setRestoring(false));
        }}
      >
        <span aria-hidden="true">💻</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// session status affordance
// ---------------------------------------------------------------------------

function TermStatusLine({ sessionKey }: { sessionKey: string }) {
  const { t } = useTranslation("shell");
  useStore((state) => state.runtime[sessionKey]);
  const r = getRuntime(sessionKey);
  if (!r.scrolledUp && !r.terminalTitle) return null;
  return (
    <div className="term-statusline">
      {r.terminalTitle ? <span className="term-title">{r.terminalTitle}</span> : null}
      {r.scrolledUp ? (
        <button
          className="back-to-latest"
          onClick={() => scrollToBottom(sessionKey)}
          data-tip={t("ui.terminal.backToLatestTip")}
        >
          {t("ui.terminal.backToLatest")}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// recursive pane workspace
// ---------------------------------------------------------------------------

function PaneAgentIcon({ ses }: { ses: SessionView }) {
  return ses.adapter === "shell" ? (
    <ShellIcon className="pane-agent-icon" size={15} />
  ) : (
    <AgentIcon agent={ses.adapter} className="pane-agent-icon" size={15} mono />
  );
}

function PaneHeader({
  ses,
  sessionKey,
  focused,
  maximized,
}: {
  ses: SessionView;
  sessionKey: string;
  focused: boolean;
  maximized: boolean;
}) {
  const { t } = useTranslation("shell");
  const { deviceKey } = parseSessionKey(sessionKey);
  const activeDevice = useStore((state) => state.activeDevice);
  const profiles = useDevicesStore((state) => state.devices);
  const deviceName =
    deviceKey === "local"
      ? null
      : activeDevice.kind === "remote" && activeDevice.deviceId === deviceKey
        ? activeDevice.deviceName
        : (profiles?.find((device) => device.id === deviceKey)?.name ??
          deviceKey);
  return (
    <header
      className="pane-header"
      aria-label={t("pane.headerLabel", { title: ses.title })}
    >
      <PaneAgentIcon ses={ses} />
      <StatusDot session={ses} />
      {deviceName ? (
        <span className="pane-device-badge" title={deviceName}>
          {deviceName}
        </span>
      ) : null}
      <span className="pane-title" title={`${agentDisplay(ses.adapter)} · ${ses.title}`}>
        {ses.title}
      </span>
      {focused ? (
        <span className="pane-focused-label">{t("pane.focused")}</span>
      ) : null}
      <span className="pane-header-spacer" />
      <button
        type="button"
        className="pane-header-action"
        aria-label={maximized ? t("pane.restore") : t("pane.maximize")}
        data-tip={maximized ? t("pane.restore") : t("pane.maximize")}
        onClick={(event) => {
          event.stopPropagation();
          toggleSessionPaneMaximized(sessionKey);
        }}
      >
        {maximized ? "↙" : "↗"}
      </button>
      <button
        type="button"
        className="pane-header-action"
        aria-label={t("pane.remove")}
        data-tip={t("pane.remove")}
        onClick={(event) => {
          event.stopPropagation();
          removeSessionPane(sessionKey);
        }}
      >
        ×
      </button>
    </header>
  );
}

function paneContextItems(
  ses: SessionView,
  sessionKey: string,
  t: ReturnType<typeof useTranslation<["session", "shell", "common"]>>["t"],
): MenuItem[] {
  const items: MenuItem[] = [];
  const flowDeviceId = flowDeviceIdFor(sessionKey);
  if (ses.transport === "pty") {
    const handle = getHandle(sessionKey);
    const selection = resolveCopySelection(handle);
    const mouseOwned =
      !!handle &&
      (handle.term.modes?.mouseTrackingMode ?? "none") !== "none";
    if (!selection && mouseOwned) {
      // A fullscreen TUI owns the mouse, so plain drags never form a
      // selection; tell the user the only working gesture instead of leaving
      // a silently-disabled Copy.
      items.push({
        label: t("shell:terminal.copySelectHint"),
        disabled: true,
      });
    }
    items.push(
      {
        label: t("shell:terminal.copy"),
        disabled: !selection,
        action: selection
          ? () => {
              void copyText(selection).then((copied) => {
                if (!copied) toast(t("common:feedback.copyFailed"), "error");
              });
            }
          : undefined,
      },
      {
        label: t("shell:terminal.paste"),
        action: () => {
          void readClipboardText()
            .then((text) => {
              const current = getHandle(sessionKey);
              if (text) current?.term.paste(text);
              current?.term.focus();
            })
            .catch((error) => toast(errorText(error), "error"));
        },
      },
      { label: "", separator: true },
    );
  }
  items.push(
    {
      label: t("shell:pane.splitRight"),
      disabled: !canSplitSessionPane(sessionKey, "right"),
      action: () => openSplitAgentPicker(sessionKey, "right"),
    },
    {
      label: t("shell:pane.splitDown"),
      disabled: !canSplitSessionPane(sessionKey, "down"),
      action: () => openSplitAgentPicker(sessionKey, "down"),
    },
    { label: "", separator: true },
    {
      label: t("common:actions.rename"),
      action: () =>
        flowDeviceId
          ? void renameSessionFlow(ses.id, flowDeviceId)
          : void renameSessionFlow(ses.id),
    },
    {
      label: t("session:ui.menu.restartAndResume"),
      action: () =>
        flowDeviceId
          ? void restartSessionFlow(ses.id, flowDeviceId)
          : void restartSessionFlow(ses.id),
    },
    {
      label: t("session:ui.menu.stop"),
      danger: true,
      action: () =>
        flowDeviceId
          ? void stopSessionFlow(ses.id, flowDeviceId)
          : void stopSessionFlow(ses.id),
    },
    {
      label: t("session:ui.menu.remove"),
      danger: true,
      action: () =>
        flowDeviceId
          ? void removeSessionFlow(ses.id, {
              confirm: true,
              deviceId: flowDeviceId,
            })
          : void removeSessionFlow(ses.id, { confirm: true }),
    },
  );
  return items;
}

/**
 * Split direction for a Session dropped on a pane, from the drop position.
 *
 * The overlay paints `right` and `down` as two side-by-side columns (see
 * `.pane-drop-overlay`), so the left half splits the dragged Session to the
 * right of this pane and the right half splits it below.
 */
function paneDropDirection(rect: DOMRect, clientX: number): PaneSplitDirection {
  return clientX - rect.left < rect.width / 2 ? "right" : "down";
}

/**
 * Pane-relative drop indicator.
 *
 * The overlay is deliberately inert (`pointer-events: none`): it used to own
 * the drop targets, but mounting it under the pointer changed WebKit's drag
 * target mid-gesture, which made GTK fire dragleave for the element that was
 * covered (with a null `relatedTarget`) and strobed the overlay on/off until
 * the pointer left. The split is now decided by the pane leaf that owns the
 * stable drop surface, and this only shows where the Session will land.
 */
function PaneDropOverlay({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("shell");
  const zone = (direction: PaneSplitDirection) => {
    const allowed = canSplitSessionPane(ses.id, direction);
    return (
      <div
        className={`pane-drop-zone ${direction}${allowed ? "" : " disabled"}`}
        aria-disabled={!allowed}
      >
        <span>{t(direction === "right" ? "pane.dropRight" : "pane.dropDown")}</span>
      </div>
    );
  };
  return (
    <div className="pane-drop-overlay" role="presentation">
      {zone("right")}
      {zone("down")}
    </div>
  );
}

function SessionPaneLeaf({
  ses: initialSession,
  sessionKey,
  focused,
  visible,
  multiPane,
  maximized,
}: {
  ses: SessionView;
  sessionKey: string;
  focused: boolean;
  visible: boolean;
  multiPane: boolean;
  maximized: boolean;
}) {
  const { t } = useTranslation(["session", "shell", "common"]);
  // A non-focused leaf can change without changing the root's active Session
  // selector. Its overlay/header must observe the same snapshot as TerminalPane.
  const ses =
    useStore((state) => findSessionByKeyForState(state, sessionKey)?.session) ??
    initialSession;
  const [sessionDragActive, setSessionDragActive] = useState(false);
  const leafRef = useRef<HTMLDivElement | null>(null);
  const ended = ["stopped", "exited", "interrupted"].includes(ses.lifecycle);
  useEffect(() => {
    if (visible && ended) return watchEndedSessions();
  }, [visible, ended]);
  // The indicator survives WebKit's spurious dragleave bursts, so the gesture's
  // real boundaries are tracked explicitly: a drop or a cancelled drag anywhere
  // ends it, and WebKit reliably reports entering another element (the sidebar,
  // a neighbouring pane, the pane divider) even when it never reports leaving
  // this pane.
  useEffect(() => {
    if (!sessionDragActive) return;
    const clear = () => setSessionDragActive(false);
    const onEnter = (event: DragEvent) => {
      const target = event.target as Node | null;
      const leaf = leafRef.current;
      if (!leaf || !target || leaf.contains(target)) return;
      setSessionDragActive(false);
    };
    window.addEventListener("dragend", clear, { once: true });
    window.addEventListener("drop", clear, { once: true });
    window.addEventListener("dragenter", onEnter, true);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("dragenter", onEnter, true);
    };
  }, [sessionDragActive]);

  return (
    <div
      ref={leafRef}
      className={
        "session-pane-leaf" +
        (focused ? " focused" : "") +
        (visible ? "" : " max-hidden")
      }
      data-pane-session-id={sessionKey}
      aria-label={t("shell:pane.headerLabel", { title: ses.title })}
      onPointerDownCapture={() => {
        if (!focused) void focusSessionKey(sessionKey);
      }}
      onFocusCapture={() => {
        if (!focused) void focusSessionKey(sessionKey);
      }}
      onContextMenuCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!focused) void focusSessionKey(sessionKey);
        openContextMenu(
          event.clientX,
          event.clientY,
          paneContextItems(ses, sessionKey, t),
        );
      }}
      onDragEnter={(event) => {
        if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        setSessionDragActive(true);
      }}
      onDragOver={(event) => {
        if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setSessionDragActive(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.contains(next)) return;
        // WebKit reports a null relatedTarget and fires dragleave whenever the
        // element under the cursor is replaced during a drag (the drop
        // overlay mounting, a banner appearing, the terminal repainting), so
        // the pointer position — not relatedTarget — decides whether the
        // gesture really left this pane.
        const rect = event.currentTarget.getBoundingClientRect();
        const inside =
          event.clientX >= rect.left &&
          event.clientX < rect.right &&
          event.clientY >= rect.top &&
          event.clientY < rect.bottom;
        if (!inside) setSessionDragActive(false);
      }}
      onDrop={(event) => {
        if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        setSessionDragActive(false);
        const payload = readSessionPaneDragPayload(event.dataTransfer);
        if (!payload) return;
        const direction = paneDropDirection(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
        );
        if (canSplitSessionPane(sessionKey, direction)) {
          splitSessionIntoPane(sessionKey, payload.sessionId, direction);
        } else {
          toast(t("shell:pane.tooSmall"), "info");
        }
      }}
    >
      {multiPane || parseSessionKey(sessionKey).deviceKey !== "local" ? (
        <PaneHeader
          ses={ses}
          sessionKey={sessionKey}
          focused={focused}
          maximized={maximized}
        />
      ) : null}
      <div className="pane-session-surface">
        {ses.transport === "json_rpc" ? (
          <PiStructuredTimeline ses={ses} />
        ) : (
          <>
            <div className="workspace-banners">
              <PhoneGeometryBanner ses={ses} sessionKey={sessionKey} />
              <ReconnectBanner ses={ses} sessionKey={sessionKey} />
              <SuspendedBanner ses={ses} sessionKey={sessionKey} />
            </div>
            <div className="pane-terminal-renderer">
              <TerminalPane sessionKey={sessionKey} focused={focused} visible={visible} />
              <SessionOverlay ses={ses} sessionKey={sessionKey} />
            </div>
            <TermStatusLine sessionKey={sessionKey} />
          </>
        )}
      </div>
      {sessionDragActive && visible ? (
        <PaneDropOverlay ses={ses} />
      ) : null}
    </div>
  );
}

function clampSplitRatio(
  split: PaneSplit,
  rect: DOMRect,
  clientX: number,
  clientY: number,
): number {
  const axisLength = split.direction === "right" ? rect.width : rect.height;
  const available = Math.max(1, axisLength - PANE_SEPARATOR_SIZE);
  const offset =
    (split.direction === "right" ? clientX - rect.left : clientY - rect.top) -
    PANE_SEPARATOR_SIZE / 2;
  return clampPaneSplitRatio(
    split,
    axisLength,
    offset / available,
    PANE_SEPARATOR_SIZE,
  );
}

function PaneDivider({ split }: { split: PaneSplit }) {
  const { t } = useTranslation("shell");
  const dragRect = useRef<DOMRect | null>(null);
  const dragging = useRef(false);
  useEffect(
    () => () => {
      if (dragging.current) document.body.classList.remove("is-resizing-pane");
    },
    [],
  );
  const resizeWithPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = dragRect.current;
    if (!dragging.current || !rect) return;
    setPaneSplitRatio(
      split.id,
      clampSplitRatio(split, rect, event.clientX, event.clientY),
      false,
    );
  };
  const stop = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    dragRect.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-resizing-pane");
    persistCurrentPaneLayout();
  };
  const keyboardRatio = (delta: number, parent: HTMLElement | null) => {
    const rect = parent?.getBoundingClientRect();
    const axisLength = split.direction === "right" ? rect?.width : rect?.height;
    const length = axisLength ?? 1000;
    const available = Math.max(1, length - PANE_SEPARATOR_SIZE);
    setPaneSplitRatio(
      split.id,
      clampPaneSplitRatio(
        split,
        length,
        split.ratio + delta / available,
        PANE_SEPARATOR_SIZE,
      ),
    );
  };

  return (
    <div
      className={`pane-divider ${split.direction}`}
      role="separator"
      aria-label={t(
        split.direction === "right"
          ? "pane.resizeVertical"
          : "pane.resizeHorizontal",
      )}
      aria-orientation={split.direction === "right" ? "vertical" : "horizontal"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split.ratio * 100)}
      tabIndex={0}
      data-tip={t("pane.resizeHint")}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const parent = event.currentTarget.parentElement;
        if (!parent) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRect.current = parent.getBoundingClientRect();
        dragging.current = true;
        document.body.classList.add("is-resizing-pane");
      }}
      onPointerMove={resizeWithPointer}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={() => setPaneSplitRatio(split.id, 0.5)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 16;
        const decrease =
          split.direction === "right" ? event.key === "ArrowLeft" : event.key === "ArrowUp";
        const increase =
          split.direction === "right" ? event.key === "ArrowRight" : event.key === "ArrowDown";
        if (decrease || increase) {
          event.preventDefault();
          keyboardRatio(decrease ? -step : step, event.currentTarget.parentElement);
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          keyboardRatio(
            (event.key === "Home" ? -1 : 1) * 100000,
            event.currentTarget.parentElement,
          );
        }
      }}
    />
  );
}

function paneNodeKey(node: PaneLayoutNode): string {
  return node.type === "leaf" ? `leaf:${node.sessionId}` : `split:${node.id}`;
}

/**
 * A restored cross-device pane can outlive its Session snapshot (startup or a
 * disconnected device). Render an explicit reconnect surface instead of a
 * silently missing grid cell, and never mount a terminal for an unknown key.
 */
function MissingSessionPane({
  sessionKey,
  visible,
}: {
  sessionKey: string;
  visible: boolean;
}) {
  const { t } = useTranslation(["shell", "common"]);
  const { deviceKey } = parseSessionKey(sessionKey);
  const activeDevice = useStore((state) => state.activeDevice);
  const activeDeviceKey = deviceKeyForContext(activeDevice);
  const connections = useDeviceConnections((state) => state.connections);
  const snapshots = useDeviceSessions((state) => state.snapshots);
  const profiles = useDevicesStore((state) => state.devices);
  const connection = connections[deviceKey];
  const snapshot = snapshots[deviceKey];
  const deviceName =
    activeDevice.kind === "remote" && activeDevice.deviceId === deviceKey
      ? activeDevice.deviceName
      : (profiles?.find((device) => device.id === deviceKey)?.name ??
        snapshot?.deviceName ??
        deviceKey);
  const connected = isDeviceConnected(deviceKey);
  const missing =
    connected &&
    snapshot !== undefined &&
    !snapshot.loading &&
    !snapshot.error;
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (connected && !snapshot && deviceKey !== "local") {
      void refreshDeviceSnapshot(deviceKey);
    }
  }, [connected, deviceKey, snapshot]);

  const reconnect = async () => {
    setReconnecting(true);
    try {
      if (deviceKey === activeDeviceKey) {
        await reconnectActiveDevice();
      } else {
        await connectDevice(deviceKey);
        await refreshDeviceSnapshot(deviceKey);
      }
    } catch {
      // The device strip and connection state carry the error detail.
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <div
      className={
        "session-pane-leaf missing-session-pane" + (visible ? "" : " max-hidden")
      }
      data-pane-session-id={sessionKey}
      role="status"
    >
      <div className="workspace-empty">
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            ⌁
          </div>
          <div>
            {missing
              ? t("shell:ui.activeDevices.sessionMissing")
              : connected
                ? t("shell:ui.activeDevices.loading")
                : t("shell:ui.activeDevices.disconnected")}
          </div>
          <div className="dim">{deviceName}</div>
          {connection?.error || snapshot?.error ? (
            <div className="dim" data-tip={connection?.error ?? snapshot?.error ?? undefined}>
              {connection?.error ?? snapshot?.error}
            </div>
          ) : null}
          <div className="overlay-actions">
            {!connected ? (
              <button
                className="btn primary"
                disabled={reconnecting}
                onClick={() => void reconnect()}
              >
                {t("shell:ui.activeDevices.connect")}
              </button>
            ) : null}
            <button
              className="btn"
              onClick={() => removeSessionPane(sessionKey)}
            >
              {t("shell:ui.activeDevices.closePane")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PaneTree({
  node,
  focusedSessionId,
  maximizedSessionId,
  multiPane,
}: {
  node: PaneLayoutNode;
  focusedSessionId: string | null;
  maximizedSessionId: string | null;
  multiPane: boolean;
}) {
  const subtreeVisible =
    !maximizedSessionId || layoutContains(node, maximizedSessionId);
  if (node.type === "leaf") {
    const located = findSessionByKey(node.sessionId);
    if (!located) {
      return <MissingSessionPane sessionKey={node.sessionId} visible={subtreeVisible} />;
    }
    return (
      <SessionPaneLeaf
        ses={located.session}
        sessionKey={node.sessionId}
        focused={focusedSessionId === node.sessionId}
        visible={subtreeVisible}
        multiPane={multiPane}
        maximized={maximizedSessionId === node.sessionId}
      />
    );
  }

  const firstVisible =
    !maximizedSessionId || layoutContains(node.first, maximizedSessionId);
  const secondVisible =
    !maximizedSessionId || layoutContains(node.second, maximizedSessionId);
  const firstStyle = {
    flexBasis: `calc(${node.ratio * 100}% - ${node.ratio * PANE_SEPARATOR_SIZE}px)`,
  } as CSSProperties;
  return (
    <div
      className={`pane-split ${node.direction}${maximizedSessionId ? " maximized-path" : ""}`}
      data-pane-split-id={node.id}
    >
      <div
        className={`pane-split-child first${firstVisible ? "" : " max-hidden"}`}
        style={firstStyle}
      >
        <PaneTree
          key={paneNodeKey(node.first)}
          node={node.first}
          focusedSessionId={focusedSessionId}
          maximizedSessionId={maximizedSessionId}
          multiPane={multiPane}
        />
      </div>
      <PaneDivider split={node} />
      <div className={`pane-split-child second${secondVisible ? "" : " max-hidden"}`}>
        <PaneTree
          key={paneNodeKey(node.second)}
          node={node.second}
          focusedSessionId={focusedSessionId}
          maximizedSessionId={maximizedSessionId}
          multiPane={multiPane}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// main area
// ---------------------------------------------------------------------------

export default function TerminalArea() {
  const { t } = useTranslation(["session", "shell", "common"]);
  const terminalLayout = useStore((state) => state.terminalLayout);
  const deviceSwitching = useStore((state) => state.deviceSwitching);
  const maximizedSessionId = useStore((state) => state.maximizedSessionId);
  const focusedSessionKey = useStore((state) => activeSessionKey(state));
  const hasAnySession = useStore((state) =>
    state.projects.some((project) => project.sessions.length > 0),
  );
  const hasProjects = useStore((state) => state.projects.length > 0);
  const docExpanded = useStore(
    (state) => state.docPanelExpanded && hasOpenDocuments(state),
  );
  // A Session outside the remembered split is shown as a temporary singleton.
  // The stored tree remains intact and reappears when one of its leaves is
  // selected (or when the App restarts).
  const layout = visiblePaneLayout(terminalLayout, focusedSessionKey);
  const paneIds = orderedLayoutSessionIds(layout);
  const multiPane = paneIds.length > 1;
  const paneFocusedKey =
    focusedSessionKey && layoutContains(layout, focusedSessionKey)
      ? focusedSessionKey
      : layout.focusedSessionId;
  const effectiveMaximizedSessionId =
    maximizedSessionId && layoutContains(layout, maximizedSessionId)
      ? maximizedSessionId
      : null;

  return (
    <section className="workspace" aria-label={t("shell:ui.workspace.label")}>
      {/* Clearing activeSessionId does not remove the remembered pane layout.
          Unmount it for the entire switch/rollback: intentional detach must not
          look like a Host failure or mount a target terminal before boot ends. */}
      {layout.root ? (
        <div className={`term-body${docExpanded ? " doc-expanded" : ""}`}>
          <div className="term-stack">
            <div
              className={`pane-layout${effectiveMaximizedSessionId ? " maximized" : ""}`}
              role="group"
              aria-label={t("shell:pane.workspaceLabel")}
            >
              <PaneTree
                key={paneNodeKey(layout.root)}
                node={layout.root}
                focusedSessionId={paneFocusedKey}
                maximizedSessionId={effectiveMaximizedSessionId}
                multiPane={multiPane}
              />
            </div>
          </div>
          <DocumentPanel />
        </div>
      ) : deviceSwitching ? (
        <div className="workspace-empty" role="status" aria-live="polite">
          <div className="empty-state">{t("shell:ui.topBar.devices.switching")}</div>
        </div>
      ) : (
        <div className="workspace-empty">
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">
              ❯
            </div>
            {hasAnySession ? (
              <div>{t("shell:ui.empty.selectSession")}</div>
            ) : hasProjects ? (
              <>
                <div>{t("shell:ui.empty.noRunningTasks")}</div>
                <button className="btn primary" onClick={() => openNewSessionDialog()}>
                  {t("session:ui.actions.new")}
                </button>
              </>
            ) : (
              <>
                <div>{t("shell:ui.empty.addDirectoryPrompt")}</div>
                <button className="btn primary" onClick={() => openDialog({ kind: "addProject" })}>
                  {t("shell:ui.actions.addProject")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
