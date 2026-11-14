import { describe, expect, it, vi } from "vitest";

const { localApiObject, routedApiObject, remoteBackend, remoteBackendForMock } =
  vi.hoisted(() => ({
    localApiObject: { surface: "localApi" },
    routedApiObject: { surface: "api" },
    remoteBackend: { surface: "remote" },
    remoteBackendForMock: vi.fn(),
  }));

vi.mock("./api", () => ({
  api: routedApiObject,
  localApi: localApiObject,
}));
vi.mock("./remote/runtime", () => ({
  remoteBackendFor: (deviceId: string) => {
    remoteBackendForMock(deviceId);
    return remoteBackend;
  },
}));

import { deviceSessionApiFor, deviceTerminalApiFor } from "./deviceApi";

describe("deviceApi", () => {
  it("routes local device calls to localApi and remote calls to that device's backend", () => {
    expect(deviceTerminalApiFor("local")).toBe(localApiObject);
    expect(deviceSessionApiFor("local")).toBe(localApiObject);

    expect(deviceTerminalApiFor("dev_b")).toBe(remoteBackend);
    expect(remoteBackendForMock).toHaveBeenCalledWith("dev_b");

    expect(deviceSessionApiFor("dev_b")).toBe(remoteBackend);
  });
});
