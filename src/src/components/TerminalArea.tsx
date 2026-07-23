// Terminal workspace: persistent xterm panes (display:none toggling), header
// with session actions, reconnect/uncommitted banners, in-terminal search
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
} from "react";
import { api, copyText, errorText } from "../api";
import {
  findSession,
  getRuntime,
  getState,
  openDialog,
  setState,
  toast,
  useStore,
} from "../store";
import {
  attachHandle,
  fitSession,
  focusSession,
  getHandle,
  locateTerminalBufferMatch,
  loadHistoryTail,
  mountTerminal,
  searchTerminalBuffers,
  scrollToBottom,
  type TerminalBufferMatch,
} from "../terminals";
import {
  dismissUncommittedNotice,
  openNewSessionDialog,
  refreshActiveWorktreeStatus,
  restartSessionFlow,
} from "../actions";
import { precisionZh } from "../format";
import type { SearchHit, SearchResult, SessionView } from "../types";
import { ClaudeIcon, CodexIcon, KimiIcon } from "./AgentIcons";
import ShellIcon from "./ShellIcon";
import PiStructuredTimeline from "./PiStructuredTimeline";

// ---------------------------------------------------------------------------
// persistent pane
// ---------------------------------------------------------------------------

const TERMINAL_SCROLL_THUMB_PX = 72;

interface TerminalScrollPosition {
  value: number;
  max: number;
}

function readTerminalScrollPosition(sessionId: string): TerminalScrollPosition {
  const buffer = getHandle(sessionId)?.term.buffer.active;
  return buffer
    ? { value: Math.min(buffer.viewportY, buffer.baseY), max: buffer.baseY }
    : { value: 0, max: 0 };
}

/**
 * A fixed-size overlay thumb. Native scrollbar thumbs grow with the viewport
 * ratio and can become a full-height "shadow" for short buffers. This short
 * handle maps its complete travel to xterm's complete scrollback, so dragging
 * it remains fast even when a Session has a very large log.
 */
function TerminalScrollbar({ sessionId }: { sessionId: string }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef(TERMINAL_SCROLL_THUMB_PX / 2);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [position, setPosition] = useState<TerminalScrollPosition>(() =>
    readTerminalScrollPosition(sessionId),
  );

  const syncPosition = useCallback(() => {
    const next = readTerminalScrollPosition(sessionId);
    setPosition((current) =>
      current.value === next.value && current.max === next.max ? current : next,
    );
  }, [sessionId]);

  useEffect(() => {
    let connectFrame = 0;
    let scrollDisposable: { dispose(): void } | undefined;
    let writeDisposable: { dispose(): void } | undefined;

    const connect = () => {
      const handle = getHandle(sessionId);
      if (!handle) {
        connectFrame = requestAnimationFrame(connect);
        return;
      }
      syncPosition();
      scrollDisposable = handle.term.onScroll(syncPosition);
      writeDisposable = handle.term.onWriteParsed(syncPosition);
    };

    connectFrame = requestAnimationFrame(connect);
    return () => {
      cancelAnimationFrame(connectFrame);
      scrollDisposable?.dispose();
      writeDisposable?.dispose();
    };
  }, [sessionId, syncPosition]);

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
      handle.term.scrollToTop();
    } else if (ratio === 1) {
      handle.term.scrollToBottom();
    } else {
      handle.term.scrollToLine(Math.round(ratio * max));
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
    const term = getHandle(sessionId)?.term;
    if (!term) return;
    switch (event.key) {
      case "ArrowUp":
        term.scrollLines(-3);
        break;
      case "ArrowDown":
        term.scrollLines(3);
        break;
      case "PageUp":
        term.scrollPages(-1);
        break;
      case "PageDown":
        term.scrollPages(1);
        break;
      case "Home":
        term.scrollToTop();
        break;
      case "End":
        term.scrollToBottom();
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
      aria-label="Session 历史滚动位置"
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

function TerminalPane({ sessionId, active }: { sessionId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ses = findSession(useStore().projects, sessionId);
  const scrolledUp = getRuntime(sessionId).scrolledUp;

  useEffect(() => {
    if (hostRef.current) mountTerminal(sessionId, hostRef.current);
  }, [sessionId]);

  useEffect(() => {
    if (active) {
      // Auto re-attach a live session that lost its channel (e.g. after a
      // transient socket error) when the user switches back to it.
      const sesNow = findSession(getState().projects, sessionId);
      if (sesNow && (sesNow.lifecycle === "running" || sesNow.lifecycle === "creating")) {
        void attachHandle(sessionId);
      } else if (sesNow) {
        // Ended session: make sure the read-only history terminal is filled
        // (e.g. lifecycle flipped to interrupted while another tab was active).
        void loadHistoryTail(sessionId);
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
        (scrolledUp ? " scrolled-up" : "")
      }
    >
      <div className="term-host" ref={hostRef} />
      <TerminalScrollbar sessionId={sessionId} />
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

function TermSearchBar({ sessionId }: { sessionId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [bufferHits, setBufferHits] = useState<TerminalBufferMatch[]>([]);
  const [bufferIndex, setBufferIndex] = useState(0);
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
    const query = q.trim();
    if (!query) {
      setBufferHits([]);
      setBufferIndex(0);
      return;
    }
    const refresh = () => {
      const hits = searchTerminalBuffers(sessionId, query);
      setBufferHits(hits);
      setBufferIndex((current) => Math.min(current, Math.max(0, hits.length - 1)));
    };
    refresh();
    // Output can arrive after the user begins searching. Coalesce write
    // parsing so a fast stream does not scan scrollback once per chunk.
    let timer: number | null = null;
    const disposable = getHandle(sessionId)?.term.onWriteParsed(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(refresh, 120);
    });
    return () => {
      disposable?.dispose();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [q, sessionId]);

  // The persisted log also includes output that predates xterm's attach replay
  // tail. Query it separately without loading the entire log into the
  // interactive terminal buffer.
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
          setLogError(errorText(e));
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
    if (!query) {
      h.search.clearDecorations();
      return;
    }
    const opts = { incremental, decorations: SEARCH_DECORATIONS };
    if (dir === "next") h.search.findNext(query, opts);
    else h.search.findPrevious(query, opts);
  };

  const logHits = (logResult?.hits ?? []).filter((hit) => hit.kind === "terminal");
  const totalLogHits = logResult?.totalHits ?? logHits.length;
  const selectedLogHit: SearchHit | null = logHits[logIndex] ?? null;
  const selectedBufferHit = bufferHits[bufferIndex] ?? null;

  const navigate = (dir: "next" | "prev") => {
    find(q, dir);
    if (bufferHits.length > 1) {
      const next =
        dir === "next"
          ? (bufferIndex + 1) % bufferHits.length
          : (bufferIndex - 1 + bufferHits.length) % bufferHits.length;
      setBufferIndex(next);
      locateTerminalBufferMatch(sessionId, bufferHits[next]);
    } else if (selectedBufferHit) {
      locateTerminalBufferMatch(sessionId, selectedBufferHit);
    }
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
    <div className="term-search" role="search" aria-label="终端历史搜索">
      <div className="term-search-main">
        <input
          ref={inputRef}
          type="text"
          placeholder="搜索完整终端历史（不会发送给 Agent）"
          aria-label="搜索终端历史"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
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
          {selectedBufferHit
            ? `${selectedBufferHit.buffer === "normal" ? "当前缓冲" : "当前屏幕"} ${bufferIndex + 1}/${bufferHits.length}`
            : q.trim()
              ? "当前缓冲：无结果"
              : ""}
        </span>
        <button className="btn small ghost" onClick={() => navigate("prev")} aria-label="上一个匹配">
          ↑
        </button>
        <button className="btn small ghost" onClick={() => navigate("next")} aria-label="下一个匹配">
          ↓
        </button>
        <button className="btn small ghost" onClick={close} aria-label="关闭搜索">
          ✕
        </button>
      </div>
      {q.trim() ? (
        <div className="term-search-history" aria-live="polite">
          <span className="term-search-history-label">完整历史</span>
          <span className="term-search-buffer-status">
            {selectedBufferHit
              ? `${selectedBufferHit.buffer === "normal" ? "当前缓冲" : "当前屏幕"}：${selectedBufferHit.snippet}`
              : "当前缓冲中无结果"}
          </span>
          <span className="term-search-log-status">
            {logSearching
              ? "正在搜索持久化日志…"
              : logError
                ? "完整历史不可用"
                : selectedLogHit
                  ? `${logIndex + 1}/${totalLogHits}${
                      totalLogHits > logHits.length ? `（已载入 ${logHits.length} 条）` : ""
                    }：${selectedLogHit.snippet}`
                  : "无结果"}
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
  return (
    <div className="term-overlay">
      <div className="overlay-card" style={{ alignItems: "stretch", textAlign: "left" }}>
        <h3>正在连接 Session Host…</h3>
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
  const theme = useStore().themeEffective;
  if (adapter === "shell") {
    return <ShellIcon className="session-agent-mark shell" size={36} />;
  }
  const cls = `session-agent-mark ${adapter}`;
  if (adapter === "codex") return <CodexIcon className={cls} size={36} />;
  if (adapter === "claude") return <ClaudeIcon className={cls} size={36} />;
  if (adapter === "kimi") return <KimiIcon className={cls} size={36} mono={theme === "light"} />;
  return null;
}

function SessionOverlay({ ses }: { ses: SessionView }) {
  const rt = useStore().runtime[ses.id];
  const r = getRuntime(ses.id);
  void rt; // subscribe

  if (ses.lifecycle === "interrupted") {
    const p = ses.resumePrecision;
    return (
      <div className="term-overlay">
        <div className="overlay-card session-state-card" role="alert">
          <SessionAgentMark adapter={ses.adapter} />
          <h3>{ses.title}</h3>
          <p className="session-state-label">Session 已中断</p>
          <span className="sr-only">{precisionZh(p)}</span>
          {p === "latest" ? (
            <p className="session-state-detail warn-text">
              可能缺少本次完整上下文。
            </p>
          ) : null}
          {p === "unavailable" ? (
            <p className="session-state-detail warn-text">
              无可恢复标识；重启将创建新会话。
            </p>
          ) : null}
          <div className="overlay-actions">
            <button
              className="btn primary"
              data-tip={precisionZh(p)}
              onClick={() => void restartSessionFlow(ses.id)}
            >
              重启
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
              ? "Session 已停止"
              : code !== null && code !== undefined
                ? `Session 已退出（退出码 ${code}）`
                : "Session 已退出"}
          </p>
          {(signal !== null && signal !== undefined) || r.exit?.groupCleaned === false ? (
            <p className="session-state-detail">
              {signal !== null && signal !== undefined ? `被信号 ${signal} 终止。` : ""}
              {r.exit?.groupCleaned === false ? (
                <span className="warn-text">进程组清理未完全确认，请检查诊断中心。</span>
              ) : null}
            </p>
          ) : null}
          {r.historyNote ? (
            <p className="session-state-history">
              上方终端为只读历史输出。{r.historyNote}
            </p>
          ) : null}
          <div className="overlay-actions">
            <button className="btn primary" onClick={() => void restartSessionFlow(ses.id)}>
              重启
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (r.attaching && !r.replayDone) return <SkeletonOverlay />;
  return null;
}

// ---------------------------------------------------------------------------
// banners
// ---------------------------------------------------------------------------

function ReconnectBanner({ ses }: { ses: SessionView }) {
  const r = getRuntime(ses.id);
  useStore().runtime[ses.id]; // subscribe
  const show =
    r.detached &&
    !r.exit &&
    (ses.lifecycle === "running" || ses.lifecycle === "creating");
  if (!show) return null;
  return (
    <div className="banner warn" role="alert">
      <span>连接已中断，正在确认 Agent 是否仍在运行。</span>
      {r.error ? <span className="dim">（{r.error}）</span> : null}
      <span className="spacer" />
      <button className="btn small" onClick={() => void attachHandle(ses.id)}>
        重新连接
      </button>
      <button className="btn small ghost" onClick={() => openDialog({ kind: "diagnostics" })}>
        诊断中心
      </button>
    </div>
  );
}

function UncommittedBanner({ ses }: { ses: SessionView }) {
  const s = useStore();
  const r = getRuntime(ses.id);
  const ws = s.activeWorktreeStatus;
  const stateNow = r.status?.state ?? ses.status?.state;
  const doneLike =
    ses.lifecycle === "exited" ||
    ses.lifecycle === "stopped" ||
    stateNow === "idle" ||
    stateNow === "exited";
  const seq = r.status?.sequence ?? ses.status?.sequence ?? 0;
  const show = Boolean(
    ses.worktreeId && doneLike && ws?.health === "dirty" && s.noticeDismissed[ses.id] !== seq,
  );

  // Refresh health when the session settles into a finished-looking state.
  useEffect(() => {
    if (doneLike && ses.worktreeId) void refreshActiveWorktreeStatus();
  }, [doneLike, ses.worktreeId, ses.id]);

  if (!show || !ws) return null;
  return (
    <div className="banner info" role="status">
      <span>
        任务看起来已完成，但 Worktree 的结果尚未提交（修改 {ws.modified} · 暂存 {ws.staged} ·
        未跟踪 {ws.untracked}）。
      </span>
      <span className="spacer" />
      <button
        className="btn small"
        onClick={() =>
          void copyText(ws.raw).then((ok) =>
            toast(ok ? "已复制 git status" : "复制失败", ok ? "success" : "error"),
          )
        }
      >
        复制 git status
      </button>
      <button
        className="btn small ghost"
        onClick={() => dismissUncommittedNotice(ses.id, seq)}
        aria-label="忽略此提醒"
      >
        知道了
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// session status affordance
// ---------------------------------------------------------------------------

function TermStatusLine({ ses }: { ses: SessionView }) {
  useStore().runtime[ses.id]; // subscribe
  const r = getRuntime(ses.id);
  if (!r.scrolledUp) return null;
  return (
    <div className="term-statusline">
      <button
        className="back-to-latest"
        onClick={() => scrollToBottom(ses.id)}
        data-tip="快捷键：⌘↓（Linux：Ctrl+Shift+↓）"
      >
        ↓ 回到最新
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// main area
// ---------------------------------------------------------------------------

export default function TerminalArea() {
  const s = useStore();
  const ses = findSession(s.projects, s.activeSessionId);
  const hasAnySession = s.projects.some((p) => p.sessions.length > 0);

  return (
    <section className="workspace" aria-label="终端工作区">
      {ses ? (
        ses.transport === "json_rpc" ? (
          <PiStructuredTimeline ses={ses} />
        ) : (
        <>
          <ReconnectBanner ses={ses} />
          <UncommittedBanner ses={ses} />
          {s.termSearchOpen ? <TermSearchBar sessionId={ses.id} /> : null}
          <div className="term-stack">
            {s.attachedIds
              .filter((id) => findSession(s.projects, id)?.transport === "pty")
              .map((id) => (
                <TerminalPane key={id} sessionId={id} active={id === ses.id} />
              ))}
            <SessionOverlay ses={ses} />
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
              <div>在左侧选择一个 Session 继续工作。</div>
            ) : s.projects.length > 0 ? (
              <>
                <div>项目还没有运行中的任务。</div>
                <button className="btn primary" onClick={() => openNewSessionDialog()}>
                  新建 Session
                </button>
              </>
            ) : (
              <>
                <div>添加一个代码目录，开始第一个持久 Session。</div>
                <button className="btn primary" onClick={() => openDialog({ kind: "addProject" })}>
                  添加项目
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
