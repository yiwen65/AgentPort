import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { installSynchronizedOutput } from "./synchronizedOutput";

function fixture() {
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
  const dispose = installSynchronizedOutput(terminal as unknown as Terminal);
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
