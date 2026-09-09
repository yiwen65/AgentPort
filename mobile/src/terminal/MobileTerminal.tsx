import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalParserTail, type TerminalScreen } from "./terminalCheckpoint";
import { captureSnapshotState, restoreSnapshotState } from "./terminalSnapshot";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { installIosImeRouting, isIosKeyboard } from "./iosIme";
import { readClipboardText } from "../platform/clipboard";
import { selectionMenuPosition } from "./selectionMenu";
import { ShortcutIcon, SHORTCUT_NAMES, ShortcutSettingsIcon } from "./ShortcutIcon";
import { ShortcutSettings } from "./ShortcutSettings";
import { applyShortcutModifiers, encodeShortcutKey, isCustomShortcut, loadShortcuts, saveShortcuts, type ShortcutLayout } from "./shortcuts";
import { MOBILE_TERMINAL_THEMES } from "./terminalThemes";
import "./mobile-terminal.css";

export interface MobileTerminalProps {
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRelease?: (terminal: MobileTerminalHandle) => void;
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
  recovering?: boolean;
  recoveryLabel?: string;
}

export interface MobileTerminalHandle {
  /** Callback runs after xterm parses this write and all earlier queued writes. */
  write(data: string | Uint8Array, onParsed?: () => void): void;
  reset(): void;
  capture(): Promise<TerminalScreen | undefined>;
  restore(screen: TerminalScreen): Promise<void>;
  finishRestore(onRendered?: () => void): void;
}

export const MobileTerminal = forwardRef<MobileTerminalHandle, MobileTerminalProps>(function MobileTerminal({
  onInput,
  onResize,
  onRelease,
  resizeEpoch,
  fontSize = 14,
  theme = MOBILE_TERMINAL_THEMES.one.dark.xterm,
  title = "Terminal interaction test",
  description = "Local input probe; it does not execute commands.",
  showHeading = true,
  showProbeOutput = true,
  obscured = false,
  recovering = false,
  recoveryLabel,
}: MobileTerminalProps, ref) {
  const { t } = useTranslation();
  const [shortcutLayout, setShortcutLayout] = useState(loadShortcuts);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectionMenuRef = useRef<HTMLDivElement>(null);
  const positionSelectionMenuRef = useRef<() => void>(() => undefined);
  const keysRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon>();
  const parserTail = useRef(new TerminalParserTail());
  const restoring = useRef(false);
  const mouseEncoding = useRef(0);
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;
  const handleRef = useRef<MobileTerminalHandle>();
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const resizeFrameRef = useRef<number>();
  const orientationTimerRef = useRef<number>();
  const lastReportedSize = useRef<{ cols: number; rows: number }>();
  const pendingRemoteReport = useRef(false);
  const scheduleFitRef = useRef<(reportRemote?: boolean) => void>(() => undefined);
  const cancelRestoreRender = useRef<(() => void) | undefined>(undefined);
  const inputHandlerRef = useRef<(data: string) => void>(() => undefined);
  const invalidateIosImeRef = useRef<() => void>(() => undefined);
  const iosEmissionRef = useRef(false);
  const shiftRef = useRef(false);
  const controlRef = useRef(false);
  const commandRef = useRef(false);
  const shortcutActionsRef = useRef<Record<string, () => void>>({});
  const [hasSelection, setHasSelection] = useState(false);
  const [pasteFailed, setPasteFailed] = useState(false);
  const pasteGeneration = useRef(0);
  const pastePending = useRef(false);
  const cancelPendingPaste = () => { pasteGeneration.current += 1; pastePending.current = false; };
  const [copyFailed, setCopyFailed] = useState(false);
  const [inputActive, setInputActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [controlActive, setControlActive] = useState(false);
  const [commandActive, setCommandActive] = useState(false);
  inputRef.current = onInput;
  resizeRef.current = onResize;

  useImperativeHandle(ref, () => {
    const handle: MobileTerminalHandle = {
    write(data: string | Uint8Array, onParsed?: () => void) {
      parserTail.current.advance(data);
      terminalRef.current?.write(data, onParsed);
    },
    capture() {
      const terminal = terminalRef.current;
      const serialize = serializeRef.current;
      if (!terminal || !serialize) return Promise.resolve(undefined);
      const pending = parserTail.current.snapshot();
      return new Promise(resolve => terminal.write("", () => {
        if (!pending) { resolve(undefined); return; }
        try {
          const encoding = mouseEncoding.current ? `\x1b[?${mouseEncoding.current}h` : "";
          resolve({ content: serialize.serialize({ scrollback: 2_000 }) + encoding,
            cols: terminal.cols, rows: terminal.rows, pending, state: captureSnapshotState(terminal) });
        } catch { resolve(undefined); }
      }));
    },
    restore(screen) {
      const terminal = terminalRef.current;
      if (!terminal) return Promise.resolve();
      restoring.current = true;
      parserTail.current.reset();
      parserTail.current.advance(new Uint8Array(screen.pending));
      return new Promise((resolve, reject) => {
        // Drain older writes before replacing the screen. The caller fences
        // incremental delivery until both state and parser prefix are restored.
        terminal.write("", () => {
          terminal.reset();
          terminal.resize(screen.cols, screen.rows);
        });
        // Enqueue the entire transaction now. Nested write callbacks would let
        // a newer restore/reset overtake this snapshot's parser prefix.
        terminal.write(screen.content, () => {
          try { if (screen.state) restoreSnapshotState(terminal, screen.state); }
          catch (error) { reject(error); }
        });
        terminal.write(new Uint8Array(screen.pending), resolve);
      });
    },
    finishRestore(onRendered) {
      restoring.current = false;
      lastReportedSize.current = undefined;
      cancelRestoreRender.current?.();
      scheduleFitRef.current(true);
      const terminal = terminalRef.current;
      if (terminal && onRendered) {
        const subscription = terminal.onRender(() => {
          subscription.dispose();
          cancelRestoreRender.current = undefined;
          onRendered();
        });
        cancelRestoreRender.current = () => subscription.dispose();
        // An empty replay may otherwise never paint. Register after the parser
        // barrier and request an actual render, not a timer-based reveal.
        terminal.refresh(0, terminal.rows - 1);
      }
    },
    reset() {
      cancelPendingPaste();
      invalidateIosImeRef.current();
      const terminal = terminalRef.current;
      if (!terminal) return;
      // Fence the reset behind writes already queued in xterm, while writes
      // received after this call remain behind the reset sentinel.
      parserTail.current.reset();
      restoring.current = false;
      terminal.write("", () => { mouseEncoding.current = 0; terminal.reset(); });
    },
    };
    handleRef.current = handle;
    return handle;
  }, []);

  const setShift = (active: boolean) => {
    shiftRef.current = active;
    setShiftActive(active);
  };

  const setControl = (active: boolean) => {
    controlRef.current = active;
    setControlActive(active);
  };

  const setCommand = (active: boolean) => {
    commandRef.current = active;
    setCommandActive(active);
  };

  const clearModifiers = () => {
    setShift(false);
    setControl(false);
    setCommand(false);
  };

  const writeInput = (data: string) => {
    // Toolbar navigation/paste bypass DOM key events and end the owned suffix.
    if (!iosEmissionRef.current) invalidateIosImeRef.current();
    const terminal = terminalRef.current;
    if (inputRef.current) inputRef.current(data);
    else terminal?.write(data === "\r" ? "\r\n$ " : data);
  };

  const paste = () => {
    const terminal = terminalRef.current;
    if (!terminal || obscured || pastePending.current) return;
    clearModifiers();
    terminal.focus();
    setPasteFailed(false);
    pastePending.current = true;
    const generation = ++pasteGeneration.current;
    void readClipboardText().then(data => {
      if (generation !== pasteGeneration.current || terminalRef.current !== terminal || !data) return;
      invalidateIosImeRef.current();
      // Authorization can take time; modifiers toggled while waiting must
      // not turn literal clipboard text into Ctrl-C or another command.
      clearModifiers();
      // Let xterm normalize newlines and honor the application's bracketed
      // paste mode, rather than treating pasted text as raw keystrokes.
      terminal.paste(data);
    }).catch(() => {
      if (generation === pasteGeneration.current) setPasteFailed(true);
    }).finally(() => {
      if (generation === pasteGeneration.current) pastePending.current = false;
    });
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
      invalidateIosImeRef.current();
      clearModifiers();
      const command = data.toLocaleLowerCase();
      if (command === "v") paste();
      else if (command === "c") copySelection();
      else if (command === "a") terminalRef.current?.selectAll();
      return;
    }
    const next = applyShortcutModifiers(data, { ctrl: controlRef.current, shift: shiftRef.current });
    if (next !== data) invalidateIosImeRef.current();
    if (shiftRef.current) setShift(false);
    if (controlRef.current) setControl(false);
    writeInput(next);
  };

  useEffect(() => {
    const container = containerRef.current;
    const section = sectionRef.current;
    if (!container || !section) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      // Match the larger mobile attach replay tail. Long agent logs can easily
      // exceed 10k wrapped rows on a phone-sized PTY; keep them scrollable.
      scrollback: 2_000,
      fontSize,
      minimumContrastRatio: 4.5,
      screenReaderMode: false,
      theme,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const serialize = new SerializeAddon();
    terminal.loadAddon(serialize);
    serializeRef.current = serialize;
    const encodingHandlers = [
      terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => {
        for (const mode of params) if (mode === 1006 || mode === 1016) mouseEncoding.current = mode;
        return false;
      }),
      terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
        if (params.includes(1006) || params.includes(1016)) mouseEncoding.current = 0;
        return false;
      }),
      terminal.parser.registerEscHandler({ final: "c" }, () => { mouseEncoding.current = 0; return false; }),
    ];
    terminal.open(container);
    const disposeIosIme = isIosKeyboard() && terminal.textarea
      ? installIosImeRouting(container, terminal.textarea, text => {
        iosEmissionRef.current = true;
        try { terminal.input(text, true); } finally { iosEmissionRef.current = false; }
      }) : undefined;
    invalidateIosImeRef.current = disposeIosIme?.invalidate ?? (() => undefined);
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
    const selectionScrolled = terminal.onScroll(() => positionSelectionMenu());
    const fitTerminal = (reportRemote: boolean) => {
      if (restoring.current) return;
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
    // Report actual content-box changes too (shortcut bar/status overlays).
    // SessionWorkspace gates remote writes on current geometry ownership.
    const resize = new ResizeObserver(() => scheduleFit(true));
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
    const forwardedMouseEvents = new WeakSet<Event>();
    let scrollWheelFrame: number | undefined;
    let pendingWheel: { deltaY: number; clientX: number; clientY: number } | undefined;
    const terminalRowHeight = () => {
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const rect = screen?.getBoundingClientRect();
      return rect && terminal.rows > 0 && rect.height > 0 ? rect.height / terminal.rows : 16;
    };
    const flushScrollWheel = () => {
      scrollWheelFrame = undefined;
      const next = pendingWheel;
      pendingWheel = undefined;
      if (!next) return;
      if (terminal.modes.mouseTrackingMode === "none" && terminal.buffer.active.type === "normal") {
        const rows = Math.sign(next.deltaY) * Math.max(1, Math.round(Math.abs(next.deltaY) / terminalRowHeight() * 3.5));
        terminal.scrollLines(rows);
        return;
      }
      // Mouse-reporting TUIs and the alternate buffer need xterm's wheel
      // protocol encoder. Normal log scrollback uses scrollLines above because
      // WebKit's synthetic wheel path is too damped for finger scrolling.
      (container.querySelector(".xterm-screen") ?? container).dispatchEvent(new WheelEvent("wheel", {
        deltaY: next.deltaY * 2.5,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: next.clientX,
        clientY: next.clientY,
        bubbles: true,
        cancelable: true,
      }));
    };
    const queueScrollWheel = (deltaY: number, clientX: number, clientY: number) => {
      if (pendingWheel) {
        pendingWheel.deltaY += deltaY;
        pendingWheel.clientX = clientX;
        pendingWheel.clientY = clientY;
      } else pendingWheel = { deltaY, clientX, clientY };
      if (scrollWheelFrame === undefined) scrollWheelFrame = window.requestAnimationFrame(flushScrollWheel);
    };
    const guardCompatibilityMouse = (event: MouseEvent) => {
      if (forwardedMouseEvents.has(event)) return;
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
      queueScrollWheel(deltaY, touch.clientX, touch.clientY);
    };
    const finishTouch = (event: TouchEvent) => {
      cancelLongPress();
      if (!touchGesture) return;
      // Forward completed taps through xterm's own mouse protocol encoder. Do
      // not forward drags/long presses or cancelled touches as application clicks.
      if (event.type === "touchend" && !touchGesture.moved && !touchGesture.selection
        && terminal.modes.mouseTrackingMode !== "none") {
        const touch = event.changedTouches[0];
        const screen = container.querySelector(".xterm-screen");
        const helper = terminal.textarea;
        if (touch && screen && helper) {
          event.preventDefault();
          event.stopPropagation();
          compatibilityMouseUntil = performance.now() + 1000;
          const reading = gestureStartedInInput === false;
          const wasInert = helper.hasAttribute("inert");
          // xterm unconditionally focuses its textarea on mousedown. Inert only
          // that helper during synchronous forwarding to keep log taps from
          // opening the software keyboard; never disable the terminal itself.
          if (reading) { helper.blur(); helper.setAttribute("inert", ""); }
          try {
            for (const type of ["mousedown", "mouseup"]) {
              const mouse = new MouseEvent(type, {
                clientX: touch.clientX, clientY: touch.clientY,
                button: 0, buttons: type === "mousedown" ? 1 : 0,
                bubbles: true, cancelable: true,
              });
              forwardedMouseEvents.add(mouse);
              screen.dispatchEvent(mouse);
            }
          } finally {
            if (reading && !wasInert) helper.removeAttribute("inert");
          }
        }
      }
      if (scrollWheelFrame !== undefined) {
        window.cancelAnimationFrame(scrollWheelFrame);
        flushScrollWheel();
      }
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
      cancelPendingPaste();
      fitRef.current = null;
      scheduleFitRef.current = () => undefined;
      cancelRestoreRender.current?.();
      cancelRestoreRender.current = undefined;
      pendingRemoteReport.current = false;
      window.clearTimeout(orientationTimerRef.current);
      if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
      if (scrollWheelFrame !== undefined) window.cancelAnimationFrame(scrollWheelFrame);
      scrollWheelFrame = undefined;
      pendingWheel = undefined;
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
      workspace?.style.removeProperty("--terminal-viewport-height");
      workspace?.style.removeProperty("--terminal-viewport-top");
      if (workspace) delete workspace.dataset.keyboardVisible;
      resize.disconnect();
      disposeIosIme?.();
      invalidateIosImeRef.current = () => undefined;
      cancelLongPress();
      if (selectionFrame !== undefined) window.cancelAnimationFrame(selectionFrame);
      positionSelectionMenuRef.current = () => undefined;
      selectionScrolled.dispose();
      selectionChanged.dispose();
      input.dispose();
      // The Workspace fences delivery and queues its final output before capture.
      // Keep only this detached renderer until that parser fence drains.
      if (releaseRef.current && handleRef.current) {
        releaseRef.current(handleRef.current);
        terminal.write("", () => {
          encodingHandlers.forEach(handler => handler.dispose());
          terminal.dispose();
        });
      } else {
        encodingHandlers.forEach(handler => handler.dispose());
        terminal.dispose();
      }
      terminalRef.current = null;
    };
  }, []); // The terminal is a long-lived renderer; callback refs carry changing handlers.

  useLayoutEffect(() => {
    if (obscured) cancelPendingPaste();
  }, [obscured]);

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

  const sendCursorKey = (key: string) => send(encodeShortcutKey(key, {}, terminalRef.current?.modes.applicationCursorKeysMode ?? false));
  shortcutActionsRef.current = {
    paste,
    escape: () => send("\u001b"),
    tab: () => send("\t"),
    control: () => { terminalRef.current?.focus(); setCommand(false); setControl(!controlRef.current); },
    shift: () => { terminalRef.current?.focus(); setCommand(false); setShift(!shiftRef.current); },
    slash: () => send("/"),
    at: () => send("@"),
    up: () => sendCursorKey("ArrowUp"),
    down: () => sendCursorKey("ArrowDown"),
    left: () => sendCursorKey("ArrowLeft"),
    right: () => sendCursorKey("ArrowRight"),
    command: () => { terminalRef.current?.focus(); setControl(false); setShift(false); setCommand(!commandRef.current); },
  };
  for (const item of shortcutLayout.items) {
    if (!isCustomShortcut(item)) continue;
    shortcutActionsRef.current[item.id] = () => {
      clearModifiers();
      terminalRef.current?.focus();
      writeInput(item.action.type === "text" ? item.action.text
        : encodeShortcutKey(item.action.key, item.action, terminalRef.current?.modes.applicationCursorKeysMode ?? false));
    };
  }
  const saveShortcutLayout = (next: ShortcutLayout) => {
    saveShortcuts(next);
    setShortcutLayout(next);
    clearModifiers();
  };

  const shortcutHandlers = (shortcut: string, action: () => void) => ({
    "data-terminal-shortcut": shortcut,
    onMouseDown: (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
    },
    // A native click distinguishes a tap from a horizontal swipe, and carries
    // WebKit clipboard activation. Never send a key merely on touchstart.
    onClick: action,
  });

  return (
    <section ref={sectionRef} className="mobile-terminal-spike" data-input-active={inputActive} aria-label={title} aria-hidden={obscured || undefined} style={{ visibility: obscured ? "hidden" : undefined }}>
      {showHeading ? <div className="mobile-terminal-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}
      <div ref={containerRef} className="mobile-terminal-surface" role="application" aria-label={title}
        aria-busy={recovering || undefined} data-recovering={recovering || undefined}
        data-recovery-label={recovering ? (recoveryLabel ?? t("session.connection.attaching")) : undefined} />
      {hasSelection && !obscured ? <div ref={selectionMenuRef} className="mobile-terminal-selection" role="group" aria-label="Text selection">
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={copySelection}>Copy</button>
        <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => terminalRef.current?.clearSelection()}>Clear</button>
        {copyFailed ? <span role="alert">Unable to copy. Try again.</span> : null}
      </div> : null}
      {pasteFailed && inputActive && !obscured ? <p className="mobile-terminal-paste-error" role="alert">Unable to paste. Check clipboard access and try again.</p> : null}
      <div ref={keysRef} className="mobile-terminal-keys" data-horizontal-scroll aria-label="Terminal special keys" hidden={!inputActive}>
        <div className="mobile-terminal-key-scroll" data-horizontal-scroll>
          {shortcutLayout.items.filter(item => item.visible).map(item => {
            const pressed = item.id === "control" ? controlActive : item.id === "shift" ? shiftActive : item.id === "command" ? commandActive : undefined;
            const label = isCustomShortcut(item) ? item.label : t(`shortcuts.names.${item.id}`, { defaultValue: SHORTCUT_NAMES[item.id] });
            return <button key={item.id} className={pressed ? "is-active" : ""} type="button" aria-label={label} title={label} aria-pressed={pressed} {...shortcutHandlers(item.id, shortcutActionsRef.current[item.id])}><ShortcutIcon item={item} /></button>;
          })}
          <button className="mobile-terminal-shortcut-settings" type="button" aria-label={t("shortcuts.title", { defaultValue: "Terminal shortcuts" })} aria-haspopup="dialog" onMouseDown={event => event.preventDefault()} onClick={() => { clearModifiers(); setShortcutsOpen(true); }}><ShortcutSettingsIcon /></button>
        </div>
      </div>
      {shortcutsOpen ? <ShortcutSettings layout={shortcutLayout} onSave={saveShortcutLayout} onClose={() => setShortcutsOpen(false)} /> : null}
    </section>
  );
});
