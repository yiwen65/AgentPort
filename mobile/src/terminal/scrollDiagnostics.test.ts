import { describe, expect, it, vi } from "vitest";
import { createScrollDiagnostics, type Phase } from "./scrollDiagnostics";

function fixture(settings: { windowMs?: number; maxEvents?: number } = {}) {
  let now = 100_000;
  let scheduled: (() => void) | undefined;
  const emit = vi.fn<(event: string, detail: Record<string, unknown>) => void>();
  const cancel = vi.fn();
  const schedule = vi.fn((callback: () => void, _ms: number) => { scheduled = callback; return 17; });
  const diagnostics = createScrollDiagnostics({ clock: () => now, schedule, cancel, emit, ...settings });
  const details = (event: string) => emit.mock.calls.filter(([name]) => name === `scroll_diag_${event}`).map(([, detail]) => detail);
  const records = () => details("chunk").flatMap(detail => detail.records as number[][]);
  return { diagnostics, emit, cancel, schedule, details, records,
    at: (time: number) => { now = 100_000 + time; },
    expire: () => scheduled?.(),
  };
}

describe("opt-in scroll timing collector", () => {
  it("does nothing while idle, begins only once, and finishes on the default timer", () => {
    const f = fixture();
    f.diagnostics.mark("input");
    f.diagnostics.frame();
    f.diagnostics.finish();
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.diagnostics.running).toBe(false);
    expect(f.diagnostics.begin({ renderer: "webgl", rows: 32 })).toBe(true);
    expect(f.diagnostics.begin({})).toBe(false);
    expect(f.diagnostics.running).toBe(true);
    expect(f.schedule).toHaveBeenCalledWith(expect.any(Function), 15_000);
    // Neither marks nor frames emit IPC.
    f.at(10);
    f.diagnostics.mark("input", 4);
    f.diagnostics.frame();
    expect(f.emit).not.toHaveBeenCalled();
    f.at(15_000);
    f.expire();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(17);
    expect(f.diagnostics.running).toBe(false);
    expect(f.records()).toEqual([[0, 0, 1], [10, 1, 4]]);
    const callCount = f.emit.mock.calls.length;
    f.diagnostics.finish();
    f.expire();
    f.diagnostics.mark("render");
    f.diagnostics.frame();
    expect(f.diagnostics.begin({})).toBe(false);
    expect(f.emit).toHaveBeenCalledTimes(callCount);
    expect(f.details("summary")[0]).toMatchObject({ durationMs: 15_000, events: 2 });
    expect(f.details("meta")).toContainEqual(expect.objectContaining({ metadata: { renderer: "webgl" } }));
  });

  it("uses relative rounded monotonically ordered times and fixed phase IDs", () => {
    const f = fixture({ windowMs: 120 });
    f.diagnostics.begin({});
    const phases: Phase[] = ["input", "submissionReleased", "outputReceived", "queuedWrite", "parsed", "render", "resize"];
    phases.forEach((phase, index) => {
      f.at(index + 0.123);
      f.diagnostics.mark(phase, index + 2);
    });
    f.at(2); // A clock regression cannot reorder the trace.
    f.diagnostics.mark("input");
    f.diagnostics.finish();
    expect(f.schedule).toHaveBeenCalledWith(expect.any(Function), 120);
    expect(f.records()).toEqual([[0, 0, 1], ...phases.map((_, i) => [i + 0.1, i + 1, i + 2]), [6.1, 1, 1]]);
    expect(f.details("phase")).toHaveLength(17);
    expect(f.details("phase")[1]).toMatchObject({ id: 1, phase: "input", count: 2, units: 3 });
    expect(f.details("meta")[0]).toMatchObject({ clock: "relative_ms" });
  });

  it("disposal cancels and discards with no logging or restart", () => {
    const f = fixture();
    f.diagnostics.begin({});
    f.diagnostics.mark("queuedWrite", 10);
    f.diagnostics.dispose();
    f.expire();
    f.diagnostics.finish();
    f.diagnostics.dispose();
    expect(f.cancel).toHaveBeenCalledTimes(1);
    expect(f.emit).not.toHaveBeenCalled();
    expect(f.diagnostics.running).toBe(false);
    expect(f.diagnostics.begin({})).toBe(false);
    const idle = fixture();
    idle.diagnostics.dispose();
    expect(idle.diagnostics.begin({})).toBe(false);
    expect(idle.schedule).not.toHaveBeenCalled();
  });

  it("bounds records while keeping phase totals and accounting for drops", () => {
    const f = fixture({ maxEvents: 3 });
    f.diagnostics.begin({});
    for (let i = 0; i < 100; i++) f.diagnostics.mark("outputReceived", 50);
    f.diagnostics.finish();
    expect(f.records()).toHaveLength(3);
    expect(f.details("summary")[0]).toMatchObject({ events: 3, droppedEvents: 98 });
    expect(f.details("phase")[3]).toMatchObject({ count: 100, units: 5000 });
    const empty = fixture({ maxEvents: 0 });
    empty.diagnostics.begin({});
    empty.diagnostics.finish();
    expect(empty.records()).toEqual([]);
    expect(empty.details("summary")[0]).toMatchObject({ events: 0, droppedEvents: 1 });
  });

  it("summarizes frame intervals without counting the first frame or threshold equality", () => {
    const f = fixture();
    f.diagnostics.begin({});
    [0, 10, 35, 61, 111, 162].forEach(time => { f.at(time); f.diagnostics.frame(); });
    expect(f.emit).not.toHaveBeenCalled();
    f.diagnostics.finish();
    expect(f.details("summary")[0].frames).toEqual({ count: 5, dropped: 0, p50: 26, p95: 51, max: 51, over25: 3, over50: 1 });
  });

  it("bounds frame storage and defaults to 1024 events", () => {
    const f = fixture();
    f.diagnostics.begin({});
    for (let i = 0; i < 5000; i++) {
      f.at(i * 16);
      f.diagnostics.frame();
      f.diagnostics.mark("render");
    }
    f.diagnostics.finish();
    expect(f.details("summary")[0]).toMatchObject({ events: 1024, droppedEvents: 3977,
      frames: { count: 4096, dropped: 903, p50: 16, p95: 16, max: 16 } });
  });

  it("allows a bounded high-rate capture while preserving the default event budget", () => {
    const f = fixture({ maxEvents: 10_000 });
    f.diagnostics.begin({});
    for (let i = 0; i < 5000; i++) f.diagnostics.mark("syncBegin");
    f.diagnostics.finish();
    expect(f.records()).toHaveLength(4096);
    expect(f.details("summary")[0]).toMatchObject({ events: 4096, droppedEvents: 905 });
    expect(f.details("phase")[10]).toMatchObject({ phase: "syncBegin", count: 5000 });
  });

  it("keeps every metadata, summary, phase and chunk line <=550 characters", () => {
    const f = fixture();
    f.diagnostics.begin(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i) + "\u0000".repeat(1000), "\u0001".repeat(2000)])));
    for (let i = 0; i < 1100; i++) {
      f.at(i * 12345.6789);
      f.diagnostics.mark("queuedWrite", Number.MAX_SAFE_INTEGER);
    }
    f.diagnostics.finish();
    for (const [event, detail] of f.emit.mock.calls) expect(event.length + 1 + JSON.stringify(detail).length).toBeLessThanOrEqual(550);
    expect(f.details("meta")).toHaveLength(33);
    const chunks = f.details("chunk");
    expect(chunks.length).toBeGreaterThan(64); // Dynamic size, not just the 16-record cap.
    chunks.forEach((chunk, index) => {
      expect(chunk.index).toBe(index);
      expect((chunk.records as unknown[]).length).toBeLessThanOrEqual(16);
    });
    expect(f.records()).toHaveLength(1024);
    expect(new Set(f.emit.mock.calls.map(([, detail]) => detail.traceId)).size).toBe(1);
  });

  it("contains emitter failures and assigns a new non-session trace identity", () => {
    const f = fixture();
    f.emit.mockImplementation(() => { throw new Error("native log unavailable"); });
    f.diagnostics.begin({});
    expect(() => f.diagnostics.finish()).not.toThrow();
    expect(f.diagnostics.running).toBe(false);
    expect(f.emit).toHaveBeenCalled();
    const g = fixture();
    g.diagnostics.begin({});
    g.diagnostics.finish();
    expect(g.details("summary")[0].traceId).not.toBe(f.details("summary")[0].traceId);
  });
});
