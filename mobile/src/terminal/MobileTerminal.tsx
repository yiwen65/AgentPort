import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { installIosImeRouting, isIosKeyboard } from "./iosIme";
import { selectionMenuPosition } from "./selectionMenu";
import { MOBILE_TERMINAL_THEMES } from "./terminalThemes";
import "./mobile-terminal.css";

export interface MobileTerminalProps {
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  /** Forces a fresh size report after the remote attachment/owner changes. */
  resizeEpoch?: unknown;
  fontSize?: number;
  theme?: ITheme;
  title?: string;
  description?: string;
  showHeading?: boolean;
  showProbeOutput?: boolean;
  /** Hide transient output without unmounting xterm or changing its geometry. */
  obscured?: boolean;
}

export interface MobileTerminalHandle {
  write(data: string | Uint8Array): void;
  reset(): void;
}

function PasteIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v4H9zM5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1" /></svg>;
}

export const MobileTerminal = forwardRef<MobileTerminalHandle, MobileTerminalProps>(function MobileTerminal({
  onInput,
  onResize,
  resizeEpoch,
  fontSize = 14,
  theme = MOBILE_TERMINAL_THEMES.one.dark.xterm,
  title = "Terminal interaction test",
  description = "Local input probe; it does not execute commands.",
  showHeading = true,
  showProbeOutput = true,
  obscured = false,
}: MobileTerminalProps, ref) {
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  const positionSelectionMenuRef = useRef<() => void>(() => undefined);
  const keysRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const resizeFrameRef = useRef<number>();
  const orientationTimerRef = useRef<number>();
  const lastReportedSize = useRef<{ cols: number; rows: number }>();
  const pendingRemoteReport = useRef(false);
  const scheduleFitRef = useRef<(reportRemote?: boolean) => void>(() => undefined);
  const inputHandlerRef = useRef<(data: string) => void>(() => undefined);
  const shiftRef = useRef(false);
  const commandRef = useRef(false);
  const lastTouchShortcutAt = useRef(0);
  const shortcutActionsRef = useRef<Record<string, () => void>>({});
  const [hasSelection, setHasSelection] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [inputActive, setInputActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [commandActive, setCommandActive] = useState(false);
  inputRef.current = onInput;
  resizeRef.current = onResize;

  useImperativeHandle(ref, () => ({
    write(data: string | Uint8Array) {
      terminalRef.current?.write(data);
    },
    reset() {
      const terminal = terminalRef.current;
      if (!terminal) return;
      // Fence the reset behind writes already queued in xterm, while writes
      // received after this call remain behind the reset sentinel.
      terminal.write("", () => terminal.reset());
    },
  }), []);

  const setShift = (active: boolean) => {
    shiftRef.current = active;
    setShiftActive(active);
  };

  const setCommand = (active: boolean) => {
    commandRef.current = active;
    setCommandActive(active);
  };

  const clearModifiers = () => {
    setShift(false);
    setCommand(false);
  };

  const writeInput = (data: string) => {
    const terminal = terminalRef.current;
    if (inputRef.current) inputRef.current(data);
    else terminal?.write(data === "\r" ? "\r\n$ " : data);
  };

  const paste = () => {
    clearModifiers();
    terminalRef.current?.focus();
    setPasteFailed(false);
    if (!navigator.clipboard) { setPasteFailed(true); return; }
    void navigator.clipboard.readText().then(data => { if (data) writeInput(data); }).catch(() => setPasteFailed(true));
  };

  const copySelection = () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) return;
    setCopyFailed(false);
    if (!navigator.clipboard) { setCopyFailed(true); return; }
    void navigator.clipboard.writeText(selection).then(() => terminalRef.current?.clearSelection()).catch(() => setCopyFailed(true));
  };

  inputHandlerRef.current = (data: string) => {
    if (commandRef.current) {
      setCommand(false);
      const command = data.toLocaleLowerCase();
      if (command === "v") paste();
      else if (command === "c") copySelection();
      else if (command === "a") terminalRef.current?.selectAll();
      return;
    }
    let next = data;
    if (shiftRef.current) {
      setShift(false);
      if (data === "\t") next = "\u001b[Z";
      else if (data.length === 1) next = data.toLocaleUpperCase();
    }
    writeInput(next);
  };

  useEffect(() => {
    const container = containerRef.current;
    const section = sectionRef.current;
    if (!container || !section) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 10_000,
      fontSize,
      minimumContrastRatio: 4.5,
      screenReaderMode: false,
      theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    const disposeIosIme = isIosKeyboard() && terminal.textarea
      ? installIosImeRouting(container, terminal.textarea) : undefined;
    let selectionFrame: number | undefined;
    const positionSelectionMenu = () => {
      const menu = selectionMenuRef.current;
      if (!menu || selectionFrame !== undefined) return;
      selectionFrame = window.requestAnimationFrame(() => {
        selectionFrame = undefined;
        const menu = selectionMenuRef.current;
        const screen = container.querySelector(".xterm-screen");
        const selection = terminal.getSelectionPosition();
        if (!menu || !screen) return;
        const position = selection && selectionMenuPosition(selection, terminal.buffer.active.viewportY,
          terminal.cols, terminal.rows, screen.getBoundingClientRect(), section.getBoundingClientRect(), menu.getBoundingClientRect());
        menu.style.visibility = position ? "visible" : "hidden";
        if (position) {
          menu.style.left = `${position.left}px`;
          menu.style.top = `${position.top}px`;
        }
      });
    };
    positionSelectionMenuRef.current = positionSelectionMenu;
    const selectionScrolled = terminal.onScroll(positionSelectionMenu);
    const fitTerminal = (reportRemote: boolean) => {
      fit.fit();
      positionSelectionMenu();
      if (!reportRemote || terminal.cols <= 0 || terminal.rows <= 0) return;
      if (lastReportedSize.current?.cols === terminal.cols && lastReportedSize.current.rows === terminal.rows) return;
      lastReportedSize.current = { cols: terminal.cols, rows: terminal.rows };
      resizeRef.current?.(terminal.cols, terminal.rows);
    };
    const scheduleFit = (reportRemote = false) => {
      pendingRemoteReport.current ||= reportRemote;
      if (resizeFrameRef.current !== undefined) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = undefined;
        const shouldReport = pendingRemoteReport.current;
        pendingRemoteReport.current = false;
        fitTerminal(shouldReport);
      });
    };
    scheduleFitRef.current = scheduleFit;
    fitTerminal(true);
    if (showProbeOutput) {
      terminal.write("\u001b[1;36mAgentPort transport spike\u001b[0m\r\n");
      terminal.write("Touch, select, type with IME, or use the special-key row.\r\n$ ");
    }
    const selectionChanged = terminal.onSelectionChange(() => {
      setHasSelection(Boolean(terminal.getSelection()));
      setCopyFailed(false);
      positionSelectionMenu();
    });
    const input = terminal.onData(data => inputHandlerRef.current(data));
    // Ordinary layout and visual-viewport changes (notably the soft keyboard)
    // fit only the local renderer. They must not steal PTY geometry ownership.
    const resize = new ResizeObserver(() => scheduleFit(false));
    resize.observe(container);
    const viewport = window.visualViewport;
    const workspace = section.closest<HTMLElement>(".session-workspace");
    const viewportChanged = () => {
      workspace?.style.setProperty("--terminal-viewport-height", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
      workspace?.style.setProperty("--terminal-viewport-top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
      const fullWindowHeight = Math.max(window.innerHeight, window.screen.height);
      if (workspace) workspace.dataset.keyboardVisible = String(Boolean(viewport && fullWindowHeight - viewport.height > 80));
      // A TUI positions its input against PTY rows. Report the visible keyboard
      // viewport so the remote agent redraws above the shortcut bar.
      scheduleFit(true);
    };
    viewport?.addEventListener("resize", viewportChanged);
    viewport?.addEventListener("scroll", viewportChanged);
    viewportChanged();
    const focusIn = () => setInputActive(true);
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && section.contains(event.relatedTarget)) return;
      setInputActive(false);
      clearModifiers();
    };
    section.addEventListener("focusin", focusIn);
    section.addEventListener("focusout", focusOut);
    const keys = keysRef.current;
    let touchGesture: { x: number; y: number; lastY: number; moved: boolean; selection?: { start: number; end: number } } | undefined;
    let longPressTimer: number | undefined;
    const cancelLongPress = () => window.clearTimeout(longPressTimer);
    const cellAt = (x: number, y: number) => {
      const rect = container.querySelector(".xterm-screen")?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      return {
        col: Math.max(0, Math.min(terminal.cols - 1, Math.floor((x - rect.left) / rect.width * terminal.cols))),
        row: terminal.buffer.active.viewportY + Math.max(0, Math.min(terminal.rows - 1, Math.floor((y - rect.top) / rect.height * terminal.rows))),
      };
    };
    const beginSelection = () => {
      if (!touchGesture || touchGesture.moved) return;
      const cell = cellAt(touchGesture.x, touchGesture.y);
      if (!cell) return;
      const line = terminal.buffer.active.getLine(cell.row);
      if (!line) return;
      let start = cell.col;
      if (line.getCell(start)?.getWidth() === 0 && start > 0) start--;
      let end = start + Math.max(1, line.getCell(start)?.getWidth() ?? 1);
      const isWord = (col: number) => {
        const cell = line.getCell(col);
        return cell?.getWidth() === 0 || /[^\s]/u.test(cell?.getChars() ?? "");
      };
      if (isWord(start)) {
        while (start > 0 && isWord(start - 1)) start--;
        while (end < terminal.cols && isWord(end)) end++;
      }
      touchGesture.selection = { start: cell.row * terminal.cols + start, end: cell.row * terminal.cols + end };
      gestureStartedInInput = false;
      compatibilityMouseUntil = performance.now() + 1000;
      terminal.textarea?.blur();
      terminal.select(start, cell.row, end - start);
    };
    let compatibilityMouseUntil = 0;
    let gestureStartedInInput: boolean | undefined;
    const tapIsOnCurrentInputRows = (clientY: number) => {
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || terminal.rows <= 0) return false;
      if (terminal.buffer.active.viewportY < terminal.buffer.active.baseY) return false;
      const rect = screen.getBoundingClientRect();
      if (rect.height <= 0) return false;
      const rowHeight = rect.height / terminal.rows;
      const cursorRow = Math.max(0, Math.min(terminal.rows - 1, terminal.buffer.active.cursorY));
      // Agent TUIs commonly reserve one row around the cursor for borders or
      // wrapped input. Keep that compact input band interactive.
      const inputTop = rect.top + Math.max(0, cursorRow - 1) * rowHeight;
      const inputBottom = rect.top + Math.min(terminal.rows, cursorRow + 2) * rowHeight;
      return clientY >= inputTop && clientY <= inputBottom;
    };
    const recordInputGestureAt = (target: Node | null, clientY: number) => {
      gestureStartedInInput = Boolean(target && (
        keys?.contains(target)
        || (container.contains(target) && tapIsOnCurrentInputRows(clientY))
      ));
    };
    const recordPointerGesture = (event: PointerEvent) => {
      recordInputGestureAt(event.target instanceof Node ? event.target : null, event.clientY);
    };
    const recordTouchGesture = (event: TouchEvent) => {
      cancelLongPress();
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (touch) recordInputGestureAt(event.target instanceof Node ? event.target : null, touch.clientY);
      if (event.touches.length === 1 && event.target instanceof Node && container.contains(event.target)) {
        compatibilityMouseUntil = performance.now() + 1000;
        terminal.clearSelection();
        touchGesture = { x: touch.clientX, y: touch.clientY, lastY: touch.clientY, moved: false };
        longPressTimer = window.setTimeout(beginSelection, 500);
      } else touchGesture = undefined;
    };
    const dismissTerminalInput = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || keys?.contains(target)) return;
      if (target instanceof Element && target.closest(".terminal-chrome-reveal")) {
        gestureStartedInInput = undefined;
        return;
      }
      // Use the pre-keyboard geometry captured at pointerdown. WKWebView can
      // resize the visual viewport before emitting the final click.
      const preserveInput = gestureStartedInInput
        ?? (container.contains(target) && tapIsOnCurrentInputRows(event.clientY));
      gestureStartedInInput = undefined;
      if (preserveInput) return;
      const helper = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      if (helper && document.activeElement === helper) helper.blur();
    };
    const guardCompatibilityMouse = (event: MouseEvent) => {
      if (performance.now() >= compatibilityMouseUntil || gestureStartedInInput !== false) return;
      if (!(event.target instanceof Node) || !container.contains(event.target)) return;
      // xterm's mousedown handler focuses its textarea unconditionally. Stop
      // touch-generated mouse events before that handler, not after keyboard UI.
      event.preventDefault();
      event.stopPropagation();
    };
    const scrollTouch = (event: TouchEvent) => {
      if (!touchGesture || event.touches.length !== 1) return;
      const touch = event.touches[0];
      const dx = touch.clientX - touchGesture.x;
      const dy = touch.clientY - touchGesture.y;
      if (touchGesture.selection) {
        event.preventDefault();
        event.stopPropagation();
        const cell = cellAt(touch.clientX, touch.clientY);
        if (cell) {
          const line = terminal.buffer.active.getLine(cell.row);
          const col = line?.getCell(cell.col)?.getWidth() === 0 ? Math.max(0, cell.col - 1) : cell.col;
          const at = cell.row * terminal.cols + col;
          const start = Math.min(touchGesture.selection.start, at);
          const end = Math.max(touchGesture.selection.end, at + Math.max(1, line?.getCell(col)?.getWidth() ?? 1));
          terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), end - start);
        }
        return;
      }
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        touchGesture.moved = true;
        cancelLongPress();
      }
      if (!touchGesture.moved || Math.abs(dy) <= Math.abs(dx)) return;
      const deltaY = touchGesture.lastY - touch.clientY;
      touchGesture.lastY = touch.clientY;
      gestureStartedInInput = false;
      compatibilityMouseUntil = performance.now() + 1000;
      event.preventDefault();
      event.stopPropagation();
      // Unlike xterm's touch path, wheel handles mouse-reporting TUIs and the
      // alternate buffer as well as local scrollback. Preserve that protocol.
      (container.querySelector(".xterm-screen") ?? container).dispatchEvent(new WheelEvent("wheel", {
        deltaY, clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true,
      }));
    };
    const finishTouch = (event: TouchEvent) => {
      cancelLongPress();
      if (!touchGesture) return;
      if (touchGesture.moved || gestureStartedInInput === false) {
        event.preventDefault();
        gestureStartedInInput = false;
        compatibilityMouseUntil = performance.now() + 1000;
        const helper = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (helper && document.activeElement === helper) helper.blur();
      }
      touchGesture = undefined;
    };
    document.addEventListener("mousedown", guardCompatibilityMouse, true);
    container.addEventListener("touchmove", scrollTouch, { capture: true, passive: false });
    container.addEventListener("touchend", finishTouch, { capture: true, passive: false });
    container.addEventListener("touchcancel", finishTouch, { capture: true, passive: false });
    document.addEventListener("pointerdown", recordPointerGesture, true);
    document.addEventListener("touchstart", recordTouchGesture, { capture: true, passive: true });
    document.addEventListener("click", dismissTerminalInput, true);
    const touchShortcut = (event: TouchEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-terminal-shortcut]")
        : null;
      if (!target || !keys?.contains(target)) return;
      // Clipboard access needs WebKit's completed click activation. Unlike the
      // immediate special keys, Paste keeps the browser's native tap lifecycle.
      if (target.dataset.terminalShortcut === "paste") return;
      // React intentionally delegates touchstart as a passive event in WebKit,
      // where preventDefault cannot preserve xterm focus. This native listener
      // is explicitly non-passive so the software keyboard remains connected.
      event.preventDefault();
      lastTouchShortcutAt.current = performance.now();
      shortcutActionsRef.current[target.dataset.terminalShortcut ?? ""]?.();
    };
    keys?.addEventListener("touchstart", touchShortcut, { passive: false });
    const orientationChanged = () => {
      window.clearTimeout(orientationTimerRef.current);
      // Orientation events can arrive before safe-area and visual viewport
      // dimensions settle. The observer handles intermediate layout, while
      // this trailing fit publishes the stable portrait/landscape geometry.
      orientationTimerRef.current = window.setTimeout(() => {
        viewportChanged();
        scheduleFit(true);
      }, 120);
    };
    window.addEventListener("orientationchange", orientationChanged);
    terminalRef.current = terminal;
    fitRef.current = fit;
    return () => {
      terminalRef.current = null;
      fitRef.current = null;
      scheduleFitRef.current = () => undefined;
      pendingRemoteReport.current = false;
      window.clearTimeout(orientationTimerRef.current);
      if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
      document.removeEventListener("mousedown", guardCompatibilityMouse, true);
      container.removeEventListener("touchmove", scrollTouch, true);
      container.removeEventListener("touchend", finishTouch, true);
      container.removeEventListener("touchcancel", finishTouch, true);
      viewport?.removeEventListener("resize", viewportChanged);
      viewport?.removeEventListener("scroll", viewportChanged);
      window.removeEventListener("orientationchange", orientationChanged);
      section.removeEventListener("focusin", focusIn);
      section.removeEventListener("focusout", focusOut);
      document.removeEventListener("pointerdown", recordPointerGesture, true);
      document.removeEventListener("touchstart", recordTouchGesture, true);
      document.removeEventListener("click", dismissTerminalInput, true);
      keys?.removeEventListener("touchstart", touchShortcut);
      workspace?.style.removeProperty("--terminal-viewport-height");
      workspace?.style.removeProperty("--terminal-viewport-top");
      if (workspace) delete workspace.dataset.keyboardVisible;
      resize.disconnect();
      disposeIosIme?.();
      cancelLongPress();
      if (selectionFrame !== undefined) window.cancelAnimationFrame(selectionFrame);
      positionSelectionMenuRef.current = () => undefined;
      selectionScrolled.dispose();
      selectionChanged.dispose();
      input.dispose();
      terminal.dispose();
    };
  }, []); // The terminal is a long-lived renderer; callback refs carry changing handlers.

  useLayoutEffect(() => {
    const menu = selectionMenuRef.current;
    if (!menu) return;
    positionSelectionMenuRef.current();
    const resize = new ResizeObserver(() => positionSelectionMenuRef.current());
    resize.observe(menu);
    return () => resize.disconnect();
  }, [hasSelection, obscured]);

  useLayoutEffect(() => {
    // The shortcut row changes available terminal height after focus state is
    // committed. Refit in that committed layout and publish the new PTY rows.
    lastReportedSize.current = undefined;
    scheduleFitRef.current(true);
  }, [inputActive]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    lastReportedSize.current = undefined;
    scheduleFitRef.current(true);
  }, [fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    lastReportedSize.current = undefined;
    scheduleFitRef.current(true);
  }, [resizeEpoch]);

  const send = (data: string) => {
    terminalRef.current?.focus();
    inputHandlerRef.current(data);
  };

  shortcutActionsRef.current = {
    paste,
    escape: () => send("\u001b"),
    tab: () => send("\t"),
    shift: () => { terminalRef.current?.focus(); setShift(!shiftRef.current); },
    slash: () => send("/"),
    at: () => send("@"),
    command: () => { terminalRef.current?.focus(); setCommand(!commandRef.current); },
  };

  const shortcutHandlers = (shortcut: string, action: () => void) => ({
    "data-terminal-shortcut": shortcut,
    onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      // Some WebKit versions still emit a compatibility mouse event after a
      // cancelled touch. Do not send the shortcut a second time.
      if (performance.now() - lastTouchShortcutAt.current < 750) return;
      action();
    },
    // Keyboard and assistive activations do not have a preceding pointer event.
    onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0) action();
    },
  });

  return (
    <section ref={sectionRef} className="mobile-terminal-spike" data-input-active={inputActive} aria-label={title} aria-hidden={obscured || undefined} style={{ visibility: obscured ? "hidden" : undefined }}>
      {showHeading ? <div className="mobile-terminal-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}
      <div ref={containerRef} className="mobile-terminal-surface" role="application" aria-label={title} />
      {hasSelection && !obscured ? <div ref={selectionMenuRef} className="mobile-terminal-selection" role="group" aria-label="Text selection">
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={copySelection}>Copy</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => terminalRef.current?.clearSelection()}>Clear</button>
        {copyFailed ? <span role="alert">Unable to copy. Try again.</span> : null}
      </div> : null}
      {pasteFailed && inputActive && !obscured ? <p className="mobile-terminal-paste-error" role="alert">Unable to paste. Check clipboard access and try again.</p> : null}
      <div ref={keysRef} className="mobile-terminal-keys" data-horizontal-scroll aria-label="Terminal special keys" hidden={!inputActive}>
        <button type="button" aria-label="Paste" data-terminal-shortcut="paste" onMouseDown={event => event.preventDefault()} onClick={paste}><PasteIcon /></button>
        <button type="button" aria-label="Escape" {...shortcutHandlers("escape", shortcutActionsRef.current.escape)}><span aria-hidden="true">⎋</span></button>
        <button type="button" aria-label="Tab" {...shortcutHandlers("tab", shortcutActionsRef.current.tab)}><span aria-hidden="true">⇥</span></button>
        <button className={shiftActive ? "is-active" : ""} type="button" aria-label="Shift" aria-pressed={shiftActive} {...shortcutHandlers("shift", shortcutActionsRef.current.shift)}><span aria-hidden="true">⇧</span></button>
        <button type="button" aria-label="Slash" {...shortcutHandlers("slash", shortcutActionsRef.current.slash)}><span aria-hidden="true">/</span></button>
        <button type="button" aria-label="At sign" {...shortcutHandlers("at", shortcutActionsRef.current.at)}><span aria-hidden="true">@</span></button>
        <button className={commandActive ? "is-active" : ""} type="button" aria-label="Command" aria-pressed={commandActive} {...shortcutHandlers("command", shortcutActionsRef.current.command)}><span aria-hidden="true">⌘</span></button>
      </div>
    </section>
  );
});
