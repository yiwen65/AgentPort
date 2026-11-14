// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { connectMock, disconnectMock, markFailedMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  markFailedMock: vi.fn(),
}));

vi.mock("./remote/runtime", () => ({
  remoteBackendFor: () => ({
    client: {
      connect: connectMock,
      disconnect: disconnectMock,
      markFailed: markFailedMock,
    },
  }),
  dropRemoteBackend: vi.fn(),
  resetRemoteBackendsForTests: vi.fn(),
}));

import {
  CONNECTED_DEVICES_STORAGE_KEY,
  connectDevice,
  deviceConnectionFor,
  disconnectDevice,
  forgetDeviceConnection,
  getDeviceConnectionsState,
  isDeviceConnected,
  markDeviceDisconnected,
  resetDeviceConnectionsForTests,
  restoreExplicitConnections,
} from "./deviceConnections";

const hello = {
  protocolVersion: "1",
  capabilities: [],
  deviceName: "PC",
};

describe("deviceConnections", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    resetDeviceConnectionsForTests();
  });

  it("connects, remembers the explicit set and dedupes concurrent dials", async () => {
    connectMock.mockResolvedValue(hello);
    const [a, b] = await Promise.all([
      connectDevice("dev_a"),
      connectDevice("dev_a"),
    ]);
    expect(a).toEqual(hello);
    expect(b).toEqual(hello);
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(isDeviceConnected("dev_a")).toBe(true);
    expect(getDeviceConnectionsState().explicitDeviceIds).toEqual(["dev_a"]);
    expect(
      JSON.parse(localStorage.getItem(CONNECTED_DEVICES_STORAGE_KEY) ?? "[]"),
    ).toEqual(["dev_a"]);
  });

  it("keeps an error visible and does not auto-retry", async () => {
    connectMock.mockRejectedValue({ code: "auth_failed", message: "denied" });
    await expect(connectDevice("dev_a")).rejects.toBeDefined();
    expect(deviceConnectionFor("dev_a").phase).toBe("error");
    expect(deviceConnectionFor("dev_a").error).toBe("denied");
    expect(isDeviceConnected("dev_a")).toBe(false);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("disconnects explicitly and forgets the persisted set", async () => {
    connectMock.mockResolvedValue(hello);
    await connectDevice("dev_a");
    disconnectMock.mockResolvedValue(undefined);
    await disconnectDevice("dev_a");
    expect(deviceConnectionFor("dev_a").phase).toBe("disconnected");
    expect(getDeviceConnectionsState().explicitDeviceIds).toEqual([]);
    expect(localStorage.getItem(CONNECTED_DEVICES_STORAGE_KEY)).toBe("[]");
  });

  it("marks transport loss without erasing the explicit set", async () => {
    connectMock.mockResolvedValue(hello);
    await connectDevice("dev_a");
    disconnectMock.mockResolvedValue(undefined);
    markDeviceDisconnected("dev_a", "bridge_closed");
    expect(deviceConnectionFor("dev_a")).toMatchObject({
      phase: "error",
      error: "bridge_closed",
    });
    expect(getDeviceConnectionsState().explicitDeviceIds).toEqual(["dev_a"]);
  });

  it("restores only devices that still exist in the registry", async () => {
    localStorage.setItem(
      CONNECTED_DEVICES_STORAGE_KEY,
      JSON.stringify(["dev_a", "dev_gone"]),
    );
    resetDeviceConnectionsForTests(true);
    connectMock.mockResolvedValue(hello);
    await restoreExplicitConnections(new Set(["dev_a"]));
    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith();
    expect(getDeviceConnectionsState().explicitDeviceIds).toEqual(["dev_a"]);
  });

  it("forgets removed devices completely", async () => {
    connectMock.mockResolvedValue(hello);
    await connectDevice("dev_a");
    disconnectMock.mockResolvedValue(undefined);
    forgetDeviceConnection("dev_a");
    expect(deviceConnectionFor("dev_a").phase).toBe("disconnected");
    expect(getDeviceConnectionsState().explicitDeviceIds).toEqual([]);
  });

  it("treats the local device as always connected", () => {
    expect(isDeviceConnected("local")).toBe(true);
    expect(deviceConnectionFor("local").phase).toBe("connected");
  });
});
