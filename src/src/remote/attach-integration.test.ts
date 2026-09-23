// End-to-end remote attach wiring: api dispatch → RemoteBackend →
// subscription router → the SAME channel object the local attach path feeds.
// New desktop code (T-007).

import { describe, expect, it, vi } from "vitest";
import { createRoutedApi } from "./dispatch";
import { RemoteBackend } from "./backend";
import { RemoteClient } from "./client";
import type { ChannelMsg } from "../types";
import type { DeviceContext } from "../deviceContext";
import type { RemoteEventWire, RemoteHello, RemoteInvoker } from "./types";

const HELLO: RemoteHello = {
  protocolVersion: "1.1",
  capabilities: ["session.event_push", "terminal.geometry_v1"],
  deviceName: "linux-box",
};

const REMOTE: DeviceContext = {
  kind: "remote",
  deviceId: "dev-1",
  deviceName: "Remote Box",
  capabilities: HELLO.capabilities,
};

describe("remote attach through the routed api", () => {
  it("attaches, streams ChannelMsg, sends input with attachmentId+batchId, detaches", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const subscriptionChannel = {
      onmessage: (_event: RemoteEventWire) => undefined,
    };
    const invoker: RemoteInvoker = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        if (command === "remote_connect") return HELLO;
        if (command === "remote_subscribe") return undefined;
        if (command === "remote_request") {
          const method = args.method as string;
          const params = args.params;
          requests.push({ method, params });
          if (method === "session.attach") {
            return {
              attachmentId: "att-9",
              sessionId: "ses_1",
              childAlive: true,
              agentSessionId: null,
              cursor: null,
              features: [],
              runId: "run-1",
              runOrdinal: 1,
              terminalGeometry: null,
            };
          }
          return undefined;
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const client = new RemoteClient({
      deviceId: "dev-1",
      invoker,
      channelFactory: () => subscriptionChannel,
    });
    await client.connect();
    const backend = new RemoteBackend(client);
    const localAttach = vi.fn();
    const localDetach = vi.fn();
    const api = createRoutedApi(
      { attachSession: localAttach, detachSession: localDetach },
      { activeContext: () => REMOTE, backendFor: () => backend },
    );

    const received: ChannelMsg[] = [];
    const channel = { onmessage: (msg: ChannelMsg) => received.push(msg) };
    const info = await (api as unknown as {
      attachSession: (
        sessionId: string,
        replayTailBytes: number,
        channel: { onmessage: (msg: ChannelMsg) => void },
        resumeFrom: null,
        screenSnapshot: boolean,
      ) => Promise<{ attachmentId: number | string; remote?: boolean }>;
    }).attachSession("ses_1", 4096, channel, null, false);

    expect(localAttach).not.toHaveBeenCalled();
    expect(info.attachmentId).toBe("att-9");
    expect(info.remote).toBe(true);
    expect(requests[0]).toMatchObject({
      method: "session.attach",
      params: { sessionId: "ses_1", subscribeOutput: true },
    });

    // Events pushed by the transport reach the same channel the local
    // watch_loop would feed, already converted to ChannelMsg.
    const deliver = subscriptionChannel.onmessage;
    deliver({
      subscriptionId: "att-9",
      eventType: "output",
      cursor: { runId: "run-1", runOrdinal: 1, generation: 1, offset: 2, statusSequence: 0 },
      payload: {
        data: "aGk=",
        offset: 0,
        cursor: { runId: "run-1", runOrdinal: 1, generation: 1, offset: 2, statusSequence: 0 },
      },
    });
    deliver({
      subscriptionId: "att-9",
      eventType: "replay_done",
      cursor: { runId: "run-1", runOrdinal: 1, generation: 1, offset: 2, statusSequence: 0 },
      payload: { offset: 2 },
    });
    expect(received.map((msg) => msg.t)).toEqual(["output", "replay_done"]);

    await (backend as unknown as {
      sendInput: (sessionId: string, data: string) => Promise<void>;
    }).sendInput("ses_1", "a2V5cw==");
    expect(requests[requests.length - 1]).toMatchObject({
      method: "session.input",
      params: { attachmentId: "att-9", batchId: "web-dev-1-1", dataBase64: "a2V5cw==" },
    });

    await (api as unknown as {
      detachSession: (sessionId: string, attachmentId: number | string) => Promise<void>;
    }).detachSession("ses_1", info.attachmentId);
    expect(requests[requests.length - 1]).toMatchObject({
      method: "session.detach",
      params: { attachmentId: "att-9" },
    });
    deliver({
      subscriptionId: "att-9",
      eventType: "output",
      cursor: { runId: "run-1", runOrdinal: 1, generation: 1, offset: 4, statusSequence: 0 },
      payload: { data: "eA==", offset: 2 },
    });
    expect(received).toHaveLength(2);
  });
});
