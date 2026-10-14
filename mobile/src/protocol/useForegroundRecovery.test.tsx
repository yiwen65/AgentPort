import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteClient, RemoteConnectionStateEvent } from "./remoteClient";
import { useForegroundRecovery } from "./useForegroundRecovery";
import { FOREGROUND_PROBE_TIMEOUT_MS } from "./connectionRecovery";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
function setup(request = vi.fn().mockResolvedValue({ revision: 1 })) {
  const listeners = new Set<(event: RemoteConnectionStateEvent) => void>();
  const client = { request, disconnect: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue({}),
    resumeConnection: vi.fn().mockResolvedValue(undefined),
    onConnectionState: vi.fn(async (listener: (event: RemoteConnectionStateEvent) => void) => {
      listeners.add(listener);
      return async () => { listeners.delete(listener); };
    }),
  } as unknown as RemoteClient;
  const callbacks = { onChecking: vi.fn(), onStart: vi.fn(), onRecovered: vi.fn(), onError: vi.fn() };
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const view = renderHook(({ host, active }) => useForegroundRecovery(client, host, active, callbacks), { initialProps: { host: "h", active: true } });
  const change = (state: "hidden" | "visible") => { visibility.mockReturnValue(state); fireEvent(document, new Event("visibilitychange")); };
  const connection = (state: RemoteConnectionStateEvent["state"], host = "h") => {
    act(() => listeners.forEach(listener => listener({ profileId: host, state })));
  };
  return { client, callbacks, view, change, connection };
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
it("joins an automatic reconnect already underway on foreground instead of restarting it", async () => {
  const { client, callbacks, change, connection } = setup(vi.fn().mockRejectedValue({ code: "host_not_connected" }));
  change("hidden");
  connection("reconnecting");
  change("visible"); await act(async () => {});
  expect(client.disconnect).not.toHaveBeenCalled();
  expect(client.connect).not.toHaveBeenCalled();
  expect(client.request).not.toHaveBeenCalled();
  expect(client.resumeConnection).toHaveBeenCalledExactlyOnceWith("h");
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  connection("connected"); await act(async () => {});
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});

it("does not replace a newly recovered transport because an old probe failed", async () => {
  let reject!: (error: unknown) => void;
  const { client, callbacks, change, connection } = setup(vi.fn(() => new Promise((_, fail) => { reject = fail; })));
  change("hidden"); change("visible"); await act(async () => {});
  connection("reconnecting");
  connection("connected");
  await act(async () => reject(new Error("old transport closed")));
  expect(client.disconnect).not.toHaveBeenCalled();
  expect(client.connect).not.toHaveBeenCalled();
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});

it("rechecks a replacement if its connecting event was missed before an old probe failed", async () => {
  let reject!: (error: unknown) => void;
  const request = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({});
  const { client, callbacks, change, connection } = setup(request);
  change("hidden"); change("visible"); await act(async () => {});
  connection("connected");
  await act(async () => reject(new Error("old connection failed")));
  expect(request).toHaveBeenCalledTimes(2);
  expect(client.disconnect).not.toHaveBeenCalled();
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});

it("does not reuse an inactive healthy probe after another native transition", async () => {
  let finish!: (value: unknown) => void;
  const { client, callbacks, view, change, connection } = setup(vi.fn(() => new Promise(resolve => { finish = resolve; })));
  change("hidden"); change("visible"); await act(async () => {});
  view.rerender({ host: "h", active: false });
  connection("reconnecting");
  await act(async () => finish({}));
  view.rerender({ host: "h", active: true }); await act(async () => {});
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  expect(client.resumeConnection).toHaveBeenCalledExactlyOnceWith("h");
  connection("connected");
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});

it("joins native reconnect when a probe fails during the attempt", async () => {
  let reject!: (error: unknown) => void;
  const { client, callbacks, change, connection } = setup(vi.fn(() => new Promise((_, fail) => { reject = fail; })));
  change("hidden"); change("visible"); await act(async () => {});
  connection("reconnecting");
  await act(async () => reject(new Error("closed")));
  expect(client.disconnect).not.toHaveBeenCalled();
  connection("connected"); await act(async () => {});
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
});

it("releases foreground recovery as soon as native reconnect finishes, without waiting for the old probe timeout", async () => {
  vi.useFakeTimers();
  const { client, callbacks, change, connection } = setup(vi.fn(() => new Promise(() => {})));
  change("hidden"); change("visible"); await act(async () => {});
  connection("reconnecting");
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  connection("connected");
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(FOREGROUND_PROBE_TIMEOUT_MS); });
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  expect(client.disconnect).not.toHaveBeenCalled();
});

it.each(["failed", "disconnected"] as const)("reports native %s without cancelling/restarting the finished attempt", async state => {
  const { client, callbacks, change, connection } = setup();
  change("hidden"); connection("reconnecting"); change("visible");
  connection(state); await act(async () => {});
  expect(callbacks.onError).toHaveBeenCalledOnce();
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  expect(client.disconnect).not.toHaveBeenCalled();
});

it("reconciles an explicit recovery that finishes while its retained view is inactive", async () => {
  const { client, callbacks, view, change } = setup(vi.fn().mockRejectedValueOnce(new Error("closed")).mockResolvedValue({}));
  let finish!: () => void;
  vi.mocked(client.disconnect).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  change("hidden"); change("visible"); await act(async () => {});
  view.rerender({ host: "h", active: false });
  await act(async () => finish());
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  view.rerender({ host: "h", active: true }); await act(async () => {});
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  expect(client.disconnect).toHaveBeenCalledOnce();
});

it.each(["hidden", "unmounted", "inactive", "new-host"])("ignores an obsolete %s native reconnect completion", async reason => {
  const { callbacks, view, change, connection } = setup();
  change("hidden"); connection("reconnecting"); change("visible");
  if (reason === "hidden") change("hidden");
  else if (reason === "unmounted") view.unmount();
  else view.rerender({ host: reason === "new-host" ? "other" : "h", active: reason !== "inactive" });
  connection("connected"); await act(async () => {});
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  expect(callbacks.onError).not.toHaveBeenCalled();
  if (reason === "inactive") {
    view.rerender({ host: "h", active: true });
    expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  }
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
