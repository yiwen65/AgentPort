import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteClient } from "./remoteClient";
import { useForegroundRecovery } from "./useForegroundRecovery";
import { FOREGROUND_PROBE_TIMEOUT_MS } from "./connectionRecovery";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(request = vi.fn().mockResolvedValue({ revision: 1 })) {
  const client = { request, disconnect: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue({}) } as unknown as RemoteClient;
  const callbacks = { onChecking: vi.fn(), onStart: vi.fn(), onRecovered: vi.fn(), onError: vi.fn() };
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const view = renderHook(({ host, active }) => useForegroundRecovery(client, host, active, callbacks), { initialProps: { host: "h", active: true } });
  const change = (state: "hidden" | "visible") => { visibility.mockReturnValue(state); fireEvent(document, new Event("visibilitychange")); };
  return { client, callbacks, view, change };
}
it("preserves a healthy transport without entering recovery", async () => {
  const { client, callbacks, change } = setup();
  change("hidden"); change("visible");
  await act(async () => {});
  expect(client.request).toHaveBeenCalledWith("h", "agent.preferences", {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(client.disconnect).not.toHaveBeenCalled(); expect(callbacks.onStart).not.toHaveBeenCalled();
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});
it("replaces a rejected transport, not its Host or inputs", async () => {
  const { client, callbacks, change } = setup(vi.fn().mockRejectedValue({ code: "connection_closed" }));
  change("hidden"); change("visible"); await act(async () => {});
  expect(callbacks.onStart).toHaveBeenCalledOnce();
  expect(client.disconnect).toHaveBeenCalledWith("h"); expect(client.connect).toHaveBeenCalledWith("h");
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});
it("bounds an unresponsive probe and ignores its late reply", async () => {
  vi.useFakeTimers(); let resolve!: (value: unknown) => void;
  const { client, callbacks, change } = setup(vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })));
  change("hidden"); change("visible");
  await act(async () => { await vi.advanceTimersByTimeAsync(FOREGROUND_PROBE_TIMEOUT_MS - 1); });
  expect(client.disconnect).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(client.disconnect).toHaveBeenCalledOnce();
  expect(vi.mocked(client.request).mock.calls[0][3]?.signal?.aborted).toBe(true);
  await act(async () => resolve({}));
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});
it.each(["hidden", "unmounted", "inactive", "new-host"])("does not replace an obsolete %s probe", async reason => {
  let reject!: (error: unknown) => void;
  const { client, callbacks, view, change } = setup(vi.fn().mockImplementation(() => new Promise((_, fail) => { reject = fail; })));
  change("hidden"); change("visible"); await act(async () => {});
  if (reason === "hidden") change("hidden");
  else if (reason === "unmounted") view.unmount();
  else view.rerender({ host: reason === "new-host" ? "other" : "h", active: reason !== "inactive" });
  await act(async () => reject(new Error("late")));
  expect(client.disconnect).not.toHaveBeenCalled(); expect(callbacks.onRecovered).not.toHaveBeenCalled();
});
