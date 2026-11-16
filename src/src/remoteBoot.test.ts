// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
}));

vi.mock("./api", () => ({
  api: apiMock,
  errorText: (error: unknown) => String(error),
}));

import type { RemoteBackend } from "./remote/backend";
import {
  cacheLocalBootBase,
  composeRemoteBoot,
  resetLocalBootBaseForTests,
} from "./remoteBoot";
import {
  rememberRemoteAdapters,
  remoteAdaptersStale,
  resetRemoteAdapterCacheForTests,
} from "./remoteAdapterCache";
import type { AdapterInstall, BootInfo, ProjectView, Settings } from "./types";

const settings: Settings = {
  logLimitMib: 100,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "dark",
  terminalTheme: "one",
  terminalFontFamily: "monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: [],
  agentHidden: [],
  telemetryEnabled: false,
};

const localProject: ProjectView = {
  id: "prj_local",
  name: "Local",
  rootPath: "/tmp/local",
  gitRootPath: null,
  pinned: false,
  sessions: [],
  worktrees: [],
};

const localBoot: BootInfo = {
  platform: {
    os: "macos",
    osVersion: "26.0",
    arch: "aarch64",
    webview: "wkwebview",
    appVersion: "0.1.2",
    windowDecorated: true,
  },
  settings,
  adapters: [],
  projects: [localProject],
  timeline: { completed: 0, waiting: 0, failed: 0, entries: [], ackSnapshots: [] },
  timelineError: null,
  timelineMessage: null,
  secretBackend: "Keychain",
  indexState: "native_on_demand",
  webview: "system",
  exportsDir: "/tmp/exports",
};

const remoteAdapter: AdapterInstall = {
  agentType: "pi",
  executablePath: "/usr/bin/pi",
  versionText: "1.0",
  capabilityHash: "h",
  exactResume: true,
  hookStatus: "supported",
  approvalModel: "native_prompts",
  defaultTransport: "pty",
  probedAt: "2026-09-23T00:00:00.000Z",
  candidates: [],
  flags: [],
};

function makeBackend(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const track = <T>(name: string, value: T): T => {
    calls.push(name);
    return value;
  };
  const backend = {
    boot: vi.fn(async () => track("boot", { reconciledSessions: 0 })),
    probeAgents: vi.fn(async () =>
      track("probeAgents", [{ install: remoteAdapter }, { install: null }]),
    ),
    listProjects: vi.fn(async () => track("listProjects", [localProject])),
    getTimeline: vi.fn(async () =>
      track("getTimeline", {
        completed: 1,
        waiting: 0,
        failed: 0,
        entries: [],
        ackSnapshots: [],
      }),
    ),
    secretStatus: vi.fn(async () => track("secretStatus", "RemoteKeyring")),
    ...overrides,
  };
  return { backend: backend as unknown as RemoteBackend, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLocalBootBaseForTests();
  resetRemoteAdapterCacheForTests();
  apiMock.getSettings.mockResolvedValue(settings);
});

describe("composeRemoteBoot", () => {
  it("throws before any local boot cached the local base", async () => {
    const { backend } = makeBackend();
    await expect(composeRemoteBoot(backend)).rejects.toThrow(/local boot/);
  });

  it("composes remote data slices without blocking on agent probes", async () => {
    cacheLocalBootBase(localBoot);
    const { backend } = makeBackend();
    const info = await composeRemoteBoot(backend, {
      deviceId: "dev_1",
    });
    expect(info.platform).toEqual(localBoot.platform);
    expect(info.webview).toBe("system");
    expect(info.exportsDir).toBe("/tmp/exports");
    expect(info.settings).toEqual(settings);
    expect(apiMock.getSettings).toHaveBeenCalledTimes(1);
    expect(info.adapters).toEqual([]);
    expect(backend.probeAgents).not.toHaveBeenCalled();
    expect(info.projects.map((p) => p.id)).toEqual(["prj_local"]);
    expect(info.timeline.completed).toBe(1);
    expect(info.timelineError).toBeNull();
    expect(info.timelineMessage).toBeNull();
    expect(info.secretBackend).toBe("RemoteKeyring");
    expect(info.indexState).toBe("native_on_demand");
  });

  it("tracks remote adapter freshness for on-demand rechecks", () => {
    expect(remoteAdaptersStale("dev_1", 60_000)).toBe(true);
    rememberRemoteAdapters("dev_1", [remoteAdapter]);
    expect(remoteAdaptersStale("dev_1", 60_000)).toBe(false);
    expect(remoteAdaptersStale("dev_2", 60_000)).toBe(true);
  });

  it("prefers the last successful device probe over the fallback list", async () => {
    cacheLocalBootBase(localBoot);
    rememberRemoteAdapters("dev_1", [
      { ...remoteAdapter, executablePath: "/opt/remote/pi" },
    ]);
    const { backend } = makeBackend();
    const info = await composeRemoteBoot(backend, {
      deviceId: "dev_1",
    });
    expect(info.adapters.map((adapter) => adapter.executablePath)).toEqual([
      "/opt/remote/pi",
    ]);
    expect(backend.probeAgents).not.toHaveBeenCalled();
  });

  it("does not lend the local boot's adapters to an unknown remote", async () => {
    cacheLocalBootBase({ ...localBoot, adapters: [remoteAdapter] });
    const { backend } = makeBackend();
    const info = await composeRemoteBoot(backend, { deviceId: "dev_unknown" });
    expect(info.adapters).toEqual([]);
  });

  it("runs the server-side reconcile before composing slices", async () => {
    cacheLocalBootBase(localBoot);
    const { backend, calls } = makeBackend();
    await composeRemoteBoot(backend);
    expect(calls[0]).toBe("boot");
  });

  it("degrades a timeline failure to an empty timeline plus timelineError", async () => {
    cacheLocalBootBase(localBoot);
    const { backend } = makeBackend({
      getTimeline: vi.fn(async () => {
        throw new Error("timeline offline");
      }),
    });
    const info = await composeRemoteBoot(backend);
    expect(info.timeline).toEqual({
      completed: 0,
      waiting: 0,
      failed: 0,
      entries: [],
      ackSnapshots: [],
    });
    expect(info.timelineError).toContain("timeline offline");
  });
});
