// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const backendMock = vi.hoisted(() => ({
  listCachedAdapterInstalls: vi.fn(),
}));
const runtimeMock = vi.hoisted(() => ({
  remoteBackendFor: vi.fn(),
}));

vi.mock("./remote/runtime", () => ({
  remoteBackendFor: runtimeMock.remoteBackendFor,
}));

import { LOCAL_DEVICE_CONTEXT } from "./deviceContext";
import {
  cachedRemoteAdapters,
  rememberRemoteAdapters,
  resetRemoteAdapterCacheForTests,
} from "./remoteAdapterCache";
import {
  refreshActiveRemoteAdaptersIfStale,
  resetRemoteAdapterFillForTests,
} from "./remoteAdapterFill";
import { getState, setActiveDevice, setState } from "./store";
import type { AdapterInstall } from "./types";

const claude: AdapterInstall = {
  agentType: "claude",
  executablePath: "/usr/bin/claude",
  versionText: "1.0",
  capabilityHash: "h",
  exactResume: true,
  hookStatus: "supported",
  approvalModel: "native_prompts",
  defaultTransport: "pty",
  probedAt: "2026-11-15T00:00:00.000Z",
  candidates: [],
  flags: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAdapterCacheForTests();
  resetRemoteAdapterFillForTests();
  runtimeMock.remoteBackendFor.mockReturnValue(backendMock);
  backendMock.listCachedAdapterInstalls.mockResolvedValue([claude]);
  setActiveDevice({
    kind: "remote",
    deviceId: "dev_1",
    deviceName: "Box",
    capabilities: [],
  });
  setState({ adapters: [] });
});

afterEach(() => {
  setActiveDevice(LOCAL_DEVICE_CONTEXT);
  resetRemoteAdapterCacheForTests();
  resetRemoteAdapterFillForTests();
});

it("fills adapters from the Host cache without running probes", async () => {
  refreshActiveRemoteAdaptersIfStale();

  await vi.waitFor(() => expect(getState().adapters).toEqual([claude]));
  expect(backendMock.listCachedAdapterInstalls).toHaveBeenCalledTimes(1);
  expect(cachedRemoteAdapters("dev_1")).toEqual([claude]);
});

it("caches an empty Host adapter list instead of leaving another device's list", async () => {
  setState({ adapters: [claude] });
  backendMock.listCachedAdapterInstalls.mockResolvedValueOnce([]);

  refreshActiveRemoteAdaptersIfStale();
  await vi.waitFor(() =>
    expect(backendMock.listCachedAdapterInstalls).toHaveBeenCalledTimes(1),
  );
  await Promise.resolve();

  expect(getState().adapters).toEqual([]);
  expect(cachedRemoteAdapters("dev_1")).toEqual([]);
});

it("does nothing while the cached adapter list is fresh", async () => {
  rememberRemoteAdapters("dev_1", [claude]);

  refreshActiveRemoteAdaptersIfStale();
  await Promise.resolve();

  expect(runtimeMock.remoteBackendFor).not.toHaveBeenCalled();
});
