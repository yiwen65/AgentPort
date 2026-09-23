// Attachment event routing: subscription stream → per-attachment ChannelMsg
// consumers (T-007 remote terminal attach). New desktop code.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteBackend } from "./backend";
import type { RemoteClient } from "./client";
import type { ChannelMsg } from "../types";
import type { RemoteEventWire } from "./types";

type EventListener = (event: RemoteEventWire) => void;

const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();

function makeHarness() {
  const listeners = new Set<EventListener>();
  const client = {
    request,
    hasCapability: () => true,
    deviceId: "dev-1",
    markFailed: vi.fn(),
    addEventListener: vi.fn((listener: EventListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as RemoteClient;
  const backend = new RemoteBackend(client);
  const emit = (event: RemoteEventWire) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { backend, client, emit };
}

function attachResult(attachmentId = "att-1", sessionId = "ses_1") {
  return {
    attachmentId,
    sessionId,
    childAlive: true,
    agentSessionId: null,
    cursor: null,
    features: [],
    runId: "run-1",
    runOrdinal: 1,
    terminalGeometry: null,
  };
}

function outputEvent(
  subscriptionId: string,
  data: string,
  offset: number,
): RemoteEventWire {
  return {
    subscriptionId,
    eventType: "output",
    cursor: {
      runId: "run-1",
      runOrdinal: 1,
      generation: 1,
      offset: offset + data.length,
      statusSequence: 0,
    },
    payload: {
      data,
      offset,
      cursor: {
        runId: "run-1",
        runOrdinal: 1,
        generation: 1,
        offset: offset + data.length,
        statusSequence: 0,
      },
    },
  };
}

beforeEach(() => {
  request.mockReset();
});

describe("remote attachment event routing", () => {
  it("wires the attach channel and delivers converted ChannelMsg in stream order", async () => {
    request.mockResolvedValueOnce(attachResult());
    const { backend, emit } = makeHarness();
    const received: ChannelMsg[] = [];
    const channel = { onmessage: (msg: ChannelMsg) => received.push(msg) };

    await backend.attachSession("ses_1", 4096, channel);
    emit(outputEvent("att-1", "aGVsbG8=", 0));
    emit({
      subscriptionId: "att-1",
      eventType: "replay_done",
      cursor: {
        runId: "run-1",
        runOrdinal: 1,
        generation: 1,
        offset: 5,
        statusSequence: 0,
      },
      payload: { offset: 5 },
    });

    expect(received.map((msg) => msg.t)).toEqual(["output", "replay_done"]);
    expect(received[0]).toMatchObject({ data: "aGVsbG8=", offset: 0 });
  });

  it("buffers pre-registration events and flushes them in order on wiring", async () => {
    request.mockResolvedValueOnce(attachResult());
    const { backend, emit } = makeHarness();
    // Events race ahead of the attach invoke resolution (no listener yet).
    emit(outputEvent("att-1", "Zmlyc3Q=", 0));
    emit(outputEvent("att-1", "c2Vjb25k", 5));

    const received: ChannelMsg[] = [];
    await backend.attachSession("ses_1", 4096, {
      onmessage: (msg) => received.push(msg),
    });

    expect(received.map((msg) => (msg.t === "output" ? msg.offset : msg.t))).toEqual([
      0, 5,
    ]);
  });

  it("keeps buffering for an attachment that never registers, bounded", async () => {
    const { backend, emit } = makeHarness();
    for (let index = 0; index < 4100; index += 1) {
      emit(outputEvent("att-never", "eA==", index));
    }
    const received: ChannelMsg[] = [];
    backend.registerAttachmentListener("att-never", (msg) => received.push(msg));
    expect(received).toHaveLength(4096);
  });

  it("detachSession unregisters the listener even when the request fails", async () => {
    request.mockResolvedValueOnce(attachResult());
    const { backend, emit } = makeHarness();
    const received: ChannelMsg[] = [];
    await backend.attachSession("ses_1", 4096, {
      onmessage: (msg) => received.push(msg),
    });
    request.mockRejectedValueOnce(new Error("already gone"));
    await expect(backend.detachSession("ses_1", "att-1")).rejects.toThrow(
      "already gone",
    );
    emit(outputEvent("att-1", "bGF0ZQ==", 0));
    expect(received).toHaveLength(0);
    expect(backend.attachmentIdFor("ses_1")).toBeNull();
  });

  it("transport_closed marks the client failed and detaches every attachment", async () => {
    request
      .mockResolvedValueOnce(attachResult("att-1", "ses_1"))
      .mockResolvedValueOnce(attachResult("att-2", "ses_2"));
    const { backend, client, emit } = makeHarness();
    const first: ChannelMsg[] = [];
    const second: ChannelMsg[] = [];
    await backend.attachSession("ses_1", 4096, {
      onmessage: (msg) => first.push(msg),
    });
    await backend.attachSession("ses_2", 4096, {
      onmessage: (msg) => second.push(msg),
    });
    // A buffered event for an unregistered attachment must not survive.
    emit(outputEvent("att-pending", "eA==", 0));

    emit({
      subscriptionId: "",
      eventType: "transport_closed",
      cursor: null as unknown as RemoteEventWire["cursor"],
      payload: { reason: "ssh channel EOF" },
    });

    expect(client.markFailed).toHaveBeenCalledTimes(1);
    expect(first).toEqual([
      { t: "detached", code: "transport_closed", message: "ssh channel EOF" },
    ]);
    expect(second).toEqual(first);
    // Listeners are gone: later frames reach nobody and are not buffered.
    emit(outputEvent("att-1", "bGF0ZQ==", 0));
    expect(first).toHaveLength(1);
  });

  it("ignores control events the local watch_loop also ignores", async () => {
    request.mockResolvedValueOnce(attachResult());
    const { backend, emit } = makeHarness();
    const received: ChannelMsg[] = [];
    await backend.attachSession("ses_1", 4096, {
      onmessage: (msg) => received.push(msg),
    });
    emit({
      subscriptionId: "att-1",
      eventType: "input_batch_ack",
      cursor: null as unknown as RemoteEventWire["cursor"],
      payload: { batchId: "web-dev-1-1" },
    });
    emit({
      subscriptionId: "att-1",
      eventType: "pong",
      cursor: null as unknown as RemoteEventWire["cursor"],
      payload: {},
    });
    expect(received).toHaveLength(0);
  });

  it("routes resize_ack and geometry events with the string attachmentId intact", async () => {
    request.mockResolvedValueOnce(attachResult());
    const { backend, emit } = makeHarness();
    const received: ChannelMsg[] = [];
    await backend.attachSession("ses_1", 4096, {
      onmessage: (msg) => received.push(msg),
    });
    const geometry = {
      runId: "run-1",
      runOrdinal: 1,
      cols: 120,
      rows: 40,
      sourceKind: "desktop" as const,
      revision: 3,
      updatedAt: "2026-09-23T00:00:00Z",
    };
    emit({
      subscriptionId: "att-1",
      eventType: "resize_ack",
      cursor: null as unknown as RemoteEventWire["cursor"],
      payload: { session_id: "ses_1", accepted: true, geometry, reason: null },
    });
    emit({
      subscriptionId: "att-1",
      eventType: "terminal_geometry_changed",
      cursor: null as unknown as RemoteEventWire["cursor"],
      payload: { session_id: "ses_1", geometry },
    });
    expect(received).toHaveLength(2);
    const ack = received[0] as Extract<ChannelMsg, { t: "resize_ack" }>;
    expect(ack.payload.attachmentId).toBe("att-1");
    const changed = received[1] as Extract<
      ChannelMsg,
      { t: "terminal_geometry_changed" }
    >;
    expect(changed.payload.attachmentId).toBe("att-1");
  });
});
