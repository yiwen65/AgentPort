// Terminal workspace: persistent xterm panes (display:none toggling), header
// with session actions, reconnect/suspension banners, in-terminal search
// bar (⌘F — never sends to the PTY), lifecycle overlays, status line and
// "回到最新" (⌘↓).

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
  api,
  copyText,
  errorText,
  readClipboardText,
} from "../api";
import {
  findSession,
  getRuntime,
  getState,
  openContextMenu,
  openDialog,
  setState,
  toast,
  useStore,
  type MenuItem,
} from "../store";
import {
  attachHandle,
  fitSession,
  focusSession,
  getHandle,
  hasWarmTerminalPreview,
  isTerminalPreviewRendered,
  loadOlderNativeHistory,
  mountTerminal,
  noteTerminalScrollIntent,
  scrollTerminalViewport,
  scrollToBottom,
  setTerminalActive,
  restoreDesktopTerminalSize,
} from "../terminals";
import {
  dropTreeEntryIntoTerminal,
  hasTreeDragPayload,
  readDragPayload,
} from "../terminalDrop";
import {
  canSplitSessionPane,
  PANE_SEPARATOR_SIZE,
  openNewSessionDialog,
  openSplitAgentPicker,
  persistCurrentPaneLayout,
  removeSessionPane,
  renameSessionFlow,
  resumeSessionFlow,
  restartSessionFlow,
  selectSession,
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
import type { SearchHit, SearchResult, SessionView } from "../types";
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

// ---------------------------------------------------------------------------
// persistent pane
// ---------------------------------------------------------------------------

const TERMINAL_SCROLL_THUMB_PX = 72;

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
      setPosition((current) =>
        current.value === next.value && current.max === next.max ? current : next,
      );
    });
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    let connectFrame = 0;
    let scrollDisposable: { dispose(): void } | undefined;
    let writeDisposable: { dispose(): void } | undefined;

    const connect = () => {
      const handle = getHandle(sessionId);
      if (!handle) {
        connectFrame = requestAnimationFrame(connect);
        return;
      }
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
      scrollDisposable?.dispose();
      writeDisposable?.dispose();
    };
  }, [active, sessionId, schedulePositionSync]);

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
  const style = {
    "--terminal-scroll-top": `calc(${ratio * 100}% - ${ratio * TERMINAL_SCROLL_THUMB_PX}px)`,
  } as CSSProperties;

  return (
    <div
      ref={trackRef}
      className={"terminal-scrollbar" + (dragging ? " dragging" : "")}
      style={style}
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
  sessionId,
  focused,
  visible,
}: {
  sessionId: string;
  focused: boolean;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ses = useStore((state) => findSession(state.projects, sessionId));
  const runtime = useStore((state) => state.runtime[sessionId]);
  const scrolledUp = getRuntime(sessionId).scrolledUp;
  const [dropActive, setDropActive] = useState(false);

  useLayoutEffect(() => {
    if (hostRef.current) mountTerminal(sessionId, hostRef.current);
  }, [sessionId]);

  useLayoutEffect(() => {
    setTerminalActive(sessionId, visible);
    if (!visible) return;
    // Every visible split pane owns a live attachment. Focus is independent:
    // only one xterm textarea receives keyboard input, while all panes stream.
    const sesNow = findSession(getState().projects, sessionId);
    if (sesNow && (sesNow.lifecycle === "running" || sesNow.lifecycle === "creating")) {
      void attachHandle(sessionId);
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
  }, [focused, sessionId, visible, ses?.lifecycle, ses?.hostAlive, ses?.status?.runId, ses?.status?.runOrdinal]);

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
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!visible) return;
        const payload = readDragPayload(event.dataTransfer);
        // Plain non-path text falls through to the native drop, which inserts
        // the text into the terminal as-is.
        if (!payload) return;
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
// in-terminal search (SearchAddon; page-local, never touches the PTY)
// ---------------------------------------------------------------------------

const SEARCH_DECORATIONS = {
  matchBackground: "#7a5c00",
  matchOverviewRuler: "#d8a03b",
  activeMatchBackground: "#b98a00",
  activeMatchColorOverviewRuler: "#ffd840",
};

interface TerminalSearchPosition {
  resultIndex: number;
  resultCount: number;
  buffer: "normal" | "alternate";
}

const EMPTY_TERMINAL_SEARCH_POSITION: TerminalSearchPosition = {
  resultIndex: -1,
  resultCount: 0,
  buffer: "normal",
};

function TermSearchBar({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("shell");
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [searchPosition, setSearchPosition] = useState<TerminalSearchPosition>(
    EMPTY_TERMINAL_SEARCH_POSITION,
  );
  const [logResult, setLogResult] = useState<SearchResult | null>(null);
  const [logSearching, setLogSearching] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [logIndex, setLogIndex] = useState(0);
  const logTimer = useRef<number | null>(null);
  const logRequest = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      getHandle(sessionId)?.search.clearDecorations();
    };
  }, [sessionId]);

  useEffect(() => {
    let connectFrame = 0;
    let resultDisposable: { dispose(): void } | undefined;
    const connect = () => {
      const handle = getHandle(sessionId);
      if (!handle) {
        connectFrame = requestAnimationFrame(connect);
        return;
      }
      resultDisposable = handle.search.onDidChangeResults((result) => {
        setSearchPosition({
          resultIndex: result.resultIndex,
          resultCount: result.resultCount,
          buffer: handle.term.buffer.active.type,
        });
      });
    };
    connect();
    return () => {
      cancelAnimationFrame(connectFrame);
      resultDisposable?.dispose();
    };
  }, [sessionId]);

  // Agent-native history can predate the bounded xterm attach tail. Query it
  // separately without copying the transcript into the terminal buffer.
  useEffect(() => {
    if (logTimer.current !== null) window.clearTimeout(logTimer.current);
    const query = q.trim();
    const request = ++logRequest.current;
    if (query.length < 2) {
      setLogResult(null);
      setLogSearching(false);
      setLogError(null);
      setLogIndex(0);
      return;
    }
    setLogSearching(true);
    logTimer.current = window.setTimeout(() => {
      api
        .searchSessionLog(sessionId, query, 1_000)
        .then((result) => {
          if (request !== logRequest.current) return;
          setLogResult(result);
          setLogIndex(0);
          setLogError(null);
        })
        .catch((e) => {
          if (request !== logRequest.current) return;
          setLogResult(null);
          setLogError(t("ui.terminalSearch.searchFailed", { detail: errorText(e) }));
        })
        .finally(() => {
          if (request === logRequest.current) setLogSearching(false);
        });
    }, 180);
    return () => {
      if (logTimer.current !== null) window.clearTimeout(logTimer.current);
    };
  }, [q, sessionId]);

  const find = (query: string, dir: "next" | "prev", incremental = false) => {
    const h = getHandle(sessionId);
    if (!h) return;
    const needle = query.trim();
    if (!needle) {
      h.search.clearDecorations();
      setSearchPosition(EMPTY_TERMINAL_SEARCH_POSITION);
      return;
    }
    const opts = { incremental, decorations: SEARCH_DECORATIONS };
    noteTerminalScrollIntent(sessionId, "locating");
    if (dir === "next") h.search.findNext(needle, opts);
    else h.search.findPrevious(needle, opts);
  };

  const logHits = (logResult?.hits ?? []).filter((hit) => hit.kind === "terminal");
  const totalLogHits = logResult?.totalHits ?? logHits.length;
  const selectedLogHit: SearchHit | null = logHits[logIndex] ?? null;
  const hasBufferResult = searchPosition.resultCount > 0;
  const bufferScope =
    searchPosition.buffer === "normal"
      ? t("ui.terminalSearch.currentBuffer")
      : t("ui.terminalSearch.currentScreen");
  const bufferPosition = hasBufferResult
    ? t("ui.terminalSearch.matchPosition", {
        scope: bufferScope,
        current:
          searchPosition.resultIndex >= 0 ? searchPosition.resultIndex + 1 : "?",
        count: searchPosition.resultCount,
      })
    : null;

  const navigate = (dir: "next" | "prev") => {
    find(q, dir);
    if (logHits.length > 1) {
      setLogIndex((current) =>
        dir === "next"
          ? (current + 1) % logHits.length
          : (current - 1 + logHits.length) % logHits.length,
      );
    }
  };

  const close = () => {
    setState({ termSearchOpen: false });
    focusSession(sessionId);
  };

  return (
    <div className="term-search" role="search" aria-label={t("ui.terminalSearch.regionLabel")}>
      <div className="term-search-main">
        <input
          ref={inputRef}
          type="text"
          placeholder={t("ui.terminalSearch.placeholder")}
          aria-label={t("ui.terminalSearch.inputLabel")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSearchPosition(EMPTY_TERMINAL_SEARCH_POSITION);
            find(e.target.value, "next", true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              navigate(e.shiftKey ? "prev" : "next");
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        <span className="count" aria-live="polite">
          {bufferPosition ??
            (q.trim() ? t("ui.terminalSearch.noCurrentBufferResults") : "")}
        </span>
        <button
          className="btn small ghost"
          onClick={() => navigate("prev")}
          aria-label={t("ui.terminalSearch.previousMatch")}
        >
          ↑
        </button>
        <button
          className="btn small ghost"
          onClick={() => navigate("next")}
          aria-label={t("ui.terminalSearch.nextMatch")}
        >
          ↓
        </button>
        <button
          className="btn small ghost"
          onClick={close}
          aria-label={t("ui.terminalSearch.close")}
        >
          ✕
        </button>
      </div>
      {q.trim() ? (
        <div className="term-search-history" aria-live="polite">
          <span className="term-search-history-label">{t("ui.terminalSearch.fullHistory")}</span>
          <span className="term-search-buffer-status">
            {bufferPosition ?? t("ui.terminalSearch.noResultsInCurrentBuffer")}
          </span>
          <span className="term-search-log-status">
            {logSearching
              ? t("ui.terminalSearch.searchingPersistedLog")
              : logError
                ? t("ui.terminalSearch.fullHistoryUnavailable")
                : selectedLogHit
                  ? t("ui.terminalSearch.logMatchPosition", {
                      current: logIndex + 1,
                      count: totalLogHits,
                      loaded: totalLogHits > logHits.length
                        ? t("ui.terminalSearch.loadedHits", { count: logHits.length })
                        : "",
                      snippet: selectedLogHit.snippet,
                    })
                  : t("ui.terminalSearch.noResults")}
          </span>
        </div>
      ) : null}
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
      <div className="overlay-card" style={{ alignItems: "stretch", textAlign: "left" }}>
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

function SessionAgentMark({ adapter }: { adapter: string }) {
  const theme = useStore((state) => state.themeEffective);
  return (
    <span className={`session-agent-mark ${adapter}`}>
      {adapter === "shell" ? (
        <ShellIcon className="session-agent-glyph shell" size={32} />
      ) : (
        <AgentIcon
          agent={adapter}
          className="session-agent-glyph"
          size={32}
          mono={theme === "light"}
        />
      )}
    </span>
  );
}

function SessionOverlay({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("session");
  const rt = useStore((state) => state.runtime[ses.id]);
  const r = getRuntime(ses.id);
  void rt; // subscribe

  if (ses.lifecycle === "interrupted") {
    const p = ses.resumePrecision;
    return (
      <div className="term-overlay">
        <div className="overlay-card session-state-card" role="alert">
          <SessionAgentMark adapter={ses.adapter} />
          <h3>{ses.title}</h3>
          <p className="session-state-label">{t("ui.lifecycle.interrupted")}</p>
          <span className="sr-only">{precisionLabel(p)}</span>
          {p === "latest" ? (
            <p className="session-state-detail warn-text">
              {t("ui.lifecycle.latestContextWarning")}
            </p>
          ) : null}
          {p === "unavailable" ? (
            <p className="session-state-detail warn-text">
              {t("ui.lifecycle.unavailableResumeWarning")}
            </p>
          ) : null}
          <div className="overlay-actions">
            <button
              className="btn primary"
              data-tip={precisionLabel(p)}
              onClick={() => void restartSessionFlow(ses.id)}
            >
              {t("ui.actions.restart")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ses.lifecycle === "exited" || ses.lifecycle === "stopped" || r.exit) {
    const code = r.exit?.code;
    const signal = r.exit?.signal;
    return (
      <div className="term-overlay">
        <div className="overlay-card session-state-card" role="alert">
          <SessionAgentMark adapter={ses.adapter} />
          <h3>{ses.title}</h3>
          <p className="session-state-label">
            {t("ui.lifecycle.stopped")}
          </p>
          {(code !== null && code !== undefined) || (signal !== null && signal !== undefined) || r.exit?.groupCleaned === false ? (
            <p className="session-state-detail">
              {code !== null && code !== undefined ? <span>{t("ui.lifecycle.exitedWithCode", { code })} </span> : null}
              {signal !== null && signal !== undefined
                ? t("ui.lifecycle.terminatedBySignal", { signal })
                : ""}
              {r.exit?.groupCleaned === false ? (
                <span className="warn-text">{t("ui.lifecycle.groupCleanupUnconfirmed")}</span>
              ) : null}
            </p>
          ) : null}
          {r.historyNote ? (
            <p className="session-state-history">
              {t("ui.lifecycle.readOnlyHistory", { note: r.historyNote })}
            </p>
          ) : null}
          <div className="overlay-actions">
            <button className="btn primary" onClick={() => void restartSessionFlow(ses.id)}>
              {t("ui.actions.restart")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Cold attach/restart still needs the solid veil because xterm paints each
  // intermediate replay state. A normal switch restores its persisted
  // checkpoint behind a silent solid veil, then reveals it on xterm's first
  // actual render while suffix replay/attach continue in the background.
  const warmPreview = hasWarmTerminalPreview(ses.id);
  const attachActive = r.attaching || r.attached;
  if (
    attachActive &&
    warmPreview &&
    !r.startupPending &&
    !isTerminalPreviewRendered(ses.id)
  ) {
    return <div className="term-overlay term-overlay-solid" aria-hidden />;
  }
  if (shouldShowTerminalAttachOverlay(r, warmPreview)) {
    return <SkeletonOverlay />;
  }
  if (attachActive && !isTerminalPreviewRendered(ses.id)) {
    return <SkeletonOverlay />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// banners
// ---------------------------------------------------------------------------

function ReconnectBanner({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("session");
  const r = getRuntime(ses.id);
  useStore((state) => state.runtime[ses.id]);
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
      <button className="btn small" onClick={() => void attachHandle(ses.id)}>
        {t("ui.actions.reconnect")}
      </button>
      <button className="btn small ghost" onClick={() => openDialog({ kind: "diagnostics" })}>
        {t("ui.actions.openDiagnostics")}
      </button>
    </div>
  );
}

function SuspendedBanner({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("session");
  const suspended = useStore((state) => state.runtime[ses.id]?.suspended === true);
  if (!suspended) return null;
  return (
    <div className="banner warn" role="status">
      <span>{t("ui.suspended.message")}</span>
      <span className="spacer" />
      <button className="btn small primary" onClick={() => void resumeSessionFlow(ses.id)}>
        {t("ui.suspended.resume")}
      </button>
    </div>
  );
}

function PhoneGeometryBanner({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("session");
  const geometry = useStore(
    (state) => state.runtime[ses.id]?.terminalGeometry ?? null,
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
          void restoreDesktopTerminalSize(ses.id, geometry.revision)
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

function TermStatusLine({ ses }: { ses: SessionView }) {
  const { t } = useTranslation("shell");
  useStore((state) => state.runtime[ses.id]);
  const r = getRuntime(ses.id);
  if (!r.scrolledUp && !r.terminalTitle) return null;
  return (
    <div className="term-statusline">
      {r.terminalTitle ? <span className="term-title">{r.terminalTitle}</span> : null}
      {r.scrolledUp ? (
        <button
          className="back-to-latest"
          onClick={() => scrollToBottom(ses.id)}
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
  focused,
  maximized,
}: {
  ses: SessionView;
  focused: boolean;
  maximized: boolean;
}) {
  const { t } = useTranslation("shell");
  return (
    <header
      className="pane-header"
      aria-label={t("pane.headerLabel", { title: ses.title })}
    >
      <PaneAgentIcon ses={ses} />
      <StatusDot session={ses} />
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
          toggleSessionPaneMaximized(ses.id);
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
          removeSessionPane(ses.id);
        }}
      >
        ×
      </button>
    </header>
  );
}

function paneContextItems(
  ses: SessionView,
  multiPane: boolean,
  maximized: boolean,
  t: ReturnType<typeof useTranslation<["session", "shell", "common"]>>["t"],
): MenuItem[] {
  const items: MenuItem[] = [];
  if (ses.transport === "pty") {
    const handle = getHandle(ses.id);
    const selection = handle?.term.getSelection() ?? "";
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
              const current = getHandle(ses.id);
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
      disabled: !canSplitSessionPane(ses.id, "right"),
      action: () => openSplitAgentPicker(ses.id, "right"),
    },
    {
      label: t("shell:pane.splitDown"),
      disabled: !canSplitSessionPane(ses.id, "down"),
      action: () => openSplitAgentPicker(ses.id, "down"),
    },
    { label: "", separator: true },
    {
      label: maximized ? t("shell:pane.restore") : t("shell:pane.maximize"),
      disabled: !multiPane,
      action: () => toggleSessionPaneMaximized(ses.id),
    },
    {
      label: t("shell:pane.remove"),
      action: () => removeSessionPane(ses.id),
    },
    { label: "", separator: true },
    {
      label: t("common:actions.rename"),
      action: () => void renameSessionFlow(ses.id),
    },
    {
      label: t("session:ui.menu.stop"),
      danger: true,
      action: () => void stopSessionFlow(ses.id),
    },
  );
  return items;
}

function PaneDropOverlay({
  ses,
  onDone,
}: {
  ses: SessionView;
  onDone: () => void;
}) {
  const { t } = useTranslation("shell");
  const zone = (direction: PaneSplitDirection) => {
    const allowed = canSplitSessionPane(ses.id, direction);
    return (
      <div
        className={`pane-drop-zone ${direction}${allowed ? "" : " disabled"}`}
        aria-disabled={!allowed}
        onDragOver={(event) => {
          if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = allowed ? "move" : "none";
        }}
        onDrop={(event) => {
          if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          const payload = readSessionPaneDragPayload(event.dataTransfer);
          if (allowed && payload) {
            splitSessionIntoPane(ses.id, payload.sessionId, direction);
          } else if (!allowed) {
            toast(t("pane.tooSmall"), "info");
          }
          onDone();
        }}
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
  focused,
  visible,
  multiPane,
  maximized,
}: {
  ses: SessionView;
  focused: boolean;
  visible: boolean;
  multiPane: boolean;
  maximized: boolean;
}) {
  const { t } = useTranslation(["session", "shell", "common"]);
  // A non-focused leaf can change without changing the root's active Session
  // selector. Its overlay/header must observe the same snapshot as TerminalPane.
  const ses = useStore((state) => findSession(state.projects, initialSession.id)) ?? initialSession;
  const termSearchOpen = useStore((state) => state.termSearchOpen);
  const [sessionDragActive, setSessionDragActive] = useState(false);
  const ended = ["stopped", "exited", "interrupted"].includes(ses.lifecycle);
  useEffect(() => {
    if (visible && ended) return watchEndedSessions();
  }, [visible, ended]);

  return (
    <div
      className={
        "session-pane-leaf" +
        (focused ? " focused" : "") +
        (visible ? "" : " max-hidden")
      }
      data-pane-session-id={ses.id}
      aria-label={t("shell:pane.headerLabel", { title: ses.title })}
      onPointerDownCapture={() => {
        if (!focused) selectSession(ses.id);
      }}
      onFocusCapture={() => {
        if (!focused) selectSession(ses.id);
      }}
      onContextMenuCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!focused) selectSession(ses.id);
        openContextMenu(
          event.clientX,
          event.clientY,
          paneContextItems(ses, multiPane, maximized, t),
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
        if (!next || !event.currentTarget.contains(next)) setSessionDragActive(false);
      }}
      onDrop={(event) => {
        if (!hasSessionPaneDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        setSessionDragActive(false);
      }}
    >
      {multiPane ? (
        <PaneHeader ses={ses} focused={focused} maximized={maximized} />
      ) : null}
      <div className="pane-session-surface">
        {ses.transport === "json_rpc" ? (
          <PiStructuredTimeline ses={ses} />
        ) : (
          <>
            <div className="workspace-banners">
              <PhoneGeometryBanner ses={ses} />
              <ReconnectBanner ses={ses} />
              <SuspendedBanner ses={ses} />
            </div>
            {focused && termSearchOpen ? <TermSearchBar sessionId={ses.id} /> : null}
            <div className="pane-terminal-renderer">
              <TerminalPane sessionId={ses.id} focused={focused} visible={visible} />
              <SessionOverlay ses={ses} />
            </div>
            <TermStatusLine ses={ses} />
          </>
        )}
      </div>
      {sessionDragActive && visible ? (
        <PaneDropOverlay
          ses={ses}
          onDone={() => setSessionDragActive(false)}
        />
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
    const ses = findSession(getState().projects, node.sessionId);
    if (!ses) return null;
    return (
      <SessionPaneLeaf
        ses={ses}
        focused={focusedSessionId === ses.id}
        visible={subtreeVisible}
        multiPane={multiPane}
        maximized={maximizedSessionId === ses.id}
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
  const activeSessionId = useStore((state) => state.activeSessionId);
  const maximizedSessionId = useStore((state) => state.maximizedSessionId);
  const activeSession = useStore((state) =>
    findSession(state.projects, state.activeSessionId),
  );
  const hasAnySession = useStore((state) =>
    state.projects.some((project) => project.sessions.length > 0),
  );
  const hasProjects = useStore((state) => state.projects.length > 0);
  const docExpanded = useStore(
    (state) => state.docPanelExpanded && state.openDocument !== null,
  );
  // A Session outside the remembered split is shown as a temporary singleton.
  // The stored tree remains intact and reappears when one of its leaves is
  // selected (or when the App restarts).
  const layout = visiblePaneLayout(
    terminalLayout,
    activeSession?.id ?? null,
  );
  const paneIds = orderedLayoutSessionIds(layout);
  const multiPane = paneIds.length > 1;
  const effectiveMaximizedSessionId =
    maximizedSessionId && layoutContains(layout, maximizedSessionId)
      ? maximizedSessionId
      : null;

  return (
    <section className="workspace" aria-label={t("shell:ui.workspace.label")}>
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
                focusedSessionId={activeSessionId ?? layout.focusedSessionId}
                maximizedSessionId={effectiveMaximizedSessionId}
                multiPane={multiPane}
              />
            </div>
          </div>
          <DocumentPanel />
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
