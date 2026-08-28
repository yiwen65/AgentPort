// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const STORAGE_KEY = "agentport-collapsed-project-ids";

afterEach(() => {
  window.localStorage.clear();
});

it("restores collapsed Projects when the frontend store starts again", async () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["project-b"]));
  vi.resetModules();

  const { getState } = await import("./store");

  expect(getState().expandedProjects).toEqual({ "project-b": false });
  expect(getState().expandedProjects["new-project"]).toBeUndefined();
});

it("ignores malformed persisted expansion state", async () => {
  window.localStorage.setItem(STORAGE_KEY, "not-json");
  vi.resetModules();

  const { getState } = await import("./store");

  expect(getState().expandedProjects).toEqual({});
});

it("reclaims obsolete terminal snapshots when quota blocks persistence", async () => {
  const legacySnapshotKey = "agentport:terminal-snapshot:v1:stale-session";
  window.localStorage.setItem(legacySnapshotKey, "x".repeat(4_999_950));
  vi.resetModules();

  const { persistProjectExpansion } = await import("./store");
  persistProjectExpansion({ "project-a": false, "project-b": false });

  expect(window.localStorage.getItem(legacySnapshotKey)).toBeNull();
  expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual([
    "project-a",
    "project-b",
  ]);
});
