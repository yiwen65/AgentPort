import { describe, expect, it } from "vitest";
import { Terminal as Headless } from "@xterm/headless";
import { Terminal as Browser } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalParserTail } from "./terminalCheckpoint";
import { captureSnapshotState, restoreSnapshotState, isTerminalSnapshot } from "./terminalSnapshot";

const write = (t: Headless | Browser, data: string | Uint8Array) => new Promise<void>(resolve => t.write(data, resolve));
const view = (t: Browser) => ({ state: captureSnapshotState(t), type: t.buffer.active.type,
  buffers: [t.buffer.normal, t.buffer.alternate].map(b => Array.from({ length: b.length }, (_, i) => {
    const line = b.getLine(i)!;
    return Array.from({ length: 47 }, (_, x) => { const c = line.getCell(x)!;
      return [c.getChars(), c.getWidth(), c.getFgColor(), c.getBgColor(), c.isBold(), c.isUnderline()]; });
  })) });
const cases = [
  ["saved cursor", "\x1b[3;4HA\x1b7\x1b[6;8HB", "\x1b8C"],
  ["margins", "\x1b[2;6r\x1b[6;1HLAST", "\nNEXT"],
  ["alternate return", "PRIMARY\x1b[?1049hALT", "\x1b[?1049l!"],
  ["wide/combining", "中文界é café\x1b[3;1H输入框", "\x1b[3;3H新!"],
  ["split CSI", "HEADER\x1b[5;", "7HINPUT"],
  ["split OSC", "HEADER\x1b]0;title", "\x07BODY"],
  ["wrap", "12345678901234567890123456789012345678901234567", "next"],
  ["styles/tabs/mouse", "\x1b[3g\x1b[4G\x1bH\x1b[1;38;2;45;67;89mX\x1b7\x1b[?1002h\x1b[?1006h", "\x1b8\tNEXT"],
];
async function check(prefix: Uint8Array, suffix: Uint8Array) {
  const options = { cols: 47, rows: 53, scrollback: 2000, allowProposedApi: true };
  const host = new Headless(options), expected = new Browser(options), actual = new Browser(options);
  try {
    const addon = new SerializeAddon(); host.loadAddon(addon);
    const tail = new TerminalParserTail(); tail.advance(prefix);
    await write(host, prefix);
    const saved = { content: addon.serialize({ scrollback: 2000 }), cols: 47, rows: 53,
      pending: tail.snapshot(), state: captureSnapshotState(host) };
    expect(isTerminalSnapshot(saved)).toBe(true);
    await write(actual, saved.content);
    restoreSnapshotState(actual, saved.state);
    await write(actual, new Uint8Array(saved.pending!));
    await write(actual, suffix);
    await write(expected, prefix); await write(expected, suffix);
    expect(view(actual)).toEqual(view(expected));
  } finally { host.dispose(); expected.dispose(); actual.dispose(); }
}
describe("same-engine terminal snapshot", () => {
  it.each(cases)("preserves %s and subsequent output", async (_name, prefix, suffix) => {
    await check(new TextEncoder().encode(prefix), new TextEncoder().encode(suffix));
  });
  it("preserves every byte split of UTF-8, CSI, OSC and charset changes", async () => {
    const bytes = new TextEncoder().encode("中文é\x1b[38;2;20;30;40mX\x1b]0;title\x07\x1b(0qq\x1b(B!\x1b[3;4HINPUT");
    for (let split = 0; split <= bytes.length; split++) await check(bytes.slice(0, split), bytes.slice(split));
  }, 20000);
  it("rejects malformed remote snapshots", () => {
    expect(isTerminalSnapshot({ content: "", cols: 47, rows: 53, pending: [], state: { version: 2 } })).toBe(false);
    expect(isTerminalSnapshot(null)).toBe(false);
  });
});
