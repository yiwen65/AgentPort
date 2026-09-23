// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSshDevice,
  deviceCommandError,
  deviceTargetSummary,
  getDevicesState,
  normalizeDeviceProfile,
  redeemPairing,
  refreshDevices,
  registerDeviceSwitchHandler,
  removeDevice,
  renameDevice,
  requestDeviceSwitch,
  resetDevicesStoreForTests,
  setDevicesInvokerForTests,
  testDeviceConnection,
  type DeviceProfile,
} from "./devicesStore";

const sshDevice: DeviceProfile = {
  id: "dev_ssh",
  name: "Linux box",
  transport: "ssh",
  hostname: "192.168.1.10",
  port: 22,
  username: "dev",
  createdAt: "2026-09-23T08:00:00Z",
  lastConnectedAt: null,
  lastError: null,
};

const relayDevice: DeviceProfile = {
  id: "dev_relay",
  name: "Office PC",
  transport: "relay",
  peer: { relayUrl: "wss://relay.example/v1/relay", publicKey: "pk", hostId: "host-1" },
  lastConnectedAt: "2026-09-23T09:30:00Z",
  lastError: null,
};

let invoker: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invoker = vi.fn();
  setDevicesInvokerForTests(invoker);
  resetDevicesStoreForTests();
  registerDeviceSwitchHandler(null);
});

describe("normalizeDeviceProfile", () => {
  it("accepts the flat wire shape", () => {
    const profile = normalizeDeviceProfile({
      id: "a",
      name: "A",
      transport: "ssh",
      hostname: "h",
      port: 2222,
      username: "u",
      lastConnectedAt: "2026-01-01T00:00:00Z",
    });
    expect(profile).toMatchObject({
      id: "a",
      transport: "ssh",
      hostname: "h",
      port: 2222,
      username: "u",
      lastConnectedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("accepts internally tagged and externally tagged enum shapes", () => {
    const internal = normalizeDeviceProfile({
      id: "a",
      name: "A",
      transport: { kind: "ssh", hostname: "h", port: 22, username: "u" },
    });
    expect(internal).toMatchObject({ transport: "ssh", hostname: "h", port: 22 });
    const external = normalizeDeviceProfile({
      id: "b",
      name: "B",
      transport: { relay: { peer: { relayUrl: "wss://r", publicKey: "p", hostId: "hid" } } },
    });
    expect(external.transport).toBe("relay");
    expect(external.peer?.hostId).toBe("hid");
  });

  it("tolerates snake_case and missing optional fields", () => {
    const profile = normalizeDeviceProfile({
      id: "a",
      name: "A",
      transport: "relay",
      peer: { relay_url: "wss://r", public_key: "p", host_id: "hid" },
      last_connected_at: "2026-01-01T00:00:00Z",
      last_error: "boom",
    });
    expect(profile.peer).toEqual({ relayUrl: "wss://r", publicKey: "p", hostId: "hid" });
    expect(profile.lastConnectedAt).toBe("2026-01-01T00:00:00Z");
    expect(profile.lastError).toBe("boom");
  });
});

describe("deviceTargetSummary", () => {
  it("summarizes ssh and relay targets", () => {
    expect(deviceTargetSummary(sshDevice)).toBe("dev@192.168.1.10");
    expect(deviceTargetSummary({ ...sshDevice, port: 2222 })).toBe("dev@192.168.1.10:2222");
    expect(deviceTargetSummary(relayDevice)).toBe("host-1 · wss://relay.example/v1/relay");
  });
});

describe("store actions", () => {
  it("refreshDevices populates state and clears loading", async () => {
    invoker.mockResolvedValueOnce([sshDevice, relayDevice]);
    const devices = await refreshDevices();
    expect(invoker).toHaveBeenCalledWith("device_list");
    expect(devices).toHaveLength(2);
    expect(getDevicesState()).toMatchObject({ loading: false, error: null });
    expect(getDevicesState().devices).toHaveLength(2);
  });

  it("refreshDevices records load errors without dropping known devices", async () => {
    invoker.mockResolvedValueOnce([sshDevice]);
    await refreshDevices();
    invoker.mockRejectedValueOnce(new Error("registry gone"));
    await expect(refreshDevices()).rejects.toThrow("registry gone");
    expect(getDevicesState().error).toBe("registry gone");
    expect(getDevicesState().devices).toHaveLength(1);
  });

  it("renameDevice invokes the command and patches local state", async () => {
    invoker.mockResolvedValueOnce([sshDevice]);
    await refreshDevices();
    invoker.mockResolvedValueOnce(undefined);
    await renameDevice("dev_ssh", "Renamed");
    expect(invoker).toHaveBeenCalledWith("device_rename", {
      deviceId: "dev_ssh",
      name: "Renamed",
    });
    expect(getDevicesState().devices?.[0].name).toBe("Renamed");
  });

  it("removeDevice threads deleteCredentials and drops test state", async () => {
    invoker.mockResolvedValueOnce([sshDevice, relayDevice]);
    await refreshDevices();
    invoker.mockResolvedValueOnce(undefined);
    await removeDevice("dev_relay", true);
    expect(invoker).toHaveBeenCalledWith("device_remove", {
      deviceId: "dev_relay",
      deleteCredentials: true,
    });
    expect(getDevicesState().devices?.map((d) => d.id)).toEqual(["dev_ssh"]);
  });
});

describe("testDeviceConnection", () => {
  it("measures a successful round trip and always disconnects", async () => {
    invoker.mockImplementation(async (command: string) => {
      if (command === "remote_connect") {
        return { deviceName: "Linux box", capabilities: [], protocolVersion: { major: 1, minor: 1 } };
      }
      return undefined;
    });
    const result = await testDeviceConnection("dev_ssh");
    expect(result.phase).toBe("ok");
    if (result.phase === "ok") {
      expect(result.deviceName).toBe("Linux box");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(invoker).toHaveBeenCalledWith("remote_disconnect", { deviceId: "dev_ssh" });
    expect(getDevicesState().testing.dev_ssh.phase).toBe("ok");
  });

  it("records structured failures and still disconnects", async () => {
    invoker.mockImplementation(async (command: string) => {
      if (command === "remote_connect") {
        throw { code: "auth_failed", message: "bad credentials" };
      }
      return undefined;
    });
    const result = await testDeviceConnection("dev_ssh");
    expect(result).toEqual({
      phase: "failed",
      error: { code: "auth_failed", message: "bad credentials" },
    });
    expect(invoker).toHaveBeenCalledWith("remote_disconnect", { deviceId: "dev_ssh" });
  });
});

describe("add flows", () => {
  it("redeemPairing returns the new device and refreshes the list", async () => {
    invoker.mockImplementation(async (command: string) => {
      if (command === "device_pair_redeem") return relayDevice;
      if (command === "device_list") return [relayDevice];
      throw new Error(`unexpected ${command}`);
    });
    const device = await redeemPairing('{"id":"inv"}', "Office");
    expect(invoker).toHaveBeenCalledWith("device_pair_redeem", {
      payload: '{"id":"inv"}',
      name: "Office",
    });
    expect(device.id).toBe("dev_relay");
    expect(getDevicesState().devices).toHaveLength(1);
  });

  it("addSshDevice posts the draft and refreshes", async () => {
    invoker.mockImplementation(async (command: string) => {
      if (command === "device_add_ssh") return sshDevice;
      if (command === "device_list") return [sshDevice];
      throw new Error(`unexpected ${command}`);
    });
    const draft = {
      name: "Linux box",
      hostname: "192.168.1.10",
      port: 22,
      username: "dev",
      auth: { kind: "password", password: "secret" } as const,
    };
    const device = await addSshDevice(draft);
    expect(invoker).toHaveBeenCalledWith("device_add_ssh", { draft });
    expect(device.transport).toBe("ssh");
  });
});

describe("requestDeviceSwitch", () => {
  it("tracks switching state around the registered handler", async () => {
    const seen: string[] = [];
    let release!: () => void;
    registerDeviceSwitchHandler((target) => {
      seen.push(target.kind === "remote" ? target.deviceId : "local");
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = requestDeviceSwitch({ kind: "local" });
    expect(getDevicesState().switchingTo).toBe("local");
    release();
    await pending;
    expect(seen).toEqual(["local"]);
    expect(getDevicesState().switchingTo).toBeNull();
    expect(getDevicesState().switchError).toBeNull();
  });

  it("surfaces handler failures and resets switching state", async () => {
    registerDeviceSwitchHandler(() => {
      throw { code: "connect_failed", message: "no route" };
    });
    await expect(
      requestDeviceSwitch({
        kind: "remote",
        deviceId: "dev_ssh",
        deviceName: "Linux box",
        capabilities: [],
      }),
    ).rejects.toBeTruthy();
    expect(getDevicesState().switchingTo).toBeNull();
    expect(getDevicesState().switchError).toBe("no route");
  });

  it("reports a clear error when no handler is registered", async () => {
    await expect(requestDeviceSwitch({ kind: "local" })).rejects.toThrow(
      "device switch handler is not registered yet",
    );
    expect(getDevicesState().switchError).toContain("not registered");
  });
});

describe("deviceCommandError", () => {
  it("prefers structured code/message and falls back gracefully", () => {
    expect(deviceCommandError({ code: "timeout", message: "slow" })).toEqual({
      code: "timeout",
      message: "slow",
    });
    expect(deviceCommandError(new Error("x")).code).toBe("device_error");
    expect(deviceCommandError("weird").message).toBe("weird");
  });
});
