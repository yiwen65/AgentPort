// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { api } from "./api";
import { RemoteUnavailableError } from "./remote/errors";
import {
  resetRemoteBackendsForTests,
  setRemoteBackendFactoryForTests,
} from "./remote/runtime";
import {
  resetDeviceContextForTests,
  setDeviceContext,
} from "./deviceContext";

const REMOTE = {
  kind: "remote" as const,
  deviceId: "dev-x",
  deviceName: "Box X",
  capabilities: [],
};

afterEach(() => {
  invokeMock.mockClear();
  resetRemoteBackendsForTests();
  resetDeviceContextForTests();
  window.localStorage.clear();
});

describe("api remote routing (integration)", () => {
  it("keeps the local invoke path byte-identical under the local device", async () => {
    await api.listProjects("ses_1");
    expect(invokeMock).toHaveBeenCalledWith("list_projects", {
      activeSession: "ses_1",
    });
  });

  it("delegates remote-capable calls to the injected backend for the device", async () => {
    const listProjects = vi.fn().mockResolvedValue([{ id: "prj_remote" }]);
    setRemoteBackendFactoryForTests((deviceId) => {
      expect(deviceId).toBe("dev-x");
      return { listProjects } as never;
    });
    setDeviceContext(REMOTE);
    await expect(api.listProjects(null)).resolves.toEqual([
      { id: "prj_remote" },
    ]);
    expect(listProjects).toHaveBeenCalledWith(null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("settings stay local even under a remote device", async () => {
    setDeviceContext(REMOTE);
    await api.getSettings();
    expect(invokeMock).toHaveBeenCalledWith("get_settings");
  });

  it("surfaces RemoteUnavailableError as a rejection under a remote device", async () => {
    setRemoteBackendFactoryForTests(() => ({
      deleteDocumentEntry: () => {
        throw new RemoteUnavailableError("document.delete");
      },
    }) as never);
    setDeviceContext(REMOTE);
    await expect(api.deleteDocumentEntry("/tmp/a.md")).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("boot stays on the local command in this task (T-006 composes remote boot)", async () => {
    setDeviceContext(REMOTE);
    await api.boot();
    expect(invokeMock).toHaveBeenCalledWith("boot");
  });
});
