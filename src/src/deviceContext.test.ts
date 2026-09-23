// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_DEVICE_STORAGE_KEY,
  activeDeviceContext,
  deviceKey,
  deviceStoragePrefix,
  isDeviceScopedStorageKey,
  isRemote,
  LOCAL_DEVICE_CONTEXT,
  resetDeviceContextForTests,
  scopedStorageKey,
  setDeviceContext,
  type DeviceContext,
} from "./deviceContext";

const REMOTE_A: DeviceContext = {
  kind: "remote",
  deviceId: "dev-a",
  deviceName: "Box A",
  capabilities: ["session.event_push"],
};

afterEach(() => {
  resetDeviceContextForTests();
  window.localStorage.clear();
});

describe("deviceContext", () => {
  it("defaults to the local device", () => {
    expect(activeDeviceContext()).toEqual(LOCAL_DEVICE_CONTEXT);
    expect(isRemote(activeDeviceContext())).toBe(false);
  });

  it("scopes keys only for remote devices; local keys stay byte-identical", () => {
    expect(deviceKey(LOCAL_DEVICE_CONTEXT, "agentport-terminal-layout")).toBe(
      "agentport-terminal-layout",
    );
    expect(deviceKey(REMOTE_A, "agentport-terminal-layout")).toBe(
      "agentport:device:dev-a:agentport-terminal-layout",
    );
    expect(deviceStoragePrefix(LOCAL_DEVICE_CONTEXT)).toBe("");
    expect(deviceStoragePrefix(REMOTE_A)).toBe("agentport:device:dev-a:");
  });

  it("scopes snapshot-style keys with their full legacy base", () => {
    expect(deviceKey(REMOTE_A, "agentport:terminal-snapshot:v2:s1")).toBe(
      "agentport:device:dev-a:agentport:terminal-snapshot:v2:s1",
    );
  });

  it("recognizes device-scoped keys but never plain local keys", () => {
    expect(isDeviceScopedStorageKey("agentport:device:dev-a:x")).toBe(true);
    expect(isDeviceScopedStorageKey("agentport-terminal-layout")).toBe(false);
    expect(isDeviceScopedStorageKey("agentport:terminal-snapshot:v1:s")).toBe(false);
  });

  it("setDeviceContext swaps the synchronous context and persists the id", () => {
    setDeviceContext(REMOTE_A);
    expect(activeDeviceContext()).toEqual(REMOTE_A);
    expect(window.localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY)).toBe("dev-a");
    expect(scopedStorageKey("agentport-active-session-id")).toBe(
      "agentport:device:dev-a:agentport-active-session-id",
    );
    setDeviceContext(LOCAL_DEVICE_CONTEXT);
    expect(window.localStorage.getItem(ACTIVE_DEVICE_STORAGE_KEY)).toBe("local");
    expect(scopedStorageKey("agentport-active-session-id")).toBe(
      "agentport-active-session-id",
    );
  });

  it("reads the persisted device id at module load", async () => {
    window.localStorage.setItem(ACTIVE_DEVICE_STORAGE_KEY, "dev-persisted");
    vi.resetModules();
    const fresh = await import("./deviceContext");
    expect(fresh.activeDeviceContext()).toEqual({
      kind: "remote",
      deviceId: "dev-persisted",
      deviceName: "dev-persisted",
      capabilities: [],
    });
  });
});
