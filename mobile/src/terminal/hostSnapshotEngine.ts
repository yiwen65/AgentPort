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
  const pending = tail.snapshot();
  if (!pending) return "null"; // Never replay a prefix with already-applied side effects.
  return JSON.stringify({ content: serialize.serialize({ scrollback: 2000 }),
    cols: terminal.cols, rows: terminal.rows, pending, state: captureSnapshotState(terminal) });
}
