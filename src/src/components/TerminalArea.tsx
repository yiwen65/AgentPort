// Terminal workspace: persistent xterm panes (display:none toggling), header
// with session actions, reconnect/suspension banners, in-terminal search
// bar (⌘F — never sends to the PTY), lifecycle overlays, status line and
// "回到最新" (⌘↓).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { api, errorText } from "../api";
import {
  findSession,
  getRuntime,
  getState,
  openDialog,
  setState,
  useStore,
} from "../store";
import {
  attachHandle,
  fitSession,
  focusSession,
  getHandle,
  loadOlderNativeHistory,
  mountTerminal,
  noteTerminalScrollIntent,
  scrollTerminalViewport,
  scrollToBottom,
  setTerminalActive,
} from "../terminals";
import {
  dropTreeEntryIntoTerminal,
  hasTreeDragPayload,
  readDragPayload,
} from "../terminalDrop";
import {
  openNewSessionDialog,
  resumeSessionFlow,
  restartSessionFlow,
} from "../actions";
import { precisionLabel } from "../format";
import type { SearchHit, SearchResult, SessionView } from "../types";
import { AgentIcon } from "./AgentIcons";
import ShellIcon from "./ShellIcon";
import PiStructuredTimeline from "./PiStructuredTimeline";
import DocumentPanel from "./DocumentPanel";
import { useTranslation } from "react-i18next";

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
  active,
}: {
  sessionId: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ses = useStore((state) => findSession(state.projects, sessionId));
  useStore((state) => state.runtime[sessionId]);
  const scrolledUp = getRuntime(sessionId).scrolledUp;
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    if (hostRef.current) mountTerminal(sessionId, hostRef.current);
  }, [sessionId]);

  useEffect(() => {
    setTerminalActive(sessionId, active);
    if (active) {
      // Auto re-attach a live session that lost its channel (e.g. after a
      // transient socket error) when the user switches back to it.
      const sesNow = findSession(getState().projects, sessionId);
      if (sesNow && (sesNow.lifecycle === "running" || sesNow.lifecycle === "creating")) {
        void attachHandle(sessionId);
      }
      // Do this after two frames. The first frame applies the active-pane
      // styles; the second gives xterm a non-zero, painted viewport.
      // Calling fit while its old pane used display:none was the source of
      // intermittent black screens after creating a Session then switching.
      let secondRaf: number | null = null;
      const firstRaf = requestAnimationFrame(() => {
        secondRaf = requestAnimationFrame(() => {
          fitSession(sessionId, true);
          focusSession(sessionId);
        });
      });
      return () => {
        cancelAnimationFrame(firstRaf);
        if (secondRaf !== null) cancelAnimationFrame(secondRaf);
      };
    }
  }, [active, sessionId]);

  const ended =
    ses?.lifecycle === "exited" ||
    ses?.lifecycle === "stopped" ||
    ses?.lifecycle === "interrupted";

  return (
    <div
      className={
        "term-pane" +
        (active ? "" : " hidden") +
        (ended ? " ended" : "") +
        (scrolledUp ? " scrolled-up" : "") +
        (dropActive ? " drop-target" : "")
      }
      onWheelCapture={(event: WheelEvent<HTMLDivElement>) => {
        if (!active || event.deltaY >= 0) return;
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
        if (!active || !hasTreeDragPayload(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!active) return;
        const payload = readDragPayload(event.dataTransfer);
        // Plain non-path text falls through to the native drop, which inserts
        // the text into the terminal as-is.
        if (!payload) return;
        event.preventDefault();
        dropTreeEntryIntoTerminal(sessionId, ses?.adapter ?? "shell", payload);
      }}
    >
      <div className="term-host" ref={hostRef} />
      <TerminalScrollbar sessionId={sessionId} active={active} />
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
    const stopped = ses.lifecycle === "stopped";
    return (
      <div className="term-overlay">
        <div className="overlay-card session-state-card" role="alert">
          <SessionAgentMark adapter={ses.adapter} />
          <h3>{ses.title}</h3>
          <p className="session-state-label">
            {stopped
              ? t("ui.lifecycle.stopped")
              : code !== null && code !== undefined
                ? t("ui.lifecycle.exitedWithCode", { code })
                : t("ui.lifecycle.exited")}
          </p>
          {(signal !== null && signal !== undefined) || r.exit?.groupCleaned === false ? (
            <p className="session-state-detail">
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

  // The attach command can resolve before xterm drains the replay writes.
  // Keep the pane covered while either side of that handoff is active; the
  // runtime flag advances only at the parser boundary queued by replay_done.
  if ((!r.replayDone || r.startupPending) && (r.attaching || r.attached)) {
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
// main area
// ---------------------------------------------------------------------------

export default function TerminalArea() {
  const { t } = useTranslation(["session", "shell", "common"]);
  const ses = useStore((state) => findSession(state.projects, state.activeSessionId));
  const hasAnySession = useStore((state) =>
    state.projects.some((project) => project.sessions.length > 0),
  );
  const hasProjects = useStore((state) => state.projects.length > 0);
  const termSearchOpen = useStore((state) => state.termSearchOpen);
  const docExpanded = useStore((state) => state.docPanelExpanded && state.openDocument !== null);
  const attachedIds = useStore((state) => state.attachedIds);
  const attachedPtyIds = attachedIds.filter(
    (id) => findSession(getState().projects, id)?.transport === "pty",
  );

  return (
    <section className="workspace" aria-label={t("shell:ui.workspace.label")}>
      {ses ? (
        ses.transport === "json_rpc" ? (
          <PiStructuredTimeline ses={ses} />
        ) : (
        <>
          <div className="workspace-banners">
            <ReconnectBanner ses={ses} />
            <SuspendedBanner ses={ses} />
          </div>
          {termSearchOpen ? <TermSearchBar sessionId={ses.id} /> : null}
          <div className={`term-body${docExpanded ? " doc-expanded" : ""}`}>
            <div className="term-stack">
              {attachedPtyIds.map((id) => (
                  <TerminalPane
                    key={id}
                    sessionId={id}
                    active={id === ses.id}
                  />
              ))}
              <SessionOverlay ses={ses} />
            </div>
            <DocumentPanel />
          </div>
          <TermStatusLine ses={ses} />
        </>
        )
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
