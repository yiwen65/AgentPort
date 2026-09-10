import { describe, expect, it, vi } from "vitest";
import { checkConnection, recoverConnection } from "./connectionRecovery";
import type { RemoteClient } from "./remoteClient";

describe("connection recovery", () => {
  it("coalesces concurrent probes only for the same client and host", async () => {
    const client = { request: vi.fn().mockResolvedValue({}) } as unknown as RemoteClient;
    const first = checkConnection(client, "host");
    expect(checkConnection(client, "host")).toBe(first);
    const other = checkConnection(client, "other");
    expect(other).not.toBe(first);
    expect(await first).toBe(true); expect(await other).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(2);
    await checkConnection(client, "host");
    expect(client.request).toHaveBeenCalledTimes(3);
  });
  it("coalesces the same host and releases a failed recovery for explicit retry", async () => {
    let release!: () => void;
    const client = {
      disconnect: vi.fn(() => new Promise<void>(resolve => { release = resolve; })),
      connect: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({}),
    } as unknown as RemoteClient;
    const first = recoverConnection(client, "host");
    expect(recoverConnection(client, "host")).toBe(first);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.connect).not.toHaveBeenCalled();
    release();
    await expect(first).rejects.toThrow("offline");
    const retry = recoverConnection(client, "host");
    release(); await retry;
    expect(client.disconnect).toHaveBeenCalledTimes(2);
    expect(client.connect).toHaveBeenCalledTimes(2);
  });
});
