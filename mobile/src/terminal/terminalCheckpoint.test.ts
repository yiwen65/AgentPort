import { beforeEach, describe, expect, it } from "vitest";
import { clearTerminalCheckpoints, readCheckpoint, saveCheckpoint, forgetCheckpoint, TerminalParserTail, type TerminalCheckpoint } from "./terminalCheckpoint";
const screen = (content = "screen"): TerminalCheckpoint => ({ content, cols: 47, rows: 53, pending: [], cursor: { runId: "run", runOrdinal: 1, generation: 0, offset: 42, statusSequence: 0 } });
beforeEach(clearTerminalCheckpoints);
describe("terminal switch checkpoints", () => {
  it("waits for the parser-drained screen with its exact cursor", async () => {
    let resolve!: (value: TerminalCheckpoint) => void;
    saveCheckpoint("a", new Promise(r => { resolve = r; }));
    const result = readCheckpoint("a");
    resolve(screen());
    expect(await result).toEqual(screen());
  });
  it("fences old async captures after a newer capture or invalidation", async () => {
    let resolve!: (value: TerminalCheckpoint) => void;
    saveCheckpoint("a", new Promise(r => { resolve = r; }));
    saveCheckpoint("a", Promise.resolve(screen("new")));
    resolve(screen("old"));
    expect((await readCheckpoint("a"))?.content).toBe("new");
    forgetCheckpoint("a");
    expect(await readCheckpoint("a")).toBeUndefined();
  });
  it("bounds count and memory and fails closed on capture errors", async () => {
    for (let i = 0; i < 9; i++) saveCheckpoint(String(i), Promise.resolve(screen()));
    expect(await readCheckpoint("0")).toBeUndefined();
    saveCheckpoint("large", Promise.resolve(screen("x".repeat(4 * 1024 * 1024 + 1))));
    expect(await readCheckpoint("large")).toBeUndefined();
    saveCheckpoint("bad", Promise.reject(new Error("disposed")));
    expect(await readCheckpoint("bad")).toBeUndefined();
  });
});
describe("serialized parser prefix", () => {
  it.each(["\x1b[38;2;108;108;108m", "\x1b]0;title\x07", "\x1b]0;title\x1b\\", "\x1bPdata\x1b\\", "\x1b(B", "中文🙂"])("retains every split of %j", value => {
    const bytes = new TextEncoder().encode(value);
    for (let split = 0; split <= bytes.length; split++) {
      const tail = new TerminalParserTail();
      tail.advance(bytes.slice(0, split));
      const restored = new TerminalParserTail();
      restored.advance(new Uint8Array(tail.snapshot()!));
      restored.advance(bytes.slice(split));
      expect(restored.snapshot()).toEqual([]);
    }
  });
  it("rejects prefixes with already-executed controls instead of moving the cursor twice", () => {
    const tail = new TerminalParserTail();
    tail.advance("\x1b[\n2");
    expect(tail.snapshot()).toBeUndefined();
    tail.advance("J");
    expect(tail.snapshot()).toEqual([]);
  });

  it("retains only the incomplete suffix and bounds oversized control strings", () => {
    const tail = new TerminalParserTail();
    tail.advance("complete\x1b[38;2;");
    expect(tail.snapshot()).toEqual([...new TextEncoder().encode("\x1b[38;2;")]);
    tail.reset(); tail.advance("\x1b]" + "x".repeat(70000));
    expect(tail.snapshot()).toBeUndefined();
    tail.advance("\x07"); expect(tail.snapshot()).toEqual([]);
  });
});
