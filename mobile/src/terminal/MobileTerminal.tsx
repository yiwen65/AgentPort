import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./mobile-terminal.css";

export interface MobileTerminalProps {
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  outputChunks?: string[];
  resetVersion?: number;
  /** Forces a fresh size report after the remote attachment/owner changes. */
  resizeEpoch?: unknown;
  fontSize?: number;
  title?: string;
  description?: string;
  showHeading?: boolean;
}

function PasteIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="7" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v4H9zM5 17H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1" /></svg>;
}

export function MobileTerminal({
  onInput,
  onResize,
  outputChunks,
  resetVersion = 0,
  resizeEpoch,
  fontSize = 14,
  title = "Terminal interaction test",
  description = "Local input probe; it does not execute commands.",
  showHeading = true,
}: MobileTerminalProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const consumedChunks = useRef(0);
  const lastReset = useRef(resetVersion);
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
  const [inputActive, setInputActive] = useState(false);
  const [shiftActive, setShiftActive] = useState(false);
  const [commandActive, setCommandActive] = useState(false);
  inputRef.current = onInput;
  resizeRef.current = onResize;

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
    void navigator.clipboard?.readText().then(writeInput).catch(() => undefined);
  };

  const copySelection = () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (selection) void navigator.clipboard?.writeText(selection).catch(() => undefined);
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
      screenReaderMode: true,
      theme: {
        background: "#18181e",
        foreground: "#d8d8de",
        cursor: "#f4f4f7",
        cursorAccent: "#18181e",
        selectionBackground: "#4f5f9a80",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    const fitTerminal = (reportRemote: boolean) => {
      fit.fit();
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
    if (!outputChunks) {
      terminal.write("\u001b[1;36mAgentPort transport spike\u001b[0m\r\n");
      terminal.write("Touch, select, type with IME, or use the special-key row.\r\n$ ");
    }
    const input = terminal.onData((data) => {
      inputHandlerRef.current(data);
    });
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
    let dismissFrame: number | undefined;
    let gestureStartedInInput: boolean | undefined;
    const tapIsOnCurrentInputRows = (clientY: number) => {
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || terminal.rows <= 0) return false;
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
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (touch) recordInputGestureAt(event.target instanceof Node ? event.target : null, touch.clientY);
    };
    const dismissTerminalInput = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || keys?.contains(target)) return;
      // Use the pre-keyboard geometry captured at pointerdown. WKWebView can
      // resize the visual viewport before emitting the final click.
      const preserveInput = gestureStartedInInput
        ?? (container.contains(target) && tapIsOnCurrentInputRows(event.clientY));
      gestureStartedInInput = undefined;
      if (preserveInput) return;
      if (dismissFrame !== undefined) window.cancelAnimationFrame(dismissFrame);
      // xterm may focus its helper textarea during the target phase. Blur on
      // the following frame so a completed tap outside the input rows wins.
      dismissFrame = window.requestAnimationFrame(() => {
        dismissFrame = undefined;
        const helper = container.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
        if (helper && document.activeElement === helper) helper.blur();
      });
    };
    document.addEventListener("pointerdown", recordPointerGesture, true);
    document.addEventListener("touchstart", recordTouchGesture, { capture: true, passive: true });
    document.addEventListener("click", dismissTerminalInput, true);
    const touchShortcut = (event: TouchEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("button[data-terminal-shortcut]")
        : null;
      if (!target || !keys?.contains(target)) return;
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
      consumedChunks.current = 0;
      window.clearTimeout(orientationTimerRef.current);
      if (resizeFrameRef.current !== undefined) window.cancelAnimationFrame(resizeFrameRef.current);
      if (dismissFrame !== undefined) window.cancelAnimationFrame(dismissFrame);
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
      input.dispose();
      terminal.dispose();
    };
  }, []); // The terminal is a long-lived renderer; callback refs carry changing handlers.

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
    lastReportedSize.current = undefined;
    scheduleFitRef.current(true);
  }, [resizeEpoch]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !outputChunks) return;
    if (lastReset.current !== resetVersion || outputChunks.length < consumedChunks.current) {
      terminal.reset();
      consumedChunks.current = 0;
      lastReset.current = resetVersion;
    }
    for (const chunk of outputChunks.slice(consumedChunks.current)) terminal.write(chunk);
    consumedChunks.current = outputChunks.length;
  }, [outputChunks, resetVersion]);

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
    <section ref={sectionRef} className="mobile-terminal-spike" data-input-active={inputActive} aria-label={title}>
      {showHeading ? <div className="mobile-terminal-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}
      <div ref={containerRef} className="mobile-terminal-surface" role="application" aria-label={title} />
      <div ref={keysRef} className="mobile-terminal-keys" data-horizontal-scroll aria-label="Terminal special keys" hidden={!inputActive}>
        <button type="button" aria-label="Paste" {...shortcutHandlers("paste", paste)}><PasteIcon /></button>
        <button type="button" aria-label="Escape" {...shortcutHandlers("escape", shortcutActionsRef.current.escape)}><span aria-hidden="true">⎋</span></button>
        <button type="button" aria-label="Tab" {...shortcutHandlers("tab", shortcutActionsRef.current.tab)}><span aria-hidden="true">⇥</span></button>
        <button className={shiftActive ? "is-active" : ""} type="button" aria-label="Shift" aria-pressed={shiftActive} {...shortcutHandlers("shift", shortcutActionsRef.current.shift)}><span aria-hidden="true">⇧</span></button>
        <button type="button" aria-label="Slash" {...shortcutHandlers("slash", shortcutActionsRef.current.slash)}><span aria-hidden="true">/</span></button>
        <button type="button" aria-label="At sign" {...shortcutHandlers("at", shortcutActionsRef.current.at)}><span aria-hidden="true">@</span></button>
        <button className={commandActive ? "is-active" : ""} type="button" aria-label="Command" aria-pressed={commandActive} {...shortcutHandlers("command", shortcutActionsRef.current.command)}><span aria-hidden="true">⌘</span></button>
      </div>
    </section>
  );
}
