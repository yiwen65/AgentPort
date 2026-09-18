// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { captureSnapshotState, isTerminalSnapshot, restoreSnapshotState } from "./terminalSnapshot";

const write = (t: Terminal, data: string | Uint8Array) =>
  new Promise<void>((resolve) => t.write(data, resolve));
const view = (t: Terminal) => ({ state: captureSnapshotState(t), type: t.buffer.active.type,
  buffers: [t.buffer.normal, t.buffer.alternate].map(b => Array.from({ length: b.length }, (_, i) => {
    const line = b.getLine(i)!;
    return Array.from({ length: 47 }, (_, x) => { const c = line.getCell(x)!;
      return [c.getChars(), c.getWidth(), c.getFgColor(), c.getBgColor(), c.isBold(), c.isUnderline()]; });
  })) });
const cases = [
  ["saved cursor", "\x1b[3;4HA\x1b7\x1b[6;8HB", "\x1b8C"],
  ["margins", "\x1b[2;6r\x1b[6;1HLAST", "\nNEXT"],
  ["alternate return", "PRIMARY\x1b[?1049hALT", "\x1b[?1049l!"],
  ["wide/combining", "中文界é café\x1b[3;1H输入框", "\x1b[3;3H新!"],
  ["wrap", "12345678901234567890123456789012345678901234567", "next"],
  ["styles/tabs/mouse", "\x1b[3g\x1b[4G\x1bH\x1b[1;38;2;45;67;89mX\x1b7\x1b[?1002h\x1b[?1006h", "\x1b8\tNEXT"],
];
async function check(prefix: string, suffix: string) {
  const options = { cols: 47, rows: 53, scrollback: 2000, allowProposedApi: true };
  const mirror = new Terminal(options);
  const expected = new Terminal(options);
  const actual = new Terminal(options);
  try {
    const addon = new SerializeAddon();
    mirror.loadAddon(addon);
    await write(mirror, prefix);
    const saved = { content: addon.serialize({ scrollback: 2000 }), cols: 47, rows: 53,
      pending: [] as number[], state: captureSnapshotState(mirror) };
    expect(isTerminalSnapshot(saved)).toBe(true);
    actual.reset();
    await write(actual, saved.content);
    restoreSnapshotState(actual, saved.state);
    await write(actual, new Uint8Array(saved.pending));
    await write(actual, suffix);
    await write(expected, prefix);
    await write(expected, suffix);
    expect(view(actual)).toEqual(view(expected));
  } finally { mirror.dispose(); expected.dispose(); actual.dispose(); }
}
describe("host screen snapshot restore", () => {
  it.each(cases)("preserves %s and subsequent output", async (_name, prefix, suffix) => {
    await check(prefix, suffix);
  });
  it("restores a parser prefix split at the snapshot boundary", async () => {
    // A partial sequence at the snapshot boundary has no screen effect on the
    // mirror, so the Host serves its bytes as `pending` next to the serialized
    // content. Restoring content -> state -> pending must equal the stream.
    for (const [head, tail] of [["HEADER\x1b[5;", "7HINPUT"], ["HEADER\x1b]0;title", "\x07BODY"]]) {
      const options = { cols: 47, rows: 53, scrollback: 2000, allowProposedApi: true };
      const mirror = new Terminal(options);
      const expected = new Terminal(options);
      const actual = new Terminal(options);
      try {
        const addon = new SerializeAddon();
        mirror.loadAddon(addon);
        await write(mirror, head);
        const saved = { content: addon.serialize({ scrollback: 2000 }), cols: 47, rows: 53,
          pending: [...new TextEncoder().encode(head.slice(head.indexOf("\x1b")))],
          state: captureSnapshotState(mirror) };
        expect(isTerminalSnapshot(saved)).toBe(true);
        actual.reset();
        await write(actual, saved.content);
        restoreSnapshotState(actual, saved.state);
        await write(actual, new Uint8Array(saved.pending));
        await write(actual, tail);
        await write(expected, head + tail);
        expect(view(actual)).toEqual(view(expected));
      } finally { mirror.dispose(); expected.dispose(); actual.dispose(); }
    }
  });
  it("rejects malformed remote snapshots", () => {
    expect(isTerminalSnapshot({ content: "", cols: 47, rows: 53, pending: [], state: { version: 2 } })).toBe(false);
    expect(isTerminalSnapshot(null)).toBe(false);
    expect(isTerminalSnapshot({ content: "x", cols: 1, rows: 53, pending: [], state: { version: 1 } })).toBe(false);
  });
});
