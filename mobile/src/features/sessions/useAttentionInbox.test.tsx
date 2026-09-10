import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionInbox } from "./useAttentionInbox";
import type { RemoteClient, HostProfileSummary } from "../../protocol/remoteClient";
const hosts = ["one", "two"].map(id => ({ id, name: id, connectionState: "connected" })) as HostProfileSummary[];
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const makeClient = () => ({ request: vi.fn().mockResolvedValue({ events: [] }) }) as unknown as RemoteClient;
describe("bounded metadata notification reception", () => {
  it("renders a native error message instead of object coercion", async () => {
    const client = makeClient();
    vi.mocked(client.request).mockRejectedValue({ code: "request_timeout", message: "Request timed out" });
    const { result } = renderHook(() => useAttentionInbox(client, hosts.slice(0, 1), true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.error).toBe("Request timed out");
  });
  it("covers all connected hosts with idle backoff, no Session list polling and no hidden work", async () => {
    const client = makeClient();
    const { rerender } = renderHook(({ visible }) => useAttentionInbox(client, hosts, visible), { initialProps: { visible: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    const calls = vi.mocked(client.request).mock.calls;
    expect(calls.filter(([id]) => id === "one")).toHaveLength(4);
    expect(calls.filter(([id]) => id === "two")).toHaveLength(4);
    expect(calls.every(([, method]) => method === "attention.poll")).toBe(true);
    rerender({ visible: false }); vi.mocked(client.request).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(client.request).not.toHaveBeenCalled();
    rerender({ visible: true }); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(client.request).toHaveBeenCalledTimes(2);
  });
  it("does not overlap slow polls or commit responses after suspension", async () => {
    const client = makeClient(); let finish!: (value: unknown) => void;
    vi.mocked(client.request).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { rerender, result } = renderHook(({ visible }) => useAttentionInbox(client, hosts.slice(0, 1), visible), { initialProps: { visible: true } });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(client.request).toHaveBeenCalledOnce(); rerender({ visible: false });
    await act(async () => finish({ events: [{ sessionId: "s" }] }));
    expect(result.current.entries).toHaveLength(0);
  });
  it("keeps messages in the local inbox without system notification delivery", async () => {
    const client = makeClient();
    let seq = 0;
    vi.mocked(client.request).mockImplementation(async (_host, method) => {
      if (method === "session.list") return [{ id: "s", title: "Build" }];
      if (!seq++) return { events: [] };
      return { events: [{ sessionId: "s", runId: "r", kind: "turn_completed", cursor: { sessionId: "s", runOrdinal: 1, sequence: seq, occurredAt: "2026-09-08T00:00:00Z" } }] };
    });
    const { result } = renderHook(() => useAttentionInbox(client, hosts.slice(0, 1), true));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(result.current.entries[0].sequence).toBe(3);
    expect(result.current.error).toBe("");
  });
});
