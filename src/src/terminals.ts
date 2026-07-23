// xterm.js instance manager. Each attached session owns one persistent
// Terminal; switching sessions only toggles pane visibility (PRD ch.2/3.3).
// All PTY I/O flows through the backend: input is base64 via send_input,
// output arrives on the attach Channel.

import { Terminal, type IBuffer, type ITheme } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Channel } from "@tauri-apps/api/core";
import { api, b64ToBytes, bytesToB64, errorText } from "./api";
import { PiStartupNoticeFilter } from "./piStartupNotice";
import {
  announce,
  getState,
  patchRuntime,
  patchSession,
  setState,
  toast,
  type EffectiveTheme,
} from "./store";
import { formatBytes, stateZh } from "./format";
import type { ChannelMsg, LogCursorView } from "./types";

// Keep a substantial local history window for interactive find/navigation.
// The persisted log remains the source of truth and can be much larger, but
// 4 MiB covers normal agent sessions (including the current 1.5 MiB repro)
// without replaying an entire configured retained-log window every time a pane opens.
const REPLAY_TAIL_BYTES = 4 * 1024 * 1024;
/** Keep a bounded LRU of mounted xterm instances instead of retaining every
 * Session the user has ever visited in this renderer process. */
export const MAX_PERSISTENT_TERMINALS = 3;

export interface TermHandle {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  opened: boolean;
  attached: boolean;
  attaching: boolean;
  /** Bumped per attach — stale channels from previous attaches are ignored. */
  generation: number;
  /** Backend-issued capability; only this renderer may detach it. */
  attachmentId: number | null;
  /** Log tail already rendered (ended sessions' read-only history). */
  historyLoaded: boolean;
  historyLoading: boolean;
  /** Last contiguous byte rendered for the current Host output stream. */
  logCursor: LogCursorView | null;
  /** Cursor awaiting an xterm write-queue callback before it can be reported
   * as renderer-observed to the backend. */
  pendingRenderedLogCursor: LogCursorView | null;
  renderObservationQueued: boolean;
  /** A recovery click loaded a bounded historical window, so the next live
   * frame may legitimately begin at the Host's newer high-water offset. */
  allowRecoveryGap: boolean;
  /** Marker inserted once the bounded replay crosses the selected event. */
  recoveryTarget: LogCursorView | null;
  container: HTMLDivElement | null;
  resizeObserver: ResizeObserver | null;
  lastCols: number;
  lastRows: number;
  lastScrolledUp: boolean;
  /** First user input for one-shot generated Session title replacement. */
  firstInputBuffer: string;
  firstInputSubmitted: boolean;
  inputEscapeSequence: boolean;
  inputEscapeCsi: boolean;
  piStartupNoticeFilter: PiStartupNoticeFilter | null;
}

/** A text hit from xterm's in-memory normal or alternate buffer. */
export interface TerminalBufferMatch {
  /** `normal` is the scrollback buffer; `alternate` is a full-screen TUI. */
  buffer: "normal" | "alternate";
  /** Zero-based xterm buffer row, usable for scrollToLine when it is active. */
  row: number;
  /** Compact, ANSI-free context from the matched physical line. */
  snippet: string;
}

const handles = new Map<string, TermHandle>();
const unreadOutputPending = new Set<string>();

/**
 * Captures the first non-empty command line without interfering with PTY I/O.
 * xterm provides input in chunks, so this handles typing, paste and backspace
 * until Enter. ANSI escape sequences from cursor/navigation keys are ignored.
 */
function captureFirstSubmittedInput(handle: TermHandle, data: string): string | null {
  if (handle.firstInputSubmitted) return null;

  for (const char of data) {
    if (handle.inputEscapeSequence) {
      if (!handle.inputEscapeCsi && char === "[") {
        handle.inputEscapeCsi = true;
        continue;
      }
      if (!handle.inputEscapeCsi || (char >= "@" && char <= "~")) {
        handle.inputEscapeSequence = false;
        handle.inputEscapeCsi = false;
      }
      continue;
    }
    if (char === "\x1b") {
      handle.inputEscapeSequence = true;
      handle.inputEscapeCsi = false;
      continue;
    }
    if (char === "\r" || char === "\n") {
      const input = handle.firstInputBuffer.trim();
      if (input) {
        handle.firstInputSubmitted = true;
        return input;
      }
      continue;
    }
    if (char === "\x7f" || char === "\b") {
      handle.firstInputBuffer = Array.from(handle.firstInputBuffer).slice(0, -1).join("");
      continue;
    }
    if (char.codePointAt(0)! >= 0x20 && handle.firstInputBuffer.length < 240) {
      handle.firstInputBuffer += char;
    }
  }
  return null;
}

const FALLBACK_FONT =
  "'JetBrains Mono Variable', 'SF Mono', SFMono-Regular, Menlo, 'PingFang SC', 'Hiragino Sans GB', 'Apple Color Emoji', monospace";
const DEFAULT_TERMINAL_FONT_SIZE = 13;
const bundledTerminalFontReady =
  typeof document !== "undefined" && document.fonts
    ? Promise.all([
        document.fonts.load(`400 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`),
        document.fonts.load(`600 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`),
        document.fonts.load(
          `italic 400 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
        document.fonts.load(
          `italic 600 ${DEFAULT_TERMINAL_FONT_SIZE}px "JetBrains Mono Variable"`,
        ),
      ])
    : Promise.resolve([]);

export function cssFontFamily(setting: string): string {
  if (!setting || setting === "system-monospace") return FALLBACK_FONT;
  return `'${setting.replace(/'/g, "")}', ${FALLBACK_FONT}`;
}

const XTERM_THEMES: Record<EffectiveTheme, ITheme> = {
  dark: {
    background: "#222228",
    foreground: "#fafafa",
    cursor: "#fafafa",
    cursorAccent: "#222228",
    selectionBackground: "#3a3a40",
    black: "#1c1c22",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#eab308",
    blue: "#3b82f6",
    magenta: "#a855f7",
    cyan: "#06b6d4",
    white: "#a1a1aa",
    brightBlack: "#6e6e76",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#facc15",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#22d3ee",
    brightWhite: "#fafafa",
  },
  light: {
    // Match Unpeel's native light Ghostty palette on an opaque canvas.
    background: "#ffffff",
    foreground: "#09090b",
    cursor: "#09090b",
    cursorAccent: "#ffffff",
    selectionBackground: "#d4d4d8",
    black: "#09090b",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    // CLI TUIs commonly emit ANSI white explicitly for body copy. On a light
    // terminal that slot must be dark, otherwise a clean launch renders the
    // transcript almost white-on-white until another repaint changes it.
    white: "#52525b",
    brightBlack: "#71717a",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#eab308",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#18181b",
  },
};

function syncHandleTheme(handle: TermHandle, theme = getState().themeEffective) {
  handle.term.options.theme = XTERM_THEMES[theme];
  // Color glyphs and truecolor contrast adjustments are cached by xterm.
  // Rebuild the Canvas atlas whenever a pane becomes visible or its theme
  // changes so a handle can never retain the prepaint/default dark palette.
  handle.term.clearTextureAtlas();
}

export function getHandle(sessionId: string): TermHandle | undefined {
  return handles.get(sessionId);
}

const BUFFER_SEARCH_LIMIT = 100;
const BUFFER_SNIPPET_CHARS = 120;

function bufferSnippet(text: string, query: string): string {
  const lower = text.toLocaleLowerCase();
  const at = lower.indexOf(query.toLocaleLowerCase());
  if (at < 0) return text.slice(0, BUFFER_SNIPPET_CHARS);
  const start = Math.max(0, at - 36);
  const end = Math.min(text.length, at + query.length + 72);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function collectBufferMatches(
  buffer: IBuffer,
  kind: TerminalBufferMatch["buffer"],
  query: string,
  out: TerminalBufferMatch[],
) {
  const needle = query.toLocaleLowerCase();
  for (let row = 0; row < buffer.length && out.length < BUFFER_SEARCH_LIMIT; row += 1) {
    const text = buffer.getLine(row)?.translateToString(true) ?? "";
    if (text.toLocaleLowerCase().includes(needle)) {
      out.push({ buffer: kind, row, snippet: bufferSnippet(text, query) });
    }
  }
}

/**
 * Search every xterm buffer that belongs to the Session. SearchAddon only
 * sees buffer.active, which becomes the one-screen alternate buffer for
 * fullscreen agent TUIs; normal retains the actual scrollback in that case.
 */
export function searchTerminalBuffers(sessionId: string, query: string): TerminalBufferMatch[] {
  const handle = handles.get(sessionId);
  const needle = query.trim();
  if (!handle || !needle) return [];
  const matches: TerminalBufferMatch[] = [];
  const { active, normal, alternate } = handle.term.buffer;
  if (active.type === "normal") {
    collectBufferMatches(normal, "normal", needle, matches);
  } else {
    collectBufferMatches(normal, "normal", needle, matches);
    if (matches.length < BUFFER_SEARCH_LIMIT) {
      collectBufferMatches(alternate, "alternate", needle, matches);
    }
  }
  return matches;
}

/** Scroll to a memory-buffer hit when that buffer is currently renderable. */
export function locateTerminalBufferMatch(sessionId: string, hit: TerminalBufferMatch): boolean {
  const handle = handles.get(sessionId);
  if (!handle || handle.term.buffer.active.type !== hit.buffer) return false;
  handle.term.scrollToLine(hit.row);
  handle.term.focus();
  return true;
}

export function getOrCreateHandle(sessionId: string): TermHandle {
  const existing = handles.get(sessionId);
  if (existing) return existing;
  const s = getState();
  const settings = s.settings;
  const session = s.projects.flatMap((project) => project.sessions).find((item) => item.id === sessionId);
  const term = new Terminal({
    fontFamily: cssFontFamily(settings?.terminalFontFamily ?? "system-monospace"),
    fontSize: settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE,
    fontWeight: "400",
    fontWeightBold: "600",
    lineHeight: 1.1,
    letterSpacing: 0,
    // Agent TUIs often emit hard-coded dark-theme truecolor escapes (for
    // example RGB 255/255/255). When the app switches to Light, xterm must
    // adapt those cells instead of drawing white-on-white. Selection already
    // did this implicitly, which is why selecting text appeared to fix it.
    minimumContrastRatio: 7,
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: false,
    cursorBlink: true,
    // A 4 MiB replay can legitimately contain more than the old 10k lines.
    // Preserve it so xterm search and keyboard navigation use the same
    // history that the persisted-log search reports.
    scrollback: 50000,
    screenReaderMode: settings?.screenReaderMode ?? false,
    allowProposedApi: true,
    macOptionIsMeta: true,
    allowTransparency: false,
    theme: XTERM_THEMES[s.themeEffective],
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  const handle: TermHandle = {
    sessionId,
    term,
    fit,
    search,
    opened: false,
    attached: false,
    attaching: false,
    generation: 0,
    attachmentId: null,
    historyLoaded: false,
    historyLoading: false,
    logCursor: null,
    pendingRenderedLogCursor: null,
    renderObservationQueued: false,
    allowRecoveryGap: false,
    recoveryTarget: null,
    container: null,
    resizeObserver: null,
    lastCols: 0,
    lastRows: 0,
    lastScrolledUp: false,
    firstInputBuffer: "",
    firstInputSubmitted: false,
    inputEscapeSequence: false,
    inputEscapeCsi: false,
    piStartupNoticeFilter:
      session?.adapter === "pi" && session.transport === "pty" && session.agentSessionId
        ? new PiStartupNoticeFilter(session.agentSessionId)
        : null,
  };
  term.onData((data) => {
    // Input is only writable once attached — writers register at attach time.
    if (!handle.attached) return;
    const firstInput = captureFirstSubmittedInput(handle, data);
    void sendTerminalInput(sessionId, data)
      .then(() => {
        if (!firstInput) return;
        void api.autoRenameSessionFromFirstInput(sessionId, firstInput).catch(() => {
          // Keep the input buffered so a later Enter can retry the harmless
          // metadata update if the database command temporarily fails.
          handle.firstInputSubmitted = false;
        });
      })
      .catch((e) => {
        if (firstInput) handle.firstInputSubmitted = false;
        patchRuntime(sessionId, { error: errorText(e) });
      });
  });
  term.onScroll(() => updateScrolledUp(handle));
  handles.set(sessionId, handle);
  return handle;
}

function writeTerminalOutput(handle: TermHandle, bytes: Uint8Array) {
  const visible = handle.piStartupNoticeFilter?.feed(bytes) ?? bytes;
  if (visible.length) handle.term.write(visible);
}

function finishTerminalStartupFilter(handle: TermHandle) {
  const visible = handle.piStartupNoticeFilter?.finish();
  if (visible?.length) handle.term.write(visible);
}

const MAX_INPUT_FRAME_BYTES = 256 * 1024;

/** Preserve byte ordering while splitting a large paste into bounded IPC
 * frames. The backend applies the same limit before forwarding to the Host. */
async function sendTerminalInput(sessionId: string, data: string): Promise<void> {
  const bytes = new TextEncoder().encode(data);
  for (let start = 0; start < bytes.length; start += MAX_INPUT_FRAME_BYTES) {
    await api.sendInput(
      sessionId,
      bytesToB64(bytes.subarray(start, start + MAX_INPUT_FRAME_BYTES)),
    );
  }
}

function updateScrolledUp(handle: TermHandle) {
  const buf = handle.term.buffer.active;
  const up = buf.viewportY < buf.baseY;
  if (up !== handle.lastScrolledUp) {
    handle.lastScrolledUp = up;
    patchRuntime(handle.sessionId, { scrolledUp: up });
  }
}

/** Mount (once) into a pane container div; starts the attach if needed. */
// WKWebView suppresses native key auto-repeat under macOS press-and-hold
// semantics (observed even with ApplePressAndHoldEnabled=false), so holding a
// key never repeats in the terminal. Synthesize repeat ourselves: when no
// native repeat arrives (KeyboardEvent.repeat), feed term.input() — the same
// path as real typing (onData → send_input → first-input title capture).
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 40;

function repeatableInput(e: KeyboardEvent): string | null {
  if (e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.key.length === 1) return e.key; // printable; Shift/CapsLock already applied
  if (e.key === "Backspace") return "\x7f"; // same sequence xterm emits
  return null;
}

function installInputRepeat(term: Terminal, container: HTMLElement): () => void {
  const textarea = term.textarea;
  if (!textarea) return () => {};
  let delayTimer: number | undefined;
  let intervalTimer: number | undefined;
  let activeCode: string | null = null;

  const stop = () => {
    if (delayTimer !== undefined) {
      window.clearTimeout(delayTimer);
      delayTimer = undefined;
    }
    if (intervalTimer !== undefined) {
      window.clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
    activeCode = null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Native repeats (if the platform delivers them) stay authoritative.
    if (e.repeat) {
      stop();
      return;
    }
    const data = repeatableInput(e);
    stop();
    if (data === null) return;
    activeCode = e.code;
    delayTimer = window.setTimeout(() => {
      delayTimer = undefined;
      intervalTimer = window.setInterval(() => term.input(data), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (activeCode === null || e.code === activeCode) stop();
  };

  // Observe from an ancestor in the capture phase: xterm's own textarea
  // handlers stop propagation, so listeners on the textarea itself never
  // fire. These listeners only observe; they never prevent or stop events.
  container.addEventListener("keydown", onKeyDown, true);
  container.addEventListener("keyup", onKeyUp, true);
  container.addEventListener("blur", stop, true);
  return () => {
    stop();
    container.removeEventListener("keydown", onKeyDown, true);
    container.removeEventListener("keyup", onKeyUp, true);
    container.removeEventListener("blur", stop, true);
  };
}

const inputRepeatDisposers = new Map<string, () => void>();

function bindTerminalContainer(handle: TermHandle, container: HTMLDivElement) {
  handle.container = container;
  inputRepeatDisposers.get(handle.sessionId)?.();
  inputRepeatDisposers.set(handle.sessionId, installInputRepeat(handle.term, container));
  handle.resizeObserver?.disconnect();
  handle.resizeObserver = new ResizeObserver(() => fitHandle(handle));
  handle.resizeObserver.observe(container);
}

export function mountTerminal(sessionId: string, container: HTMLDivElement) {
  const handle = getOrCreateHandle(sessionId);
  if (!handle.opened) {
    handle.opened = true;
    handle.term.open(container);
    bindTerminalContainer(handle, container);
    try {
      // Full-screen agent TUIs rely on Canvas to preserve their ANSI palette
      // and box glyphs in WKWebView. The DOM renderer is only a fallback when
      // Canvas cannot initialize at all.
      handle.term.loadAddon(new CanvasAddon());
      setState({ rendererMode: "canvas", rendererFallbackReason: null });
    } catch (error) {
      setState({
        rendererMode: "dom",
        rendererFallbackReason: `Canvas renderer unavailable: ${errorText(error)}`,
      });
    }
    syncHandleTheme(handle);
    fitHandle(handle);
    // A self-hosted webfont can finish loading after xterm's first canvas
    // measurement. Force one same-family option change so xterm remeasures
    // cells and repaints any fallback glyphs.
    void bundledTerminalFontReady.then(() => {
      if (handles.get(sessionId) !== handle || !handle.opened) return;
      const family = handle.term.options.fontFamily;
      handle.term.options.fontFamily = `${family}, monospace`;
      handle.term.options.fontFamily = family;
      handle.term.clearTextureAtlas();
      fitHandle(handle, true, true);
    });
  } else if (handle.container !== container) {
    // Structured Session views replace the terminal stack in the React tree.
    // An existing xterm keeps its element in the detached former host unless
    // we move it and rebind observers; the new host otherwise paints blank.
    const terminalElement = handle.term.element;
    if (terminalElement && terminalElement.parentElement !== container) {
      container.appendChild(terminalElement);
    }
    bindTerminalContainer(handle, container);
    requestAnimationFrame(() => {
      if (handles.get(sessionId) === handle && handle.container === container) {
        fitHandle(handle, true, true);
      }
    });
  }
  // Ended sessions have no live host: render the log tail as a read-only
  // grey history terminal (PRD 3.3.c) instead of a futile socket attach.
  const ses = getState()
    .projects.flatMap((p) => p.sessions)
    .find((x) => x.id === sessionId);
  const ended =
    ses &&
    (ses.lifecycle === "exited" ||
      ses.lifecycle === "stopped" ||
      ses.lifecycle === "interrupted");
  if (ended) void loadHistoryTail(sessionId);
  else void attachHandle(sessionId);
}

const HISTORY_TAIL_BYTES = 262144;

/** Write the session log tail into the terminal once (read-only history). */
export async function loadHistoryTail(sessionId: string): Promise<void> {
  const handle = getOrCreateHandle(sessionId);
  if (handle.historyLoaded || handle.historyLoading) return;
  handle.historyLoading = true;
  const generation = handle.generation;
  try {
    const res = await api.readLogTail(sessionId, HISTORY_TAIL_BYTES);
    if (handles.get(sessionId) !== handle || handle.generation !== generation) return;
    if (res.data) {
      writeTerminalOutput(handle, b64ToBytes(res.data));
      if (res.offset > 0) {
        patchRuntime(sessionId, {
          historyNote: `仅显示最后 ${formatBytes(res.total - res.offset)}（日志共 ${formatBytes(res.total)}）`,
        });
      }
    }
    finishTerminalStartupFilter(handle);
    handle.historyLoaded = true;
    patchRuntime(sessionId, { replayDone: true });
  } catch (e) {
    if (handles.get(sessionId) === handle && handle.generation === generation) {
      // A transient tail-read failure is retryable; never mark history loaded
      // before the bytes have actually reached this generation's xterm.
      patchRuntime(sessionId, { replayDone: true, historyNote: `日志读取失败：${errorText(e)}` });
    }
  } finally {
    if (handles.get(sessionId) === handle && handle.generation === generation) {
      handle.historyLoading = false;
    }
  }
}

const resizeTimers = new Map<string, number>();

export function fitHandle(handle: TermHandle, forceRedraw = false, forceResize = false) {
  const el = handle.container;
  if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
  try {
    handle.fit.fit();
  } catch {
    return;
  }
  const { cols, rows } = handle.term;
  if (forceRedraw && rows > 0) {
    // A pane is hidden with display:none while another Session is active.
    // WebGL/xterm can retain a blank back buffer after that transition even
    // when the PTY and terminal buffer are still healthy. Repaint after the
    // pane is laid out again; do not clear the glyph atlas here because a
    // full-screen TUI may be processing a PTY resize at the same time.
    handle.term.refresh(0, rows - 1);
  }
  const sizeChanged = cols !== handle.lastCols || rows !== handle.lastRows;
  if (sizeChanged) {
    handle.lastCols = cols;
    handle.lastRows = rows;
  }
  if ((sizeChanged || forceResize) && cols > 0 && rows > 0 && handle.attached) {
    // Debounce resize IPC during window drags. The first resize after attach
    // is forced even when fit() already recorded the same dimensions before
    // the PTY channel became writable; full-screen TUIs need this redraw.
    const prev = resizeTimers.get(handle.sessionId);
    if (prev !== undefined) window.clearTimeout(prev);
    const resizeGeneration = handle.generation;
    resizeTimers.set(
      handle.sessionId,
      window.setTimeout(() => {
        resizeTimers.delete(handle.sessionId);
        if (handles.get(handle.sessionId) !== handle || handle.generation !== resizeGeneration) return;
        api.resizePty(handle.sessionId, cols, rows).catch(() => undefined);
      }, 100),
    );
  }
}

/**
 * Reconcile an xterm instance after its pane becomes visible.  We force the
 * matching PTY resize here as well: a terminal can have acquired its visual
 * dimensions while it was inactive, before its attach channel became ready.
 */
export function fitSession(sessionId: string, forceResize = false) {
  const handle = handles.get(sessionId);
  if (handle) {
    syncHandleTheme(handle);
    fitHandle(handle, true, forceResize);
    if (handle.logCursor) queueRenderedLogObservation(handle, handle.logCursor);
  }
}

export function focusSession(sessionId: string) {
  handles.get(sessionId)?.term.focus();
}

export function scrollToBottom(sessionId: string) {
  const handle = handles.get(sessionId);
  if (!handle) return;
  handle.term.scrollToBottom();
  handle.term.focus();
}

/** Allow the next hidden-pane output to establish a fresh unread marker. */
export function clearUnreadOutputTracking(sessionId: string) {
  unreadOutputPending.delete(sessionId);
}

/** Attach (or re-attach) the backend channel and replay the log tail. */
export async function attachHandle(
  sessionId: string,
  recoveryTarget: LogCursorView | null = null,
): Promise<void> {
  const handle = getOrCreateHandle(sessionId);
  if (handle.attached || handle.attaching) return;
  handle.attaching = true;
  const generation = ++handle.generation;
  handle.pendingRenderedLogCursor = null;
  handle.renderObservationQueued = false;
  const resumeFrom = recoveryTarget ? null : handle.logCursor;
  patchRuntime(sessionId, { attaching: true, error: null, detached: false });
  const channel = new Channel<ChannelMsg>();
  channel.onmessage = (msg) => {
    if (handles.get(sessionId) !== handle || generation !== handle.generation) return;
    onChannelMsg(handle, msg);
  };
  try {
    const info = await api.attachSession(
      sessionId,
      REPLAY_TAIL_BYTES,
      channel,
      resumeFrom,
      recoveryTarget,
    );
    if (handles.get(sessionId) !== handle || generation !== handle.generation) {
      // The backend may have completed after this renderer was evicted or
      // reattached. Its capability can remove only that late attachment.
      void api.detachSession(sessionId, info.attachmentId).catch(() => undefined);
      return;
    }
    // A Host can exit between its handshake and the invoke reply. The channel
    // event is authoritative for this attach generation and must not be
    // overwritten by a late success response.
    const runtime = getState().runtime[sessionId];
    if (runtime?.exit || runtime?.detached || !info.childAlive) {
      handle.attached = false;
      void api.detachSession(sessionId, info.attachmentId).catch(() => undefined);
      patchRuntime(sessionId, { attaching: false, attached: false, detached: !info.childAlive });
      return;
    }
    handle.attachmentId = info.attachmentId;
    handle.attached = true;
    if (handle.logCursor) queueRenderedLogObservation(handle, handle.logCursor);
    // Content now arrives via replay/live stream — never tail-load on top.
    handle.historyLoaded = true;
    patchRuntime(sessionId, {
      attached: true,
      attaching: false,
      detached: false,
      hostPid: info.hostPid,
      logBytes: info.logBytes,
      error: null,
      exit: null,
    });
    if (info.status) {
      patchRuntime(sessionId, { status: info.status });
      patchSession(sessionId, { status: info.status });
    }
    if (info.agentSessionId) {
      patchSession(sessionId, { agentSessionId: info.agentSessionId });
    }
    // PTY size may have changed while detached. Force the first resize even
    // if the browser measured the same dimensions before attach completed.
    fitHandle(handle, true, true);
  } catch (e) {
    if (handles.get(sessionId) !== handle || generation !== handle.generation) return;
    patchRuntime(sessionId, {
      attaching: false,
      attached: false,
      detached: true,
      error: errorText(e),
    });
  } finally {
    if (handles.get(sessionId) === handle && generation === handle.generation) {
      handle.attaching = false;
    }
  }
}

function sameRun(a: LogCursorView, b: LogCursorView): boolean {
  return a.runId === b.runId && a.runOrdinal === b.runOrdinal;
}

function isLaterRun(incoming: LogCursorView, current: LogCursorView): boolean {
  return incoming.runOrdinal > current.runOrdinal ||
    (incoming.runOrdinal === current.runOrdinal && incoming.runId !== current.runId);
}

function renderedCursorIsNotOlder(candidate: LogCursorView, current: LogCursorView): boolean {
  return candidate.runOrdinal > current.runOrdinal ||
    (candidate.runOrdinal === current.runOrdinal &&
      candidate.runId === current.runId &&
      (candidate.generation > current.generation ||
        (candidate.generation === current.generation && candidate.offset >= current.offset)));
}

/** Report only a cursor whose preceding writes have drained through xterm's
 * parser queue. If output arrives behind the queued sentinel, it schedules a
 * second sentinel instead of being acknowledged by the earlier callback. */
function queueRenderedLogObservation(handle: TermHandle, cursor: LogCursorView) {
  if (
    handle.pendingRenderedLogCursor === null ||
    renderedCursorIsNotOlder(cursor, handle.pendingRenderedLogCursor)
  ) {
    handle.pendingRenderedLogCursor = { ...cursor };
  }
  if (handle.renderObservationQueued) return;

  const observed = handle.pendingRenderedLogCursor;
  if (!observed) return;
  handle.pendingRenderedLogCursor = null;
  handle.renderObservationQueued = true;
  const generation = handle.generation;
  // The empty write is an ordering sentinel: its callback runs only after all
  // terminal writes queued before this observation have been parsed.
  handle.term.write("", () => {
    if (handles.get(handle.sessionId) !== handle || handle.generation !== generation) return;
    handle.renderObservationQueued = false;
    const attachmentId = handle.attachmentId;
    if (attachmentId !== null && getState().activeSessionId === handle.sessionId) {
      void api
        .markSessionLogRendered(handle.sessionId, attachmentId, observed)
        .catch(() => undefined);
    }
    if (handle.pendingRenderedLogCursor) {
      queueRenderedLogObservation(handle, handle.pendingRenderedLogCursor);
    }
  });
}

/** Render only the missing contiguous suffix of a Host output frame. */
function applyOutputFrame(handle: TermHandle, msg: Extract<ChannelMsg, { t: "output" }>) {
  const sessionId = handle.sessionId;
  const incoming = msg.cursor;
  const original = b64ToBytes(msg.data);
  let bytes = original;
  const current = handle.logCursor;

  if (current) {
    if (!sameRun(incoming, current)) {
      if (!isLaterRun(incoming, current)) return;
      // A legitimate external restart must not append its cursor space to the
      // old terminal. The next frames belong to a distinct Host run.
      handle.term.reset();
      handle.logCursor = null;
    } else if (incoming.generation < current.generation) {
      return;
    } else if (incoming.generation === current.generation) {
      const end = incoming.offset + original.length;
      if (end <= current.offset) return; // complete replay duplicate
      if (incoming.offset > current.offset && handle.allowRecoveryGap) {
        handle.term.write("\r\n\x1b[2m── 已从恢复事件附近跳回最新输出 ──\x1b[0m\r\n");
        handle.logCursor = { ...incoming, offset: incoming.offset };
        handle.allowRecoveryGap = false;
      } else if (incoming.offset > current.offset) {
        // This should be impossible for v2's catch-up handshake. Recover
        // explicitly instead of joining unrelated terminal bytes together.
        const attachmentId = handle.attachmentId;
        handle.generation += 1;
        handle.pendingRenderedLogCursor = null;
        handle.renderObservationQueued = false;
        handle.attached = false;
        handle.attaching = false;
        handle.attachmentId = null;
        handle.term.reset();
        handle.logCursor = null;
        patchRuntime(sessionId, {
          attached: false,
          detached: true,
          error: "输出流出现间隙，正在重新同步",
        });
        if (attachmentId !== null) {
          void api.detachSession(sessionId, attachmentId).catch(() => undefined);
        }
        void attachHandle(sessionId);
        return;
      }
      if (incoming.offset < current.offset) {
        bytes = original.slice(current.offset - incoming.offset);
      }
    } else {
      handle.term.write("\r\n\x1b[2m── 输出日志已轮转 ──\x1b[0m\r\n");
    }
  }

  if (bytes.length === 0) return;
  const target = handle.recoveryTarget;
  if (
    target
    && sameRun(target, incoming)
    && target.generation === incoming.generation
    && target.offset >= incoming.offset
    && target.offset <= incoming.offset + original.length
  ) {
    const markerAt = Math.max(0, Math.min(bytes.length, target.offset - incoming.offset));
    if (markerAt > 0) writeTerminalOutput(handle, bytes.slice(0, markerAt));
    handle.term.write("\r\n\x1b[2m── 恢复事件定位处 ──\x1b[0m\r\n");
    if (markerAt < bytes.length) writeTerminalOutput(handle, bytes.slice(markerAt));
    handle.recoveryTarget = null;
  } else {
    writeTerminalOutput(handle, bytes);
  }
  handle.logCursor = {
    ...incoming,
    offset: incoming.offset + original.length,
  };
  queueRenderedLogObservation(handle, handle.logCursor);
  updateScrolledUp(handle);
  if (getState().activeSessionId !== sessionId && !unreadOutputPending.has(sessionId)) {
    unreadOutputPending.add(sessionId);
    void api.markSessionOutputUnread(sessionId, msg.offset, incoming).catch(() => {
      unreadOutputPending.delete(sessionId);
    });
  }
}

function onChannelMsg(handle: TermHandle, msg: ChannelMsg) {
  const sessionId = handle.sessionId;
  switch (msg.t) {
    case "output": {
      applyOutputFrame(handle, msg);
      break;
    }
    case "replay_done": {
      if (msg.cursor) {
        handle.logCursor = msg.cursor;
        queueRenderedLogObservation(handle, msg.cursor);
      }
      handle.allowRecoveryGap = msg.partialContext === true;
      finishTerminalStartupFilter(handle);
      patchRuntime(sessionId, { replayDone: true });
      updateScrolledUp(handle);
      break;
    }
    case "resync_required": {
      // The Host has explicitly told us that our cursor no longer maps to
      // retained bytes. Clear before its following tail replay so unrelated
      // generations can never be stitched together in xterm.
      handle.term.reset();
      handle.logCursor = null;
      handle.historyLoaded = false;
      patchRuntime(sessionId, {
        replayDone: false,
        historyNote: `输出已重新同步：${msg.reason}`,
      });
      break;
    }
    case "state": {
      patchRuntime(sessionId, { status: msg.event });
      patchSession(sessionId, { status: msg.event });
      if (getState().settings?.screenReaderMode) {
        const ses = getState()
          .projects.flatMap((p) => p.sessions)
          .find((x) => x.id === sessionId);
        announce(`会话 ${ses?.title ?? sessionId} 状态变为${stateZh(msg.event.state)}`);
      }
      break;
    }
    case "agent_session": {
      patchSession(sessionId, { agentSessionId: msg.id, resumePrecision: "exact" });
      break;
    }
    case "heartbeat": {
      patchRuntime(sessionId, { logBytes: msg.logBytes });
      break;
    }
    case "exit": {
      handle.attached = false;
      handle.attachmentId = null;
      patchRuntime(sessionId, {
        attached: false,
        exit: { code: msg.code, signal: msg.signal, groupCleaned: msg.groupCleaned },
      });
      patchSession(sessionId, { lifecycle: msg.reason === "user_stop" ? "stopped" : "exited" });
      break;
    }
    case "error": {
      patchRuntime(sessionId, { error: msg.message });
      toast(`会话错误：${msg.message}`, "error");
      break;
    }
    case "detached": {
      handle.attached = false;
      handle.attachmentId = null;
      patchRuntime(sessionId, {
        attached: false,
        detached: true,
        error: msg.message ?? null,
      });
      break;
    }
  }
}

/** Write a local separator line (used around restarts). */
export function writeMarker(sessionId: string, text: string) {
  const handle = handles.get(sessionId);
  if (handle) handle.term.write(`\r\n\x1b[2m── ${text} ──\x1b[0m\r\n`);
}

export function resetForRestart(sessionId: string) {
  const handle = handles.get(sessionId);
  if (handle) {
    handle.attached = false;
    handle.attaching = false;
    handle.generation += 1; // drop messages from the pre-restart channel
    handle.pendingRenderedLogCursor = null;
    handle.renderObservationQueued = false;
    // Clear the buffer: the re-attach replays the same log tail and would
    // otherwise duplicate it under the old content / loaded history.
    handle.term.reset();
    handle.logCursor = null;
    handle.allowRecoveryGap = false;
    handle.recoveryTarget = null;
    handle.historyLoaded = false;
    handle.historyLoading = false;
  }
  patchRuntime(sessionId, {
    attached: false,
    detached: false,
    exit: null,
    error: null,
    replayDone: false,
    historyNote: null,
  });
  writeMarker(sessionId, "重启并恢复");
}

/**
 * Open the precise output context selected from a recovery timeline entry.
 * Live Hosts validate and replay a bounded target window; ended Sessions use
 * the same DB generation fence through a read-only backend command.
 */
export async function jumpToRecoveryOutput(
  sessionId: string,
  cursor: LogCursorView,
): Promise<void> {
  const session = getState().projects
    .flatMap((project) => project.sessions)
    .find((item) => item.id === sessionId);
  if (!session) throw new Error("该 Session 已不存在");
  const handle = getOrCreateHandle(sessionId);
  const previousAttachment = handle.attachmentId;
  handle.generation += 1;
  handle.pendingRenderedLogCursor = null;
  handle.renderObservationQueued = false;
  handle.attachmentId = null;
  handle.attached = false;
  handle.attaching = false;
  handle.term.reset();
  handle.logCursor = null;
  handle.allowRecoveryGap = false;
  handle.recoveryTarget = cursor;
  handle.historyLoaded = false;
  handle.historyLoading = false;
  if (previousAttachment !== null) {
    void api.detachSession(sessionId, previousAttachment).catch(() => undefined);
  }
  const ended = session.lifecycle === "exited" || session.lifecycle === "stopped" || session.lifecycle === "interrupted";
  if (ended) {
    const generation = handle.generation;
    try {
      const context = await api.readRecoveryLogContext(sessionId, cursor);
      if (handles.get(sessionId) !== handle || handle.generation !== generation) return;
      const bytes = b64ToBytes(context.data);
      const markerAt = Math.max(0, Math.min(bytes.length, cursor.offset - context.offset));
      if (markerAt > 0) writeTerminalOutput(handle, bytes.slice(0, markerAt));
      handle.term.write("\r\n\x1b[2m── 恢复事件定位处 ──\x1b[0m\r\n");
      if (markerAt < bytes.length) writeTerminalOutput(handle, bytes.slice(markerAt));
      handle.recoveryTarget = null;
      finishTerminalStartupFilter(handle);
      handle.historyLoaded = true;
      handle.logCursor = { ...cursor, offset: context.offset + bytes.length };
      patchRuntime(sessionId, {
        replayDone: true,
        historyNote: `已定位到恢复事件附近输出（${formatBytes(context.total)} 已验证日志）`,
      });
    } catch (error) {
      if (handles.get(sessionId) === handle && handle.generation === generation) {
        patchRuntime(sessionId, {
          replayDone: true,
          historyNote: `无法定位恢复输出：${errorText(error)}`,
        });
      }
      throw error;
    }
  } else {
    await attachHandle(sessionId, cursor);
  }
}

/** Apply font/a11y settings to all live terminals. */
export function applyTerminalSettings() {
  const s = getState();
  if (!s.settings) return;
  const family = cssFontFamily(s.settings.terminalFontFamily);
  for (const h of handles.values()) {
    h.term.options.fontFamily = family;
    h.term.options.fontSize = s.settings.terminalFontSize;
    h.term.options.screenReaderMode = s.settings.screenReaderMode;
    fitHandle(h);
  }
}

export function applyXtermTheme(theme: EffectiveTheme) {
  for (const h of handles.values()) {
    syncHandleTheme(h, theme);
    // xterm updates the option immediately, but an already painted canvas can
    // retain its old fill until the next PTY write. Repaint now so the terminal
    // never leaves a darker rectangle below the unified workspace header.
    h.term.refresh(0, Math.max(0, h.term.rows - 1));
  }
}

export function disposeHandle(sessionId: string) {
  const handle = handles.get(sessionId);
  if (!handle) return;
  handle.generation += 1;
  handle.pendingRenderedLogCursor = null;
  handle.renderObservationQueued = false;
  handle.attachmentId = null;
  inputRepeatDisposers.get(sessionId)?.();
  inputRepeatDisposers.delete(sessionId);
  const resizeTimer = resizeTimers.get(sessionId);
  if (resizeTimer !== undefined) {
    window.clearTimeout(resizeTimer);
    resizeTimers.delete(sessionId);
  }
  handle.resizeObserver?.disconnect();
  try {
    handle.term.dispose();
  } catch {
    // already disposed
  }
  handles.delete(sessionId);
  unreadOutputPending.delete(sessionId);
}

/**
 * Release an inactive terminal's renderer and PTY attachment. The Session and
 * its persisted output are untouched; selecting it later creates a fresh
 * xterm instance and replays the configured history window.
 */
export async function releaseTerminal(sessionId: string): Promise<void> {
  const handle = handles.get(sessionId);
  if (!handle) return;
  // Reject messages already queued on the old Channel before disposing xterm.
  const releaseGeneration = ++handle.generation;
  handle.pendingRenderedLogCursor = null;
  handle.renderObservationQueued = false;
  const attachmentId = handle.attachmentId;
  handle.attachmentId = null;
  handle.attached = false;
  handle.attaching = false;
  if (attachmentId !== null) {
    try {
      await api.detachSession(sessionId, attachmentId);
    } catch {
      // The host may already have exited; local renderer cleanup is still safe.
    }
  }
  // A rapid reselect can have attached the same handle while detach was in
  // flight. Dispose only the object/generation this release actually owned.
  if (handles.get(sessionId) === handle && handle.generation === releaseGeneration) {
    disposeHandle(sessionId);
    patchRuntime(sessionId, { attached: false, attaching: false, detached: true });
  }
}

/** Drop terminals whose session vanished from the project tree. */
export function pruneHandles() {
  const s = getState();
  const alive = new Set(s.projects.flatMap((p) => p.sessions.map((x) => x.id)));
  for (const id of [...handles.keys()]) {
    if (!alive.has(id)) disposeHandle(id);
  }
  setState({ attachedIds: s.attachedIds.filter((id) => alive.has(id)) });
}
