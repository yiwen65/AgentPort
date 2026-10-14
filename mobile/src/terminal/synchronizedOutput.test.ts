import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installSynchronizedOutput } from "./synchronizedOutput";

function fixture(observe?: (held: boolean, reason: "marker" | "timeout" | "reset" | "paint") => void) {
  const handlers = new Map<string, (params: number[]) => boolean>();
  const render = vi.fn(), refresh = vi.fn(), reset = vi.fn();
  const paint = vi.fn();
  const renderer = { _renderRows: render, _renderer: { value: { renderRows: paint } } };
  const register = ({ final }: { final: string }, handler: (params: number[]) => boolean) => {
    handlers.set(final, handler);
    return { dispose: () => handlers.delete(final) };
  };
  const terminal = { _core: { _renderService: renderer }, rows: 24, refresh, reset,
    parser: { registerCsiHandler: register, registerEscHandler: register } };
  const dispose = installSynchronizedOutput(terminal as unknown as Terminal, observe);
  return { handlers, renderer, render, paint, refresh, reset, terminal, dispose };
}

afterEach(() => vi.useRealTimers());

describe("DEC 2026 render transaction", () => {
  it("holds scheduled renders, then requests a complete screen without consuming other modes", () => {
    const f = fixture();
    expect(f.handlers.get("h")!([25, 2026])).toBe(false);
    f.renderer._renderRows(0, 23);
    f.renderer._renderer.value.renderRows(0, 23);
    expect(f.paint).not.toHaveBeenCalled();
    expect(f.render).not.toHaveBeenCalled();
    expect(f.handlers.get("l")!([2026, 25])).toBe(false);
    expect(f.refresh).toHaveBeenCalledWith(0, 23);
    f.renderer._renderRows(0, 23);
    expect(f.render).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("bounds an unmatched frame even when begin is repeated", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.handlers.get("h")!([2026]);
    vi.advanceTimersByTime(900);
    f.handlers.get("h")!([2026]);
    vi.advanceTimersByTime(100);
    f.renderer._renderRows(0, 23);
    expect(f.render).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  });

  it.each(["api", "ris"])("releases a frame on %s reset", kind => {
    vi.useFakeTimers();
    const f = fixture();
    f.handlers.get("h")!([2026]);
    if (kind === "api") { f.terminal.reset(); expect(f.reset).toHaveBeenCalledOnce(); }
    else expect(f.handlers.get("c")!([])).toBe(false);
    f.renderer._renderRows(0, 23);
    expect(f.render).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    f.dispose();
  });

  it("observes actual hold transitions and their release reason without duplicating begins", () => {
    vi.useFakeTimers();
    const observe = vi.fn();
    const f = fixture(observe);
    f.handlers.get("h")!([2026]);
    f.handlers.get("h")!([2026]);
    f.handlers.get("l")!([2026]);
    f.handlers.get("l")!([2026]);
    f.handlers.get("h")!([2026]);
    vi.advanceTimersByTime(1000);
    f.handlers.get("h")!([2026]);
    f.terminal.reset();
    expect(observe.mock.calls).toEqual([[true, "marker"], [false, "marker"], [true, "marker"], [false, "timeout"], [true, "marker"], [false, "reset"]]);
    expect(f.refresh).toHaveBeenCalledTimes(3);
    f.dispose();
  });

  it("reports actual suppressed paint attempts without changing gate transitions", () => {
    const observe = vi.fn();
    const f = fixture(observe);
    f.handlers.get("h")!([2026]);
    f.renderer._renderRows(0, 23);
    f.renderer._renderer.value.renderRows(0, 23);
    f.handlers.get("l")!([2026]);
    expect(observe.mock.calls).toEqual([[true, "marker"], [true, "paint"], [true, "paint"], [false, "marker"]]);
    expect(f.render).not.toHaveBeenCalled();
    expect(f.paint).not.toHaveBeenCalled();
    f.renderer._renderRows(0, 23);
    expect(f.render).toHaveBeenCalledOnce();
    f.dispose();
  });

  it("ignores diagnostic observer failures and retains render gating and cleanup", () => {
    vi.useFakeTimers();
    const f = fixture(() => { throw new Error("observer failed"); });
    expect(() => f.handlers.get("h")!([2026])).not.toThrow();
    f.renderer._renderRows(0, 23);
    expect(f.render).not.toHaveBeenCalled();
    expect(() => f.handlers.get("l")!([2026])).not.toThrow();
    f.renderer._renderRows(0, 23);
    expect(f.render).toHaveBeenCalledOnce();
    f.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores callbacks and cancels the watchdog on disposal", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.handlers.get("h")!([2026]);
    f.dispose();
    expect(f.renderer._renderRows).toBe(f.render);
    expect(f.terminal.reset).toBe(f.reset);
    expect(f.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
