// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  listSupportedAgents: vi.fn(),
  probeAgent: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
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
  vi.useFakeTimers();
  resetRemoteAdapterCacheForTests();
  resetRemoteAdapterFillForTests();
  setActiveDevice({
    kind: "remote",
    deviceId: "dev_1",
    deviceName: "Box",
    capabilities: [],
  });
  setState({ adapters: [] });
  apiMock.listSupportedAgents.mockResolvedValue([
    { agent: "claude", displayName: "Claude", commandNames: ["claude"] },
    { agent: "pi", displayName: "Pi", commandNames: ["pi"] },
  ]);
  apiMock.probeAgent.mockImplementation(async (agent: string) => ({
    agent,
    displayName: agent,
    state: agent === "claude" ? "available" : "unavailable",
    reason: null,
    reasonCode: null,
    reasonDetail: null,
    install: agent === "claude" ? claude : null,
    candidates: [],
  }));
});

afterEach(() => {
  vi.useRealTimers();
  setActiveDevice(LOCAL_DEVICE_CONTEXT);
  resetRemoteAdapterCacheForTests();
  resetRemoteAdapterFillForTests();
});

it("fills agents one at a time instead of issuing a blocking probe-all", async () => {
  refreshActiveRemoteAdaptersIfStale();

  await vi.advanceTimersByTimeAsync(0);
  expect(apiMock.probeAgent).toHaveBeenCalledTimes(1);
  expect(apiMock.probeAgent).toHaveBeenLastCalledWith("claude", null);
  expect(getState().adapters).toEqual([claude]);

  await vi.advanceTimersByTimeAsync(250);
  expect(apiMock.probeAgent).toHaveBeenCalledTimes(2);
  expect(apiMock.probeAgent).toHaveBeenLastCalledWith("pi", null);

  await vi.advanceTimersByTimeAsync(250);
  expect(apiMock.probeAgent).toHaveBeenCalledTimes(2);
  expect(getState().adapters).toEqual([claude]);
  expect(cachedRemoteAdapters("dev_1")).toEqual([claude]);
});

it("reuses cached confirmed paths when probing", async () => {
  rememberRemoteAdapters("dev_1", [claude]);

  refreshActiveRemoteAdaptersIfStale(-1);
  await vi.advanceTimersByTimeAsync(0);

  expect(apiMock.probeAgent).toHaveBeenLastCalledWith(
    "claude",
    "/usr/bin/claude",
  );
  await vi.advanceTimersByTimeAsync(600);
});

it("does nothing while the cached adapter list is fresh", async () => {
  rememberRemoteAdapters("dev_1", [claude]);

  refreshActiveRemoteAdaptersIfStale();
  await vi.advanceTimersByTimeAsync(0);

  expect(apiMock.listSupportedAgents).not.toHaveBeenCalled();
  expect(apiMock.probeAgent).not.toHaveBeenCalled();
});
