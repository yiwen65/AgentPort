import { describe, expect, it, vi } from "vitest";
import { RemoteClient } from "./client";
import { RemoteRequestError } from "./errors";
import type { RemoteEventWire, RemoteHello, RemoteInvoker } from "./types";

const HELLO: RemoteHello = {
  protocolVersion: "1.1",
  capabilities: ["session.event_push", "terminal.geometry_v1"],
  deviceName: "linux-box",
};

function makeClient(overrides?: {
  invoker?: RemoteInvoker;
  onEvent?: (event: RemoteEventWire) => void;
  onStateChange?: (state: string) => void;
}) {
  const invoker: RemoteInvoker =
    overrides?.invoker ??
    vi.fn(async (command: string) => {
      if (command === "remote_connect") return HELLO;
      return undefined;
    });
  const events: RemoteEventWire[] = [];
  const channel = { onmessage: (_event: RemoteEventWire) => undefined };
  const client = new RemoteClient({
    deviceId: "dev-1",
    invoker,
    channelFactory: () => channel,
    onEvent: overrides?.onEvent ?? ((event) => events.push(event)),
    onStateChange: overrides?.onStateChange as never,
  });
  return { client, invoker, channel, events };
}

describe("RemoteClient connection state machine", () => {
  it("starts disconnected and connects through connecting to connected", async () => {
    const states: string[] = [];
    const { client } = makeClient({
      onStateChange: (state) => states.push(state),
    });
    expect(client.getState()).toBe("disconnected");
    const hello = await client.connect();
    expect(hello).toEqual(HELLO);
    expect(client.getState()).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("coalesces concurrent connect calls into one invoker round trip", async () => {
    let release!: (value: RemoteHello) => void;
    const invoker: RemoteInvoker = vi.fn(
      (command: string) =>
        new Promise((resolve) => {
          if (command === "remote_connect") release = () => resolve(HELLO);
          else resolve(undefined);
        }),
    );
    const { client } = makeClient({ invoker });
    const first = client.connect();
    const second = client.connect();
    expect(second).toBe(first);
    release(HELLO);
    await first;
    expect(invoker).toHaveBeenCalledTimes(2); // connect + subscribe
  });

  it("subscribes with a channel whose onmessage forwards to onEvent", async () => {
    const received: RemoteEventWire[] = [];
    const { client, invoker, channel } = makeClient({ onEvent: (e) => received.push(e) });
    await client.connect();
    const subscribeCall = (invoker as ReturnType<typeof vi.fn>).mock.calls.find(
      ([command]) => command === "remote_subscribe",
    );
    expect(subscribeCall).toBeDefined();
    expect(subscribeCall?.[1]).toMatchObject({ deviceId: "dev-1", channel });
    const wire: RemoteEventWire = {
      subscriptionId: "att-1",
      eventType: "heartbeat",
      cursor: { runId: "r", runOrdinal: 1, generation: 0, offset: 0, statusSequence: 0 },
      payload: {},
    };
    // The backend assigned its handler onto our channel.
    (channel as { onmessage: (e: RemoteEventWire) => void }).onmessage(wire);
    expect(received).toEqual([wire]);
  });

  it("addEventListener fans out to multiple listeners and unsubscribes safely mid-dispatch", async () => {
    const { client, channel } = makeClient({ onEvent: () => undefined });
    await client.connect();
    const first: RemoteEventWire[] = [];
    const second: RemoteEventWire[] = [];
    const wire: RemoteEventWire = {
      subscriptionId: "att-1",
      eventType: "heartbeat",
      cursor: { runId: "r", runOrdinal: 1, generation: 0, offset: 0, statusSequence: 0 },
      payload: {},
    };
    const offFirst = client.addEventListener((event) => {
      first.push(event);
      // Unsubscribing while an event is being dispatched must not skip or
      // disturb the remaining listeners of this same event.
      offFirst();
    });
    client.addEventListener((event) => second.push(event));
    const deliver = (channel as { onmessage: (e: RemoteEventWire) => void }).onmessage;
    deliver(wire);
    expect(first).toEqual([wire]);
    expect(second).toEqual([wire]);
    deliver(wire);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("marks failed when connect rejects and normalizes the error", async () => {
    const invoker: RemoteInvoker = vi.fn(async (command: string) => {
      if (command === "remote_connect") {
        throw { code: "auth_failed", message: "bad password" };
      }
      return undefined;
    });
    const { client } = makeClient({ invoker });
    await expect(client.connect()).rejects.toMatchObject({
      name: "RemoteRequestError",
      code: "auth_failed",
      message: "bad password",
    });
    expect(client.getState()).toBe("failed");
  });

  it("rejects requests while not connected", async () => {
    const { client } = makeClient();
    await expect(client.request("boot")).rejects.toMatchObject({
      code: "not_connected",
    });
  });

  it("passes method and params through remote_request once connected", async () => {
    const invoker: RemoteInvoker = vi.fn(async (command: string, args) => {
      if (command === "remote_connect") return HELLO;
      if (command === "remote_request") {
        expect(args).toEqual({
          deviceId: "dev-1",
          method: "project.list",
          params: { includeArchived: false },
        });
        return [{ id: "prj_1" }];
      }
      return undefined;
    });
    const { client } = makeClient({ invoker });
    await client.connect();
    const value = await client.request("project.list", { includeArchived: false });
    expect(value).toEqual([{ id: "prj_1" }]);
  });

  it("normalizes string and structured request rejections", async () => {
    const invoker: RemoteInvoker = vi.fn(async (command: string) => {
      if (command === "remote_connect") return HELLO;
      if (command === "remote_request") throw "plain failure";
      return undefined;
    });
    const { client } = makeClient({ invoker });
    await client.connect();
    await expect(client.request("boot")).rejects.toMatchObject({
      code: "remote_error",
      message: "plain failure",
    });
  });

  it("hasCapability reflects negotiated hello capabilities", async () => {
    const { client } = makeClient();
    expect(client.hasCapability("terminal.geometry_v1")).toBe(false);
    await client.connect();
    expect(client.hasCapability("terminal.geometry_v1")).toBe(true);
    expect(client.hasCapability("future.capability")).toBe(false);
  });

  it("disconnect resets state and hello", async () => {
    const { client } = makeClient();
    await client.connect();
    await client.disconnect();
    expect(client.getState()).toBe("disconnected");
    expect(client.getHello()).toBeNull();
    await expect(client.request("boot")).rejects.toBeInstanceOf(RemoteRequestError);
  });
});
