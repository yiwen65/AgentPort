// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ setTheme: vi.fn() }));

import {
  activeDeviceContext,
  DEVICE_STORAGE_PREFIX,
  resetDeviceContextForTests,
  type DeviceContext,
} from "./deviceContext";
import {
  activeDeviceCapabilities,
  getState,
  isRemoteDevice,
  persistProjectExpansion,
  readPersistedProjectExpansion,
  setActiveDevice,
} from "./store";
import {
  persistTerminalLayouts,
  readPersistedTerminalWorkspace,
  TERMINAL_LAYOUT_STORAGE_KEY,
  type PaneLayout,
} from "./paneLayout";
import { legacySnapshotKey, snapshotKey } from "./terminals";
import {
  dismissGeometryRevision,
  readDismissedGeometryRevision,
} from "./terminalGeometryPrompt";
import { readLastSelectedSessionId } from "./actions";
import type { TerminalGeometry } from "./types";

const REMOTE_A: DeviceContext = {
  kind: "remote",
  deviceId: "dev-a",
  deviceName: "Box A",
  capabilities: ["session.event_push", "terminal.geometry_v1"],
};
const REMOTE_B: DeviceContext = {
  kind: "remote",
  deviceId: "dev-b",
  deviceName: "Box B",
  capabilities: [],
};

const COLLAPSED_KEY = "agentport-collapsed-project-ids";
const ACTIVE_SESSION_KEY = "agentport-active-session-id";

function scoped(deviceId: string, base: string): string {
  return `${DEVICE_STORAGE_PREFIX}${deviceId}:${base}`;
}

const SPLIT_LAYOUT: PaneLayout = {
  root: {
    type: "split",
    id: "split-1",
    direction: "right",
    ratio: 0.5,
    first: { type: "leaf", sessionId: "ses_a" },
    second: { type: "leaf", sessionId: "ses_b" },
  },
  focusedSessionId: "ses_a",
};

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDeviceContextForTests();
  setActiveDevice({ kind: "local" });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("store activeDevice", () => {
  it("starts on the local device", () => {
    expect(getState().activeDevice.kind).toBe("local");
    expect(isRemoteDevice(getState())).toBe(false);
    expect(activeDeviceCapabilities(getState())).toEqual([]);
  });

  it("setActiveDevice updates state, synchronous context and persistence", () => {
    setActiveDevice(REMOTE_A);
    expect(getState().activeDevice).toEqual(REMOTE_A);
    expect(activeDeviceContext()).toEqual(REMOTE_A);
    expect(isRemoteDevice(getState())).toBe(true);
    expect(activeDeviceCapabilities(getState())).toEqual([
      "session.event_push",
      "terminal.geometry_v1",
    ]);
    expect(window.localStorage.getItem("agentport-active-device-id")).toBe("dev-a");
  });
});

describe("per-device localStorage isolation", () => {
  it("collapsed-project ids are invisible across devices; local key byte-identical", () => {
    persistProjectExpansion({ prj_local: false });
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe(
      JSON.stringify(["prj_local"]),
    );
    expect(window.localStorage.getItem(scoped("dev-a", COLLAPSED_KEY))).toBeNull();

    setActiveDevice(REMOTE_A);
    expect(readPersistedProjectExpansion()).toEqual({});
    persistProjectExpansion({ prj_remote: false });
    expect(window.localStorage.getItem(scoped("dev-a", COLLAPSED_KEY))).toBe(
      JSON.stringify(["prj_remote"]),
    );
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe(
      JSON.stringify(["prj_local"]),
    );

    setActiveDevice(REMOTE_B);
    expect(readPersistedProjectExpansion()).toEqual({});

    setActiveDevice({ kind: "local" });
    expect(readPersistedProjectExpansion()).toEqual({ prj_local: false });
  });

  it("terminal layouts persist per device and never touch the local key", () => {
    setActiveDevice(REMOTE_A);
    expect(persistTerminalLayouts([SPLIT_LAYOUT], SPLIT_LAYOUT)).toBe(true);
    expect(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY)).toBeNull();
    const remoteRaw = window.localStorage.getItem(
      scoped("dev-a", TERMINAL_LAYOUT_STORAGE_KEY),
    );
    expect(remoteRaw).not.toBeNull();
    const workspace = readPersistedTerminalWorkspace();
    expect(workspace.activeLayout.focusedSessionId).toBe("ses_a");

    setActiveDevice({ kind: "local" });
    expect(readPersistedTerminalWorkspace().activeLayout.root).toBeNull();
  });

  it("terminal snapshot keys keep the legacy local form and prefix remotely", () => {
    expect(snapshotKey("ses_1")).toBe("agentport:terminal-snapshot:v2:ses_1");
    expect(legacySnapshotKey("ses_1")).toBe("agentport:terminal-snapshot:v1:ses_1");
    setActiveDevice(REMOTE_A);
    expect(snapshotKey("ses_1")).toBe(
      "agentport:device:dev-a:agentport:terminal-snapshot:v2:ses_1",
    );
    expect(legacySnapshotKey("ses_1")).toBe(
      "agentport:device:dev-a:agentport:terminal-snapshot:v1:ses_1",
    );
  });

  it("geometry-prompt dismissal is scoped per device (sessionStorage)", () => {
    const geometry = {
      revision: 3,
      runId: "run-1",
      sourceKind: "mobile",
      cols: 80,
      rows: 24,
    } as TerminalGeometry;
    setActiveDevice(REMOTE_A);
    dismissGeometryRevision("ses_1", geometry);
    expect(
      window.sessionStorage.getItem(
        scoped("dev-a", "agentport:phone-geometry-dismissed:v1:ses_1:run-1"),
      ),
    ).toBe("3");
    expect(readDismissedGeometryRevision("ses_1", geometry)).toBe(3);

    setActiveDevice({ kind: "local" });
    expect(readDismissedGeometryRevision("ses_1", geometry)).toBeNull();
    expect(
      window.sessionStorage.getItem(
        "agentport:phone-geometry-dismissed:v1:ses_1:run-1",
      ),
    ).toBeNull();
  });

  it("last-selected session id is scoped per device", () => {
    window.localStorage.setItem(ACTIVE_SESSION_KEY, "ses_local");
    expect(readLastSelectedSessionId()).toBe("ses_local");
    setActiveDevice(REMOTE_A);
    expect(readLastSelectedSessionId()).toBeNull();
    window.localStorage.setItem(scoped("dev-a", ACTIVE_SESSION_KEY), "ses_remote");
    expect(readLastSelectedSessionId()).toBe("ses_remote");
    setActiveDevice({ kind: "local" });
    expect(readLastSelectedSessionId()).toBe("ses_local");
  });

  it("v1 snapshot reclaim never touches another device's keys", () => {
    window.localStorage.setItem("agentport:terminal-snapshot:v1:stale", "x");
    window.localStorage.setItem(
      scoped("dev-a", "agentport:terminal-snapshot:v1:keep"),
      "y",
    );
    // Force the quota-retry path inside persistProjectExpansion.
    const original = Storage.prototype.setItem;
    let thrown = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (!thrown) {
        thrown = true;
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      original.call(this, key, value);
    });
    persistProjectExpansion({ prj_1: false });
    expect(window.localStorage.getItem("agentport:terminal-snapshot:v1:stale")).toBeNull();
    expect(
      window.localStorage.getItem(scoped("dev-a", "agentport:terminal-snapshot:v1:keep")),
    ).toBe("y");
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe(
      JSON.stringify(["prj_1"]),
    );
  });
});
