// xterm.js instance manager. Each attached session owns one persistent
// Terminal; switching sessions only toggles pane visibility (PRD ch.2/3.3).
// All PTY I/O flows through the backend: input is base64 via send_input,
// output arrives on the attach Channel.

import { Terminal, type IBuffer, type ITheme } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Channel } from "@tauri-apps/api/core";
import { api, b64ToBytes, errorText, strToB64 } from "./api";
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
import type { ChannelMsg } from "./types";

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
  canvas: CanvasAddon | null;
  opened: boolean;
  attached: boolean;
  attaching: boolean;
  /** Bumped per attach — stale channels from previous attaches are ignored. */
  generation: number;
  /** Log tail already rendered (ended sessions' read-only history). */
  historyLoaded: boolean;
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
    canvas: null,
    opened: false,
    attached: false,
    attaching: false,
    generation: 0,
    historyLoaded: false,
    container: null,
    resizeObserver: null,
    lastCols: 0,
    lastRows: 0,
    lastScrolledUp: false,
    firstInputBuffer: "",
    firstInputSubmitted: false,
    inputEscapeSequence: false,
    inputEscapeCsi: false,
  };
  term.onData((data) => {
    // Input is only writable once attached — writers register at attach time.
    if (!handle.attached) return;
    const firstInput = captureFirstSubmittedInput(handle, data);
    api.sendInput(sessionId, strToB64(data))
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

function updateScrolledUp(handle: TermHandle) {
  const buf = handle.term.buffer.active;
  const up = buf.viewportY < buf.baseY;
  if (up !== handle.lastScrolledUp) {
    handle.lastScrolledUp = up;
    patchRuntime(handle.sessionId, { scrolledUp: up });
  }
}

/** Mount (once) into a pane container div; starts the attach if needed. */
export function mountTerminal(sessionId: string, container: HTMLDivElement) {
  const handle = getOrCreateHandle(sessionId);
  handle.container = container;
  if (!handle.opened) {
    handle.opened = true;
    handle.term.open(container);
    try {
      // xterm's DOM renderer generates per-terminal stylesheets at runtime.
      // WKWebView can reject those rules under CSP, leaving the terminal with
      // its prepaint foreground (white) on the Light theme. The Canvas addon
      // owns both glyph and background painting and avoids that failure mode,
      // while remaining stable across macOS appearance changes (unlike WebGL).
      handle.canvas = new CanvasAddon();
      handle.term.loadAddon(handle.canvas);
      setState({ rendererMode: "canvas", rendererFallbackReason: null });
    } catch (error) {
      handle.canvas = null;
      setState({
        rendererMode: "dom",
        rendererFallbackReason: `Canvas renderer unavailable: ${errorText(error)}`,
      });
    }
    syncHandleTheme(handle);
    handle.resizeObserver = new ResizeObserver(() => fitHandle(handle));
    handle.resizeObserver.observe(container);
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
  if (handle.historyLoaded) return;
  handle.historyLoaded = true;
  try {
    const res = await api.readLogTail(sessionId, HISTORY_TAIL_BYTES);
    if (res.data) {
      handle.term.write(b64ToBytes(res.data), () => updateScrolledUp(handle));
      if (res.offset > 0) {
        patchRuntime(sessionId, {
          historyNote: `仅显示最后 ${formatBytes(res.total - res.offset)}（日志共 ${formatBytes(res.total)}）`,
        });
      }
    }
    patchRuntime(sessionId, { replayDone: true });
  } catch (e) {
    patchRuntime(sessionId, { replayDone: true, historyNote: `日志读取失败：${errorText(e)}` });
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
    resizeTimers.set(
      handle.sessionId,
      window.setTimeout(() => {
        resizeTimers.delete(handle.sessionId);
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
export async function attachHandle(sessionId: string): Promise<void> {
  const handle = getOrCreateHandle(sessionId);
  if (handle.attached || handle.attaching) return;
  handle.attaching = true;
  const generation = ++handle.generation;
  patchRuntime(sessionId, { attaching: true, error: null, detached: false });
  const channel = new Channel<ChannelMsg>();
  channel.onmessage = (msg) => {
    if (generation !== handle.generation) return; // stale channel
    onChannelMsg(handle, msg);
  };
  try {
    const info = await api.attachSession(sessionId, REPLAY_TAIL_BYTES, channel);
    if (generation !== handle.generation) return;
    handle.attached = true;
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
    if (info.agentSessionId) {
      patchSession(sessionId, { agentSessionId: info.agentSessionId });
    }
    // PTY size may have changed while detached. Force the first resize even
    // if the browser measured the same dimensions before attach completed.
    fitHandle(handle, true, true);
  } catch (e) {
    if (generation !== handle.generation) return;
    patchRuntime(sessionId, {
      attaching: false,
      attached: false,
      detached: true,
      error: errorText(e),
    });
  } finally {
    if (generation === handle.generation) handle.attaching = false;
  }
}

function onChannelMsg(handle: TermHandle, msg: ChannelMsg) {
  const sessionId = handle.sessionId;
  switch (msg.t) {
    case "output": {
      handle.term.write(b64ToBytes(msg.data));
      updateScrolledUp(handle);
      if (getState().activeSessionId !== sessionId && !unreadOutputPending.has(sessionId)) {
        unreadOutputPending.add(sessionId);
        void api.markSessionOutputUnread(sessionId, msg.offset).catch(() => {
          unreadOutputPending.delete(sessionId);
        });
      }
      break;
    }
    case "replay_done": {
      patchRuntime(sessionId, { replayDone: true });
      updateScrolledUp(handle);
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
      patchRuntime(sessionId, {
        attached: false,
        exit: { code: msg.code, signal: msg.signal, groupCleaned: msg.groupCleaned },
      });
      patchSession(sessionId, { lifecycle: "exited" });
      break;
    }
    case "error": {
      patchRuntime(sessionId, { error: msg.message });
      toast(`会话错误：${msg.message}`, "error");
      break;
    }
    case "detached": {
      handle.attached = false;
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
    // Clear the buffer: the re-attach replays the same log tail and would
    // otherwise duplicate it under the old content / loaded history.
    handle.term.reset();
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
  handle.generation += 1;
  handle.attached = false;
  handle.attaching = false;
  try {
    await api.detachSession(sessionId);
  } catch {
    // The host may already have exited; local renderer cleanup is still safe.
  }
  disposeHandle(sessionId);
  patchRuntime(sessionId, { attached: false, attaching: false, detached: true });
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
