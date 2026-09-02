import { useEffect, useRef } from "react";
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

const specialKeys = [
  ["Esc", "\u001b"],
  ["Tab", "\t"],
  ["Ctrl-C", "\u0003"],
  ["Ctrl-D", "\u0004"],
  ["Ctrl-Z", "\u001a"],
  ["↑", "\u001b[A"],
  ["↓", "\u001b[B"],
  ["←", "\u001b[D"],
  ["→", "\u001b[C"],
] as const;

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
  inputRef.current = onInput;
  resizeRef.current = onResize;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      scrollback: 10_000,
      fontSize,
      screenReaderMode: true,
      theme: { background: "#11151f", foreground: "#f4f6fb" },
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
      if (inputRef.current) inputRef.current(data);
      else terminal.write(data === "\r" ? "\r\n$ " : data);
    });
    // Ordinary layout and visual-viewport changes (notably the soft keyboard)
    // fit only the local renderer. They must not steal PTY geometry ownership.
    const resize = new ResizeObserver(() => scheduleFit(false));
    resize.observe(container);
    const viewport = window.visualViewport;
    const viewportChanged = () => scheduleFit(false);
    viewport?.addEventListener("resize", viewportChanged);
    const orientationChanged = () => {
      window.clearTimeout(orientationTimerRef.current);
      // Orientation events can arrive before safe-area and visual viewport
      // dimensions settle. The observer handles intermediate layout, while
      // this trailing fit publishes the stable portrait/landscape geometry.
      orientationTimerRef.current = window.setTimeout(() => scheduleFit(true), 120);
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
      window.removeEventListener("orientationchange", orientationChanged);
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
    const terminal = terminalRef.current;
    terminal?.focus();
    if (inputRef.current) inputRef.current(data);
    else terminal?.write(data === "\r" ? "\r\n$ " : data);
  };

  return (
    <section className="mobile-terminal-spike" aria-label={title}>
      {showHeading ? <div className="mobile-terminal-heading"><h2>{title}</h2>{description ? <p>{description}</p> : null}</div> : null}
      <div ref={containerRef} className="mobile-terminal-surface" role="application" aria-label={title} />
      <div className="mobile-terminal-keys" aria-label="Terminal special keys">
        {specialKeys.map(([label, data]) => <button key={label} type="button" onClick={() => send(data)}>{label}</button>)}
        <button type="button" onClick={() => { terminalRef.current?.selectAll(); terminalRef.current?.focus(); }}>Select all</button>
        <button type="button" onClick={() => navigator.clipboard?.writeText(terminalRef.current?.getSelection() ?? "")}>Copy</button>
        <button type="button" onClick={() => navigator.clipboard?.readText().then(send).catch(() => undefined)}>Paste</button>
      </div>
    </section>
  );
}
