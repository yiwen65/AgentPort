import { describe, expect, it, vi } from "vitest";
import { recoverConnection } from "./connectionRecovery";
import type { RemoteClient } from "./remoteClient";

describe("connection recovery", () => {
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
