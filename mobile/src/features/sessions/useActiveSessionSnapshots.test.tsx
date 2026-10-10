import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import type { SessionSummary } from "./types";
import { useActiveSessionSnapshots } from "./useActiveSessionSnapshots";

const host = (id: string, connectionState: ConnectionState = "connected"): HostProfileSummary => ({
  id, name: id, hostname: id, port: 22, username: "user", preferredTransport: "ssh", connectionState,
  lastConnectedAt: null, lastError: null,
});
const hosts = [host("one"), host("two")];
const session = (id: string): SessionSummary => ({
  id, title: id, projectId: "p", presetId: "agent", cwd: "/project", lifecycle: "active", resumePrecision: "exact",
  adapterType: "pi", transport: "pty", permissionMode: "default", createdAt: "2026-10-10", updatedAt: "2026-10-10",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function makeClient() {
  return {
    request: vi.fn().mockResolvedValue([]), connect: vi.fn(), disconnect: vi.fn(), listHostProfiles: vi.fn(),
  } as unknown as RemoteClient;
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("connected-host Active Session snapshots", () => {
  it.each(["empty", "failed"])("distinguishes first-read readiness from pending refreshes after a %s result", async value => {
    const client = makeClient();
    const first = deferred<SessionSummary[]>(), refresh = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockReturnValueOnce(first.promise).mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(() => useActiveSessionSnapshots(client, hosts.slice(0, 1), true));
    expect(result.current.initialLoading).toBe(true);
    expect(result.current.refreshing).toBe(true);
    await act(async () => {
      if (value === "empty") first.resolve([]); else first.reject(new Error("Read failed"));
    });
    expect(result.current.initialLoading).toBe(false);
    expect(result.current.refreshing).toBe(false);
    if (value === "failed") expect(result.current.snapshots.get("one")?.error).toBe("Read failed");
    act(() => { void result.current.refresh("one", false); });
    expect(result.current.initialLoading).toBe(false);
    expect(result.current.refreshing).toBe(true);
    expect(result.current.snapshots.get("one")?.loading).toBe(true);
    await act(async () => { refresh.resolve([session("updated")]); });
    expect(result.current.snapshots.get("one")?.sessions).toEqual([session("updated")]);
    expect(result.current.initialLoading).toBe(false);
    expect(result.current.refreshing).toBe(false);
  });

  it("preserves unknown first-read state across cancellation, but resets it after reconnection", async () => {
    const client = makeClient();
    const old = deferred<SessionSummary[]>(), first = deferred<SessionSummary[]>(), reconnected = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockReturnValueOnce(old.promise).mockReturnValueOnce(first.promise).mockReturnValueOnce(reconnected.promise);
    const { result, rerender } = renderHook(({ active, profiles }) => useActiveSessionSnapshots(client, profiles, active), {
      initialProps: { active: true, profiles: hosts.slice(0, 1) },
    });
    rerender({ active: false, profiles: hosts.slice(0, 1) });
    await act(async () => { old.resolve([]); });
    expect(result.current.refreshing).toBe(false);
    expect(result.current.initialLoading).toBe(true); // Aborted reads never establish data readiness.
    rerender({ active: true, profiles: hosts.slice(0, 1) });
    expect(result.current.initialLoading).toBe(true);
    await act(async () => { first.resolve([]); });
    expect(result.current.initialLoading).toBe(false);
    rerender({ active: true, profiles: [host("one", "disconnected")] });
    expect(result.current.initialLoading).toBe(false);
    rerender({ active: true, profiles: hosts.slice(0, 1) });
    expect(result.current.initialLoading).toBe(true);
    await act(async () => { reconnected.resolve([]); });
    expect(result.current.initialLoading).toBe(false);
  });

  it("reads all connected hosts at 5s without metadata, probes, connection changes or reference-driven restarts", async () => {
    const client = makeClient();
    const profiles = [...hosts, ...(["disconnected", "connecting", "reconnecting", "stale", "failed"] as const)
      .map(state => host(state, state))];
    vi.mocked(client.request).mockImplementation(async id => [session(id)]);
    const { result, rerender } = renderHook(({ profiles }) => useActiveSessionSnapshots(client, profiles, true), {
      initialProps: { profiles },
    });
    expect(result.current.refreshing).toBe(true);
    expect(result.current.snapshots.get("one")?.loading).toBe(true);
    await flush();
    expect([...result.current.snapshots.keys()]).toEqual(["one", "two"]);
    expect(result.current.refreshing).toBe(false);
    expect(result.current.snapshots.get("two")?.sessions).toEqual([session("two")]);
    rerender({ profiles: [...profiles].reverse().map(profile => ({ ...profile, name: "Renamed" })) });
    await flush();
    expect(client.request).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_999); });
    expect(client.request).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(client.request).toHaveBeenCalledTimes(4);
    expect(vi.mocked(client.request).mock.calls.every(([id, method, params, options]) =>
      ["one", "two"].includes(id) && method === "session.list" && JSON.stringify(params) === '{"includeArchived":false}'
      && options?.signal instanceof AbortSignal)).toBe(true);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    expect(client.listHostProfiles).not.toHaveBeenCalled();
  });

  it("commits each host independently while another host hangs", async () => {
    const client = makeClient();
    const slow = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockImplementation(id => id === "one" ? slow.promise : Promise.resolve([session("fast")]));
    const { result } = renderHook(() => useActiveSessionSnapshots(client, hosts, true));
    await flush();
    expect(result.current.snapshots.get("one")?.loading).toBe(true);
    expect(result.current.snapshots.get("two")).toEqual({ sessions: [session("fast")], loading: false });
    expect(result.current.refreshing).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(vi.mocked(client.request).mock.calls.filter(([id]) => id === "one")).toHaveLength(1);
    expect(vi.mocked(client.request).mock.calls.filter(([id]) => id === "two")).toHaveLength(4);
    await act(async () => { slow.resolve([session("slow")]); });
    expect(result.current.snapshots.get("one")?.sessions).toEqual([session("slow")]);
    expect(result.current.refreshing).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(5); // Coalesced ticks have no trailing poll.
  });

  it("retains failed-host cached data, isolates errors and clears them on recovery without rejecting refresh", async () => {
    const client = makeClient();
    vi.mocked(client.request).mockImplementation(async id => [session(id)]);
    const { result } = renderHook(() => useActiveSessionSnapshots(client, hosts, true));
    await flush();
    vi.mocked(client.request).mockImplementation(async id => {
      if (id === "one") throw { code: "request_timeout", message: "Request timed out" };
      return [session("two-updated")];
    });
    await act(async () => { await expect(result.current.refresh(undefined, false)).resolves.toBeUndefined(); });
    expect(result.current.snapshots.get("one")).toEqual({
      sessions: [session("one")], loading: false, error: "Request timed out",
    });
    expect(result.current.snapshots.get("two")).toEqual({ sessions: [session("two-updated")], loading: false });
    vi.mocked(client.request).mockResolvedValue([session("recovered")]);
    await act(async () => { await result.current.refresh("one"); });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("recovered")], loading: false });
    expect(result.current.refreshing).toBe(false);
  });

  it("coalesces explicit refreshes into one awaited trailing read per host, but not global afterPending=false", async () => {
    const client = makeClient();
    const first = deferred<SessionSummary[]>(), next = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useActiveSessionSnapshots(client, hosts.slice(0, 1), true));
    let one!: Promise<void>, two!: Promise<void>, global!: Promise<void>;
    let oneDone = false, globalDone = false;
    act(() => {
      one = result.current.refresh("one");
      two = result.current.refresh("one");
      global = result.current.refresh(undefined, false);
      void one.then(() => { oneDone = true; });
      void global.then(() => { globalDone = true; });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(client.request).toHaveBeenCalledOnce();
    await act(async () => { first.resolve([session("before-mutation")]); });
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(result.current.snapshots.get("one")?.sessions).toEqual([session("before-mutation")]);
    expect(result.current.snapshots.get("one")?.loading).toBe(true);
    expect(globalDone).toBe(true);
    expect(oneDone).toBe(false);
    await act(async () => { next.resolve([session("after-mutation")]); await Promise.all([one, two, global]); });
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(oneDone).toBe(true);
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("after-mutation")], loading: false });
    expect(result.current.refreshing).toBe(false);
  });

  it("targets manual reads without touching peers, and skips disconnected or unknown hosts", async () => {
    const client = makeClient();
    const { result } = renderHook(() => useActiveSessionSnapshots(client, [...hosts, host("offline", "disconnected")], true));
    await flush();
    vi.mocked(client.request).mockClear();
    await act(async () => { await result.current.refresh("two"); await result.current.refresh("offline"); await result.current.refresh("missing"); });
    expect(client.request).toHaveBeenCalledOnce();
    expect(vi.mocked(client.request).mock.calls[0][0]).toBe("two");
  });

  it("pauses polling and pending work while preserving cache, then ignores old replies and finalizers after resuming", async () => {
    const client = makeClient();
    const old = deferred<SessionSummary[]>(), fresh = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockResolvedValueOnce([session("cached")]).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result, rerender } = renderHook(({ active }) => useActiveSessionSnapshots(client, hosts.slice(0, 1), active), {
      initialProps: { active: true },
    });
    await flush();
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh("one"); });
    const oldSignal = vi.mocked(client.request).mock.calls[1][3]?.signal;
    rerender({ active: false });
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("cached")], loading: false });
    expect(result.current.refreshing).toBe(false);
    await act(async () => { await refresh; await result.current.refresh(); await vi.advanceTimersByTimeAsync(30_000); });
    expect(client.request).toHaveBeenCalledTimes(2);
    rerender({ active: true });
    expect(client.request).toHaveBeenCalledTimes(3);
    await act(async () => { old.resolve([session("stale")]); });
    expect(result.current.snapshots.get("one")?.sessions).toEqual([session("cached")]);
    expect(result.current.refreshing).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(client.request).toHaveBeenCalledTimes(3); // Old finalizer did not unlock the fresh request.
    await act(async () => { fresh.resolve([session("fresh")]); });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("fresh")], loading: false });
  });

  it("does no reads when initially inactive, and refreshes connected cache on activation", async () => {
    const client = makeClient();
    const { result, rerender } = renderHook(({ active }) => useActiveSessionSnapshots(client, hosts, active), {
      initialProps: { active: false },
    });
    await act(async () => { await result.current.refresh(); await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.snapshots.size).toBe(0);
    expect(result.current.refreshing).toBe(false);
    expect(client.request).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it.each(["disconnection", "deletion"] as const)("drops %s cache and rejects late replies across same-ID reconnection without restarting peers", async kind => {
    const client = makeClient();
    const old = deferred<SessionSummary[]>(), fresh = deferred<SessionSummary[]>();
    let oneReads = 0;
    vi.mocked(client.request).mockImplementation(id => id === "two" ? Promise.resolve([session("peer")])
      : ++oneReads === 1 ? Promise.resolve([session("cached")]) : oneReads === 2 ? old.promise : fresh.promise);
    const { result, rerender } = renderHook(({ profiles }) => useActiveSessionSnapshots(client, profiles, true), {
      initialProps: { profiles: hosts },
    });
    await flush();
    let first!: Promise<void>, trailing!: Promise<void>;
    act(() => { first = result.current.refresh("one"); trailing = result.current.refresh("one"); });
    const oldSignal = vi.mocked(client.request).mock.calls[2][3]?.signal;
    rerender({ profiles: kind === "deletion" ? [hosts[1]] : [host("one", "disconnected"), hosts[1]] });
    expect(result.current.snapshots.has("one")).toBe(false);
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.refreshing).toBe(false);
    await act(async () => { await Promise.all([first, trailing]); });
    rerender({ profiles: hosts });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [], loading: true });
    await act(async () => { old.resolve([session("stale")]); });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [], loading: true });
    expect(result.current.refreshing).toBe(true);
    expect(vi.mocked(client.request).mock.calls.filter(([id]) => id === "two")).toHaveLength(1);
    await act(async () => { fresh.resolve([session("reconnected")]); });
    expect(result.current.snapshots.get("one")?.sessions).toEqual([session("reconnected")]);
    expect(client.request).toHaveBeenCalledTimes(4);
  });

  it("invalidates pending work and timers on unmount, resolving queued callers without late writes", async () => {
    const client = makeClient();
    const pending = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockReturnValue(pending.promise);
    const { result, unmount } = renderHook(() => useActiveSessionSnapshots(client, hosts.slice(0, 1), true));
    const refresh = result.current.refresh;
    const queued = refresh("one");
    const signal = vi.mocked(client.request).mock.calls[0][3]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { await queued; await refresh(); pending.reject(new Error("late failure")); await vi.advanceTimersByTimeAsync(30_000); });
    expect(client.request).toHaveBeenCalledOnce();
  });

  it("isolates client replacement from old responses, locks and cached data", async () => {
    const before = makeClient(), after = makeClient();
    const old = deferred<SessionSummary[]>(), fresh = deferred<SessionSummary[]>();
    vi.mocked(before.request).mockResolvedValueOnce([session("old-client")]).mockReturnValueOnce(old.promise);
    vi.mocked(after.request).mockReturnValue(fresh.promise);
    const { result, rerender } = renderHook(({ client }) => useActiveSessionSnapshots(client, hosts.slice(0, 1), true), {
      initialProps: { client: before },
    });
    await flush();
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.refresh(); });
    rerender({ client: after });
    expect(vi.mocked(before.request).mock.calls[1][3]?.signal?.aborted).toBe(true);
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [], loading: true });
    await act(async () => { await refresh; old.reject({ message: "old-client failure" }); await vi.advanceTimersByTimeAsync(5_000); });
    expect(after.request).toHaveBeenCalledOnce();
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [], loading: true });
    expect(result.current.refreshing).toBe(true);
    await act(async () => { fresh.resolve([session("new-client")]); });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("new-client")], loading: false });
  });

  it("is StrictMode-safe when initial cleanup is followed by a fresh request", async () => {
    const client = makeClient();
    const abandoned = deferred<SessionSummary[]>(), current = deferred<SessionSummary[]>();
    vi.mocked(client.request).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(current.promise);
    const { result } = renderHook(() => useActiveSessionSnapshots(client, hosts.slice(0, 1), true), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.request).mock.calls[0][3]?.signal?.aborted).toBe(true);
    await act(async () => { abandoned.resolve([session("abandoned")]); await vi.advanceTimersByTimeAsync(5_000); });
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [], loading: true });
    await act(async () => { current.resolve([session("current")]); });
    expect(result.current.snapshots.get("one")).toEqual({ sessions: [session("current")], loading: false });
    expect(result.current.refreshing).toBe(false);
  });
});
