import { useEffect, useRef, useState } from "react";
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
      scheduleFit(false);
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
      viewport?.removeEventListener("resize", viewportChanged);
      viewport?.removeEventListener("scroll", viewportChanged);
      window.removeEventListener("orientationchange", orientationChanged);
      section.removeEventListener("focusin", focusIn);
      section.removeEventListener("focusout", focusOut);
      workspace?.style.removeProperty("--terminal-viewport-height");
      workspace?.style.removeProperty("--terminal-viewport-top");
      resize.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, []); // The terminal is a long-lived renderer; callback refs carry changing handlers.

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

  return (
    <section ref={sectionRef} className="mobile-terminal-spike" data-input-active={inputActive} aria-label={title}>
      {showHeading ? <div className="mobile-terminal-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}
      <div ref={containerRef} className="mobile-terminal-surface" role="application" aria-label={title} />
      <div className="mobile-terminal-keys" data-horizontal-scroll aria-label="Terminal special keys" hidden={!inputActive}>
        <button type="button" aria-label="Paste" onPointerDown={(event) => event.preventDefault()} onClick={paste}><PasteIcon /></button>
        <button type="button" aria-label="Escape" onPointerDown={(event) => event.preventDefault()} onClick={() => send("\u001b")}><span aria-hidden="true">⎋</span></button>
        <button type="button" aria-label="Tab" onPointerDown={(event) => event.preventDefault()} onClick={() => send("\t")}><span aria-hidden="true">⇥</span></button>
        <button className={shiftActive ? "is-active" : ""} type="button" aria-label="Shift" aria-pressed={shiftActive} onPointerDown={(event) => event.preventDefault()} onClick={() => { terminalRef.current?.focus(); setShift(!shiftRef.current); }}><span aria-hidden="true">⇧</span></button>
        <button type="button" aria-label="Slash" onPointerDown={(event) => event.preventDefault()} onClick={() => send("/")}><span aria-hidden="true">/</span></button>
        <button type="button" aria-label="At sign" onPointerDown={(event) => event.preventDefault()} onClick={() => send("@")}><span aria-hidden="true">@</span></button>
        <button className={commandActive ? "is-active" : ""} type="button" aria-label="Command" aria-pressed={commandActive} onPointerDown={(event) => event.preventDefault()} onClick={() => { terminalRef.current?.focus(); setCommand(!commandRef.current); }}><span aria-hidden="true">⌘</span></button>
      </div>
    </section>
  );
}
