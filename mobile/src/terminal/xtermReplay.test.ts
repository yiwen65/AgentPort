import { expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";

it("the installed xterm parses queued replay before its empty-write barrier and keeps later live bytes ordered", async () => {
  const terminal = new Terminal({ cols: 40, rows: 5 });
  try {
    let completed = false;
    terminal.write("old");
    terminal.write("", () => terminal.reset());
    terminal.write("\x1b[?1049h\x1b[?1h\x1b[?1002hReplay");
    const barrier = new Promise<void>(resolve => terminal.write("", () => {
      expect(terminal.buffer.active.type).toBe("alternate");
      expect(terminal.modes.applicationCursorKeysMode).toBe(true);
      expect(terminal.modes.mouseTrackingMode).toBe("drag");
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("Replay");
      completed = true;
      resolve();
    }));
    terminal.write(" live");
    expect(completed).toBe(false);
    await barrier;
    await new Promise<void>(resolve => terminal.write("", resolve));
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("Replay live");
    terminal.write("\x1b[?1049l");
    await new Promise<void>(resolve => terminal.write("", resolve));
    expect(terminal.buffer.active.type).toBe("normal");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("");
  } finally {
    terminal.dispose();
  }
});
