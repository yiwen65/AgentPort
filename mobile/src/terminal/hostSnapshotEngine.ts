import { TerminalParserTail } from "./terminalCheckpoint";
import { captureSnapshotState } from "./terminalSnapshot";
// Runtime constructors are pinned, vendored bundles loaded by the Host.
declare const exports: { Terminal: new (options: object) => any; SerializeAddon: { SerializeAddon: new () => any } };
let terminal: any;
let serialize: any;
const tail = new TerminalParserTail();
export function init(cols: number, rows: number) {
  terminal = new exports.Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
  serialize = new exports.SerializeAddon.SerializeAddon();
  terminal.loadAddon(serialize);
}
export function feed(bytes: Uint8Array) {
  tail.advance(bytes);
  // The Host owns a synchronous output transaction, not a browser event loop.
  terminal._core._writeBuffer.writeSync(bytes);
}
export function resize(cols: number, rows: number) { terminal.resize(cols, rows); }
/** Live buffer bottom, never the scrollable viewport or retained transcript. */
export function detectionText(): string {
  const pending = tail.snapshot();
  if (!pending || pending.length) return "";
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = Math.max(0, terminal.rows - 64); row < terminal.rows; row++) {
    lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true, 0, Math.min(terminal.cols, 1024)) ?? "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.slice(-8).join("\n").slice(-8192);
}
export function snapshot(): string {
  let pending = tail.snapshot();
  if (!pending) {
    // The simplified parser-tail can stick in overflow/unsafePrefix on a
    // prefix the real terminal parses cleanly. Returning "null" makes the Host
    // fall back to a differential tail replay, which for a busy fullscreen TUI
    // reconstructs the screen by re-parsing history and keeps the renderer
    // repainting. The serialized screen and mode state are still authoritative;
    // drop only the unusable trailing prefix (never replay its side effects)
    // and reset the tracker so it can track the live stream again.
    tail.reset();
    pending = [];
  }
  return JSON.stringify({ content: serialize.serialize({ scrollback: 2000 }),
    cols: terminal.cols, rows: terminal.rows, pending, state: captureSnapshotState(terminal) });
}
