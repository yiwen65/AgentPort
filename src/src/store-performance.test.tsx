// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import {
  applyProjectsSnapshot,
  emptyRuntime,
  getState,
  patchRuntime,
  setState,
  subscribe,
  useStore,
} from "./store";
import { pruneHandles } from "./terminals";
import type { ProjectView, SessionView } from "./types";

afterEach(cleanup);

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "ses_1",
    projectId: "prj_1",
    worktreeId: null,
    title: "Session",
    adapter: "shell",
    cwd: "/tmp/project",
    lifecycle: "running",
    agentSessionId: null,
    resumePrecision: "unavailable",
    permissionMode: "native",
    transport: "pty",
    unread: false,
    status: null,
    pinnedAt: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function project(view: SessionView): ProjectView {
  return {
    id: "prj_1",
    name: "Project",
    rootPath: "/tmp/project",
    gitRootPath: null,
    pinned: false,
    sessions: [view],
    worktrees: [],
  };
}

it("does not re-render a selected slice for unrelated store updates", () => {
  let renders = 0;
  function ThemeSubscriber() {
    useStore((state) => state.themeEffective);
    renders += 1;
    return null;
  }

  setState({ themeEffective: "dark", announcement: "" });
  render(<ThemeSubscriber />);
  for (let i = 0; i < 100; i += 1) {
    act(() => setState({ announcement: `tick-${i}` }));
  }

  expect(renders).toBe(1);
});

it("reuses the aggregate suspension index for unrelated runtime patches", () => {
  setState({
    runtime: {
      active: { ...emptyRuntime(), suspended: false },
      suspended: { ...emptyRuntime(), suspended: true },
    },
  });

  const initial = getState().suspendedSessionIds;
  expect([...initial]).toEqual(["suspended"]);

  patchRuntime("active", { logBytes: 42 });
  expect(getState().suspendedSessionIds).toBe(initial);

  patchRuntime("active", { suspended: true });
  const promoted = getState().suspendedSessionIds;
  expect(promoted).not.toBe(initial);
  expect([...promoted].sort()).toEqual(["active", "suspended"]);

  patchRuntime("active", { logBytes: 43, suspended: true });
  expect(getState().suspendedSessionIds).toBe(promoted);

  patchRuntime("suspended", { suspended: false });
  expect([...getState().suspendedSessionIds]).toEqual(["active"]);
});

it("does not emit for an empty patch or an identical runtime patch", () => {
  setState({
    runtime: { active: { ...emptyRuntime(), logBytes: 7 } },
    suspendedSessionIds: new Set(),
  });
  let emits = 0;
  const unsubscribe = subscribe(() => {
    emits += 1;
  });

  setState({});
  patchRuntime("active", { logBytes: 7 });

  unsubscribe();
  expect(emits).toBe(0);
});

it("preserves project and session identity when a poll returns equal data", () => {
  applyProjectsSnapshot([project(session())]);
  const firstProjects = getState().projects;
  const firstSession = firstProjects[0].sessions[0];
  let emits = 0;
  const unsubscribe = subscribe(() => {
    emits += 1;
  });

  applyProjectsSnapshot([project(session())]);

  unsubscribe();
  expect(emits).toBe(0);
  expect(getState().projects).toBe(firstProjects);
  expect(getState().projects[0].sessions[0]).toBe(firstSession);
});

it("only replaces the session that actually changed in a poll", () => {
  applyProjectsSnapshot([
    project(session()),
    {
      ...project(session({ id: "ses_2", title: "Second" })),
      id: "prj_2",
      sessions: [session({ id: "ses_2", projectId: "prj_2", title: "Second" })],
    },
  ]);
  const before = getState().projects;
  applyProjectsSnapshot([
    project(session()),
    {
      ...project(session({ id: "ses_2", title: "Second" })),
      id: "prj_2",
      sessions: [session({ id: "ses_2", projectId: "prj_2", title: "Renamed" })],
    },
  ]);

  expect(getState().projects[0]).toBe(before[0]);
  expect(getState().projects[1]).not.toBe(before[1]);
  expect(getState().projects[1].sessions[0].title).toBe("Renamed");
});

it("does not emit when pruneHandles has no attachments to release", () => {
  setState({ projects: [project(session())], attachedIds: [] });
  let emits = 0;
  const unsubscribe = subscribe(() => {
    emits += 1;
  });

  pruneHandles();

  unsubscribe();
  expect(emits).toBe(0);
});
