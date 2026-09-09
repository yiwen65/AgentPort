import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";
import { TerminalParserTail } from "./terminalCheckpoint";
const write = (terminal: Terminal, data: string | Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
const create = () => { const terminal = new Terminal({ cols: 47, rows: 53, allowProposedApi: true }); const serialize = new SerializeAddon(); terminal.loadAddon(serialize); return { terminal, serialize }; };
const lines = (t: Terminal) => Array.from({ length: t.rows }, (_,i) => t.buffer.active.getLine(i)?.translateToString(true));
describe("real xterm checkpoint replay", () => {
  it("preserves transcript omitted by a 64 KiB differential tail", async () => {
    const source = create(), restored = create(), cold = create();
    try {
      const output = "\x1b[?1049h\x1b[2J\x1b[HHEADER\x1b[3;1HHISTORY_MUST_SURVIVE" + "\x1b[46;1HWorking...\x1b[50;1H> ".repeat(5000);
      await write(source.terminal, output);
      await write(cold.terminal, "\x1b[?1049h" + output.slice(-65536));
      expect(lines(cold.terminal)[2]).toBe("");
      await write(restored.terminal, source.serialize.serialize());
      const next = "\x1b[46;1HIdle      ";
      await write(source.terminal, next); await write(restored.terminal, next);
      expect(lines(restored.terminal)).toEqual(lines(source.terminal));
      expect(lines(restored.terminal)[2]).toBe("HISTORY_MUST_SURVIVE");
    } finally { source.terminal.dispose(); restored.terminal.dispose(); cold.terminal.dispose(); }
  });
  it.each(["\x1b[38;2;108;108;108m", "\x1b]0;title\x07", "\x1b(B", "中文🙂"])("preserves every parser split of %j", async value => {
    const bytes = new TextEncoder().encode(value);
    for (let split = 1; split < bytes.length; split++) {
      const source = create(), restored = create(), tail = new TerminalParserTail();
      try {
        await write(source.terminal, "\x1b[?1049h\x1b[2Jhello");
        const prefix = bytes.slice(0,split), suffix = bytes.slice(split);
        tail.advance(prefix); await write(source.terminal, prefix);
        await write(restored.terminal, source.serialize.serialize());
        await write(restored.terminal, new Uint8Array(tail.snapshot()!));
        await write(source.terminal, suffix); await write(restored.terminal, suffix);
        await write(source.terminal, "DONE"); await write(restored.terminal, "DONE");
        expect(lines(restored.terminal)).toEqual(lines(source.terminal));
        expect(restored.terminal.buffer.active.cursorX).toBe(source.terminal.buffer.active.cursorX);
      } finally { source.terminal.dispose(); restored.terminal.dispose(); }
    }
  });
});
