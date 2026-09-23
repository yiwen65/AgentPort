// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRemoteSync,
  REMOTE_ATTENTION_FRESHNESS_MS,
  type RemoteSyncDeps,
} from "./remoteSync";
import type { AttentionCursor, RemoteAttentionEvent } from "./types";
import { RemoteRequestError } from "./errors";

function cursor(sequence: number, occurredAt: string): AttentionCursor {
  return { occurredAt, sessionId: `ses_${sequence}`, runOrdinal: 1, sequence };
}

function attentionEvent(
  sequence: number,
  occurredAt: string,
  kind = "turn_completed",
): RemoteAttentionEvent {
  return {
    sessionId: `ses_${sequence}`,
    runId: "run-1",
    kind,
    cursor: cursor(sequence, occurredAt),
  };
}

interface Harness {
  deps: RemoteSyncDeps;
  pollAttention: ReturnType<typeof vi.fn>;
  refreshProjects: ReturnType<typeof vi.fn>;
  refreshProjectsSoon: ReturnType<typeof vi.fn>;
  notifyAttention: ReturnType<typeof vi.fn>;
  setRequestHook: ReturnType<typeof vi.fn>;
  visibilityListeners: Array<() => void>;
  hidden: { value: boolean };
  now: { value: number };
}

function makeHarness(overrides: Partial<RemoteSyncDeps> = {}): Harness {
  const pollAttention = vi.fn().mockResolvedValue({ events: [], nextCursor: null });
  const refreshProjects = vi.fn().mockResolvedValue(true);
  const refreshProjectsSoon = vi.fn();
  const notifyAttention = vi.fn().mockResolvedValue(true);
  const setRequestHook = vi.fn();
  const visibilityListeners: Array<() => void> = [];
  const hidden = { value: false };
  const now = { value: Date.parse("2026-09-23T12:00:00Z") };
  const deps: RemoteSyncDeps = {
    backend: { pollAttention, setRequestHook },
    deviceId: "dev-1",
    deviceName: "buildbox",
    refreshProjects,
    refreshProjectsSoon,
    notifyAttention,
    isDocumentHidden: () => hidden.value,
    onVisibilityChange: (listener) => {
      visibilityListeners.push(listener);
      return () => {
        const index = visibilityListeners.indexOf(listener);
        if (index >= 0) visibilityListeners.splice(index, 1);
      };
    },
    now: () => now.value,
    pollIntervalMs: 5000,
    ...overrides,
  };
  return {
    deps,
    pollAttention,
    refreshProjects,
    refreshProjectsSoon,
    notifyAttention,
    setRequestHook,
    visibilityListeners,
    hidden,
    now,
  };
}

describe("remoteSync engine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks immediately on start and then on the poll cadence", async () => {
    const h = makeHarness();
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refreshProjects).toHaveBeenCalledTimes(1);
    expect(h.pollAttention).toHaveBeenCalledTimes(1);
    expect(h.pollAttention).toHaveBeenLastCalledWith(null, 100);

    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refreshProjects).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.refreshProjects).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it("pauses while hidden and ticks immediately when visible again", async () => {
    const h = makeHarness();
    h.hidden.value = true;
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    const initialCalls = h.refreshProjects.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(h.refreshProjects.mock.calls.length).toBe(initialCalls);

    h.hidden.value = false;
    h.visibilityListeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.refreshProjects.mock.calls.length).toBe(initialCalls + 1);
    sync.stop();
  });

  it("notifies only fresh attention events and advances the cursor", async () => {
    const h = makeHarness();
    const fresh = new Date(h.now.value - 5_000).toISOString();
    const stale = new Date(
      h.now.value - REMOTE_ATTENTION_FRESHNESS_MS - 5_000,
    ).toISOString();
    h.pollAttention
      .mockResolvedValueOnce({
        events: [attentionEvent(1, stale), attentionEvent(2, fresh, "approval_requested")],
        nextCursor: cursor(2, fresh),
      })
      .mockResolvedValue({ events: [], nextCursor: null });
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.notifyAttention).toHaveBeenCalledTimes(1);
    expect(h.notifyAttention).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_2", kind: "approval_requested" }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pollAttention).toHaveBeenLastCalledWith(cursor(2, fresh), 100);
    sync.stop();
  });

  it("keeps advancing the cursor when one notification fails", async () => {
    const h = makeHarness();
    const fresh = new Date(h.now.value - 1_000).toISOString();
    h.notifyAttention
      .mockRejectedValueOnce(new Error("send failed"))
      .mockResolvedValue(true);
    h.pollAttention.mockResolvedValueOnce({
      events: [attentionEvent(1, fresh), attentionEvent(2, fresh)],
      nextCursor: cursor(2, fresh),
    });
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.notifyAttention).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.pollAttention).toHaveBeenLastCalledWith(cursor(2, fresh), 100);
    sync.stop();
  });

  it("stops itself when the connection is gone", async () => {
    const h = makeHarness();
    h.pollAttention.mockRejectedValue(
      new RemoteRequestError("not_connected", "device dev-1 is not connected"),
    );
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync.isRunning()).toBe(false);
    const calls = h.refreshProjects.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.refreshProjects.mock.calls.length).toBe(calls);
  });

  it("treats successful mutations as refresh hints, coalesced", async () => {
    const h = makeHarness();
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    h.refreshProjectsSoon.mockClear();
    h.pollAttention.mockClear();

    sync.onRemoteRequest("session.stop", true);
    sync.onRemoteRequest("session.rename", true);
    expect(h.refreshProjectsSoon).toHaveBeenCalledTimes(2);
    // Attention poll is coalesced behind one delayed timer.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.pollAttention).toHaveBeenCalledTimes(1);

    // Skipped read methods and failed requests earn nothing.
    sync.onRemoteRequest("session.list", true);
    sync.onRemoteRequest("project.list", true);
    sync.onRemoteRequest("session.stop", false);
    expect(h.refreshProjectsSoon).toHaveBeenCalledTimes(2);
    sync.stop();
  });

  it("installs and clears the backend request hook", async () => {
    const h = makeHarness();
    const sync = createRemoteSync(h.deps);
    sync.start();
    expect(h.setRequestHook).toHaveBeenCalledWith(expect.any(Function));
    sync.stop();
    expect(h.setRequestHook).toHaveBeenLastCalledWith(null);
  });

  it("leaves no timers behind after stop", async () => {
    const h = makeHarness();
    const sync = createRemoteSync(h.deps);
    sync.start();
    await vi.advanceTimersByTimeAsync(0);
    sync.onRemoteRequest("session.stop", true);
    sync.stop();
    h.refreshProjectsSoon.mockClear();
    h.pollAttention.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.refreshProjectsSoon).not.toHaveBeenCalled();
    expect(h.pollAttention).not.toHaveBeenCalled();
    expect(h.visibilityListeners).toHaveLength(0);
  });
});
