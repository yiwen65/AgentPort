// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRouteFor, createRoutedApi } from "./dispatch";
import { RemoteUnavailableError } from "./errors";
import { ROUTING } from "./backend";
import {
  LOCAL_DEVICE_CONTEXT,
  type DeviceContext,
} from "../deviceContext";

const REMOTE: DeviceContext = {
  kind: "remote",
  deviceId: "dev-1",
  deviceName: "Remote Box",
  capabilities: [],
};

let context: DeviceContext = LOCAL_DEVICE_CONTEXT;

function makeHarness() {
  const localFn = vi.fn().mockResolvedValue("local-result");
  const remoteFn = vi.fn().mockResolvedValue("remote-result");
  const localApi = {
    listProjects: localFn,
    getSettings: vi.fn().mockResolvedValue("local-settings"),
  };
  const backend = { listProjects: remoteFn };
  const api = createRoutedApi(localApi, {
    activeContext: () => context,
    backendFor: (deviceId) => {
      expect(deviceId).toBe("dev-1");
      return backend;
    },
  });
  return { api, localFn, remoteFn, localApi };
}

afterEach(() => {
  context = LOCAL_DEVICE_CONTEXT;
});

describe("apiRouteFor", () => {
  it("classifies every ROUTING entry exactly once", () => {
    for (const name of ROUTING.localOnly) {
      expect(apiRouteFor(name), name).toBe("localOnly");
    }
    for (const name of ROUTING.remoteUnavailable) {
      expect(apiRouteFor(name), name).toBe("remoteRouted");
    }
    for (const name of ROUTING.remoteCapable) {
      // boot is forced local until T-006 composes the remote boot; it falls
      // out of REMOTE_ROUTED and lands on the default-local path.
      expect(apiRouteFor(name), name).toBe(
        name === "boot" ? "defaultLocal" : "remoteRouted",
      );
    }
  });

  it("defaults unknown members to local (forward-compatible)", () => {
    expect(apiRouteFor("someFutureCommand")).toBe("defaultLocal");
    expect(apiRouteFor("boot")).toBe("defaultLocal");
  });
});

describe("createRoutedApi", () => {
  it("passes local calls through under the local device", async () => {
    const { api, localFn, remoteFn } = makeHarness();
    await expect(api.listProjects("ses_1")).resolves.toBe("local-result");
    expect(localFn).toHaveBeenCalledWith("ses_1");
    expect(remoteFn).not.toHaveBeenCalled();
  });

  it("delegates remote-capable calls to the active device backend", async () => {
    context = REMOTE;
    const { api, localFn, remoteFn } = makeHarness();
    await expect(api.listProjects("ses_2")).resolves.toBe("remote-result");
    expect(remoteFn).toHaveBeenCalledWith("ses_2");
    expect(localFn).not.toHaveBeenCalled();
  });

  it("keeps localOnly members local even under a remote device", async () => {
    context = REMOTE;
    const { api, localApi } = makeHarness();
    await expect(api.getSettings()).resolves.toBe("local-settings");
    expect(localApi.getSettings).toHaveBeenCalled();
  });

  it("returns local members by identity (no wrapper) in both modes", () => {
    const { api, localApi } = makeHarness();
    expect(api.getSettings).toBe(localApi.getSettings);
    context = REMOTE;
    expect(api.getSettings).toBe(localApi.getSettings);
  });

  it("normalizes a synchronous backend throw into a rejection", async () => {
    context = REMOTE;
    const localApi = { renameDocumentEntry: vi.fn() };
    const backend = {
      renameDocumentEntry: () => {
        throw new RemoteUnavailableError("document.rename");
      },
    };
    const api = createRoutedApi(localApi, {
      activeContext: () => context,
      backendFor: () => backend,
    });
    await expect(api.renameDocumentEntry()).rejects.toBeInstanceOf(
      RemoteUnavailableError,
    );
    expect(localApi.renameDocumentEntry).not.toHaveBeenCalled();
  });

  it("rejects cleanly when the backend lacks the member", async () => {
    context = REMOTE;
    const api = createRoutedApi(
      { listProjects: vi.fn() },
      { activeContext: () => context, backendFor: () => ({}) },
    );
    await expect(api.listProjects(null)).rejects.toThrow(
      "remote backend does not implement listProjects",
    );
  });

  it("returns test spies by identity so vi.mocked keeps working", async () => {
    const { api } = makeHarness();
    const spy = vi.spyOn(api, "listProjects").mockResolvedValue("spied");
    expect(api.listProjects).toBe(spy);
    vi.mocked(api.listProjects).mockReturnValueOnce(Promise.resolve("once"));
    await expect(api.listProjects("ses_9")).resolves.toBe("once");
    await expect(api.listProjects("ses_9")).resolves.toBe("spied");
    expect(spy).toHaveBeenCalledWith("ses_9");
    spy.mockRestore();
  });
});
