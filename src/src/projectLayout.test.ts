import { describe, expect, it } from "vitest";
import {
  moveProjectInLayout,
  projectDropTarget,
  projectLayoutEntries,
  sameProjectLayout,
  setProjectPinnedAtFront,
} from "./projectLayout";
import type { ProjectView } from "./types";

function project(id: string, pinned = false): ProjectView {
  return {
    id,
    name: id.toUpperCase(),
    rootPath: `/tmp/${id}`,
    gitRootPath: null,
    pinned,
    sessions: [],
    worktrees: [],
  };
}

function ids(projects: ProjectView[]) {
  return projects.map(({ id, pinned }) => `${id}:${pinned}`);
}

describe("Project layout", () => {
  it("moves forward and backward within one group", () => {
    const initial = [project("a"), project("b"), project("c")];

    expect(
      ids(moveProjectInLayout(initial, "c", { pinned: false, index: 0 })),
    ).toEqual(["c:false", "a:false", "b:false"]);
    expect(
      ids(moveProjectInLayout(initial, "a", { pinned: false, index: 2 })),
    ).toEqual(["b:false", "c:false", "a:false"]);
  });

  it("moves across the pin boundary in both directions", () => {
    const initial = [project("a", true), project("b", true), project("c")];
    const pinned = moveProjectInLayout(initial, "c", {
      pinned: true,
      index: 1,
    });
    expect(ids(pinned)).toEqual(["a:true", "c:true", "b:true"]);

    const unpinned = moveProjectInLayout(pinned, "a", {
      pinned: false,
      index: 0,
    });
    expect(ids(unpinned)).toEqual(["c:true", "b:true", "a:false"]);
  });

  it("places menu pin and unpin actions first in the destination group", () => {
    const initial = [project("a", true), project("b"), project("c")];
    expect(ids(setProjectPinnedAtFront(initial, "c", true))).toEqual([
      "c:true",
      "a:true",
      "b:false",
    ]);
    expect(ids(setProjectPinnedAtFront(initial, "a", false))).toEqual([
      "a:false",
      "b:false",
      "c:false",
    ]);
  });

  it("clamps destination indexes and preserves a no-op layout", () => {
    const initial = [project("a", true), project("b")];
    expect(
      moveProjectInLayout(initial, "a", { pinned: true, index: -10 }),
    ).toBe(initial);
    expect(
      ids(moveProjectInLayout(initial, "b", { pinned: false, index: 99 })),
    ).toEqual(["a:true", "b:false"]);
    expect(
      moveProjectInLayout(initial, "missing", { pinned: false, index: 0 }),
    ).toBe(initial);
  });

  it("uses the closest header half on each side of the pin boundary", () => {
    const initial = [project("a", true), project("b"), project("c")];
    const midpoints = new Map([
      ["a", 40],
      ["b", 100],
    ]);

    expect(projectDropTarget(initial, "c", midpoints, 60)).toEqual({
      pinned: true,
      index: 1,
    });
    expect(projectDropTarget(initial, "c", midpoints, 80)).toEqual({
      pinned: false,
      index: 0,
    });
  });

  it("keeps a sole member in its current pin group near its own header", () => {
    const initial = [project("a", true), project("b")];
    const midpoints = new Map([
      ["a", 40],
      ["b", 100],
    ]);

    expect(projectDropTarget(initial, "a", midpoints, 45)).toEqual({
      pinned: true,
      index: 0,
    });
    expect(projectDropTarget(initial, "b", midpoints, 95)).toEqual({
      pinned: false,
      index: 0,
    });
  });

  it("serializes the complete canonical layout", () => {
    const projects = [project("a", true), project("b")];
    expect(projectLayoutEntries(projects)).toEqual([
      { id: "a", pinned: true },
      { id: "b", pinned: false },
    ]);
    expect(
      sameProjectLayout(
        projects,
        projects.map((item) => ({ ...item })),
      ),
    ).toBe(true);
  });
});
