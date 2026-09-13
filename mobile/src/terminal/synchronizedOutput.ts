import type { Terminal } from "@xterm/xterm";

// xterm 5.5 has no DEC 2026 support. Gate its final render callback rather than
// buffering PTY bytes: parsing, snapshot barriers and input remain live, and
// even a multi-megabyte redraw can span parser time slices without flashing.
// This private seam is pinned to 5.5; the real-browser regression checks it.
export function installSynchronizedOutput(terminal: Terminal) {
  const renderer = (terminal as unknown as {
    _core: { _renderService: { _renderRows(start: number, end: number): void;
      _renderer: { value: { renderRows(start: number, end: number): void } } } };
  })._core._renderService;
  const renderRows = renderer._renderRows;
  const paint = renderer._renderer.value;
  const paintRows = paint.renderRows;
  let synchronized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resume = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!synchronized) return;
    synchronized = false;
    terminal.refresh(0, terminal.rows - 1);
  };
  renderer._renderRows = function(start, end) {
    if (!synchronized) renderRows.call(this, start, end);
  };
  // DOM cursor/focus handlers can paint directly, bypassing RenderService.
  paint.renderRows = function(start, end) {
    if (!synchronized) paintRows.call(this, start, end);
  };
  const reset = terminal.reset;
  terminal.reset = function() { resume(); reset.call(this); };
  const handlers = [
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => {
      if (params.includes(2026) && !synchronized) {
        synchronized = true;
        // A truncated stream must not leave the screen frozen indefinitely.
        timer = setTimeout(resume, 1000);
      }
      return false; // Other modes in the same CSI still belong to xterm.
    }),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => {
      if (params.includes(2026)) resume();
      return false;
    }),
    terminal.parser.registerEscHandler({ final: "c" }, () => { resume(); return false; }),
  ];
  return () => {
    clearTimeout(timer);
    handlers.forEach(handler => handler.dispose());
    renderer._renderRows = renderRows;
    paint.renderRows = paintRows;
    terminal.reset = reset;
  };
}
