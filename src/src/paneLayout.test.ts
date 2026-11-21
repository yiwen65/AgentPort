// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPLIT_RATIO,
  MAX_PANE_LAYOUT_DEPTH,
  buildGridPlacement,
  buildGridPlacementForSessions,
  chooseGridShape,
  chooseSplitPlacement,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  PANE_GROUP_EXPANSION_STORAGE_KEY,
  TERMINAL_LAYOUT_STORAGE_KEY,
  TERMINAL_LAYOUT_VERSION,
  emptyPaneLayout,
  assignPaneGroupAccent,
  clampPaneSplitRatio,
  focusPane,
  layoutContains,
  movePane,
  orderedLayoutSessionIds,
  paneLeaf,
  paneLayoutFitsSize,
  paneMinimumSize,
  paneSessionSize,
  normalizePaneGroupAccents,
  paneGroupIdentity,
  persistPaneGroupExpansion,
  persistTerminalLayout,
  persistTerminalLayouts,
  prunePaneLayout,
  readPersistedPaneGroupExpansion,
  readPersistedTerminalLayout,
  readPersistedTerminalWorkspace,
  removePane,
  sanitizePaneLayout,
  singletonPaneLayout,
  splitPane,
  updateSplitRatio,
} from "./paneLayout";
import type { PaneLayout, PaneLayoutNode, PaneSplit } from "./paneLayout";
import type { ProjectView, SessionView } from "./types";

function rootSplit(layout: PaneLayout): PaneSplit {
  if (layout.root?.type !== "split") throw new Error("expected a split root");
  return layout.root;
}

function collectSplitIds(node: PaneLayoutNode | null): string[] {
  if (!node || node.type === "leaf") return [];
  return [node.id, ...collectSplitIds(node.first), ...collectSplitIds(node.second)];
}

function nodeDepth(node: PaneLayoutNode | null): number {
  if (!node || node.type === "leaf") return 0;
  return 1 + Math.max(nodeDepth(node.first), nodeDepth(node.second));
}

function session(
  id: string,
  transport: SessionView["transport"] = "pty",
): SessionView {
  return {
    id,
    projectId: "prj_1",
    worktreeId: null,
    title: id,
    adapter: transport === "pty" ? "shell" : "pi",
    cwd: "/tmp/project",
    lifecycle: "running",
    agentSessionId: null,
    resumePrecision: "unavailable",
    permissionMode: "native",
    transport,
    unread: false,
    status: null,
    pinnedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
  };
}

function projectWith(...sessions: SessionView[]): ProjectView[] {
  return [{
    id: "prj_1",
    name: "Project",
    rootPath: "/tmp/project",
    gitRootPath: null,
    pinned: false,
    sessions,
    worktrees: [],
  }];
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("pane layout transforms", () => {
  it("defines the pane size and initial split contract", () => {
    expect({ width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT }).toEqual({
      width: 320,
      height: 180,
    });

    const initial = singletonPaneLayout("a");
    const split = splitPane(initial, "a", "b", "right", "split-outer");

    expect(split).toEqual({
      root: {
        type: "split",
        id: "split-outer",
        direction: "right",
        ratio: DEFAULT_SPLIT_RATIO,
        first: { type: "leaf", sessionId: "a" },
        second: { type: "leaf", sessionId: "b" },
      },
      focusedSessionId: "b",
    });
    expect(layoutContains(split, "a")).toBe(true);
    expect(layoutContains(split, "missing")).toBe(false);
    expect(orderedLayoutSessionIds(split)).toEqual(["a", "b"]);
  });

  it("places a dragged Session on each requested side", () => {
    for (const [direction, newPaneFirst] of [
      ["left", true],
      ["right", false],
      ["up", true],
      ["down", false],
    ] as const) {
      const split = splitPane(
        singletonPaneLayout("target"),
        "target",
        "dragged",
        direction,
        direction,
      );
      const root = rootSplit(split);
      expect(root.direction).toBe(direction);
      expect(root.first).toEqual(
        paneLeaf(newPaneFirst ? "dragged" : "target"),
      );
      expect(root.second).toEqual(
        paneLeaf(newPaneFirst ? "target" : "dragged"),
      );
    }
  });

  it("preserves existing split ids across nested splits", () => {
    const first = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "split-outer",
    );
    const nested = splitPane(first, "b", "c", "down", "split-inner");

    expect(collectSplitIds(nested.root)).toEqual(["split-outer", "split-inner"]);
    expect(orderedLayoutSessionIds(nested)).toEqual(["a", "b", "c"]);
    expect(rootSplit(nested).ratio).toBe(0.5);
  });

  it("moves an existing Session transactionally without making a duplicate", () => {
    let layout = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "split-outer",
    );
    layout = splitPane(layout, "b", "c", "down", "split-inner");

    const moved = movePane(layout, "a", "c", "down", "split-move");
    const ids = orderedLayoutSessionIds(moved);
    expect(ids).toEqual(["b", "c", "a"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(collectSplitIds(moved.root)).toEqual(["split-inner", "split-move"]);
    expect(moved.focusedSessionId).toBe("a");

    expect(splitPane(moved, "b", "a", "right", "duplicate")).toBe(moved);
    expect(movePane(moved, "a", "missing", "right", "missing")).toBe(moved);
  });

  it("keeps a direct placement stable and only changes focus", () => {
    const layout = focusPane(
      splitPane(singletonPaneLayout("a"), "a", "b", "right", "stable"),
      "a",
    );
    const focused = movePane(layout, "b", "a", "right", "replacement");

    expect(focused.root).toBe(layout.root);
    expect(collectSplitIds(focused.root)).toEqual(["stable"]);
    expect(focused.focusedSessionId).toBe("b");
  });

  it("keeps direct placements stable from either drop side", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      const layout = splitPane(
        singletonPaneLayout("target"),
        "target",
        "moving",
        direction,
        direction,
      );
      const focused = movePane(layout, "moving", "target", direction, "replacement");
      const inverseDirection =
        direction === "left"
          ? "right"
          : direction === "right"
            ? "left"
            : direction === "up"
              ? "down"
              : "up";
      const inverse = movePane(
        layout,
        "target",
        "moving",
        inverseDirection,
        "inverse",
      );

      expect(focused.root).toBe(layout.root);
      expect(focused.focusedSessionId).toBe("moving");
      expect(inverse.root).toBe(layout.root);
    }
  });

  it("focuses the closest edge of the sibling promoted by removal", () => {
    let layout = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "split-inner",
    );
    layout = splitPane(layout, "b", "c", "right", "split-b-c");
    // Rebuild this shape explicitly: ((a, b), c). The focused b is the
    // second child of the inner split, so removing it should promote/focus a.
    layout = {
      root: {
        type: "split",
        id: "split-outer",
        direction: "right",
        ratio: 0.5,
        first: {
          type: "split",
          id: "split-inner",
          direction: "right",
          ratio: 0.5,
          first: paneLeaf("a"),
          second: paneLeaf("b"),
        },
        second: paneLeaf("c"),
      },
      focusedSessionId: "b",
    };

    const removedMiddle = removePane(layout, "b");
    expect(orderedLayoutSessionIds(removedMiddle)).toEqual(["a", "c"]);
    expect(removedMiddle.focusedSessionId).toBe("a");
    expect(collectSplitIds(removedMiddle.root)).toEqual(["split-outer"]);

    const removedLast = removePane({ ...layout, focusedSessionId: "c" }, "c");
    expect(orderedLayoutSessionIds(removedLast)).toEqual(["a", "b"]);
    expect(removedLast.focusedSessionId).toBe("b");
    expect(collectSplitIds(removedLast.root)).toEqual(["split-inner"]);

    expect(removePane(removedLast, "missing")).toBe(removedLast);
    expect(removePane(singletonPaneLayout("a"), "a")).toEqual(emptyPaneLayout());
  });

  it("updates one ratio while preserving ids and rejects invalid ratios", () => {
    let layout = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "split-outer",
    );
    layout = splitPane(layout, "b", "c", "down", "split-inner");

    const resized = updateSplitRatio(layout, "split-inner", 0.72);
    expect(rootSplit(resized).ratio).toBe(0.5);
    expect(rootSplit(resized).second).toMatchObject({
      type: "split",
      id: "split-inner",
      ratio: 0.72,
    });
    expect(collectSplitIds(resized.root)).toEqual(["split-outer", "split-inner"]);
    expect(updateSplitRatio(resized, "split-inner", 0)).toBe(resized);
    expect(updateSplitRatio(resized, "split-inner", 1)).toBe(resized);
    expect(updateSplitRatio(resized, "split-inner", Number.NaN)).toBe(resized);
    expect(updateSplitRatio(resized, "missing", 0.4)).toBe(resized);
  });

  it("uses recursive subtree minimums when sizing and clamping dividers", () => {
    const left = rootSplit(
      splitPane(singletonPaneLayout("a"), "a", "b", "right", "left"),
    );
    const root: PaneSplit = {
      type: "split",
      id: "outer",
      direction: "right",
      ratio: 646 / 966,
      first: left,
      second: paneLeaf("c"),
    };

    expect(paneMinimumSize(root, 6)).toEqual({ width: 972, height: 180 });
    expect(paneSessionSize(root, "a", 972, 400, 6)).toEqual({
      width: 320,
      height: 400,
    });
    expect(paneSessionSize(root, "c", 972, 400, 6)).toEqual({
      width: 320,
      height: 400,
    });
    expect(paneLayoutFitsSize(root, 972, 400, 6)).toBe(true);
    expect(paneLayoutFitsSize({ ...root, ratio: 0.5 }, 972, 400, 6)).toBe(false);

    const roomy = 1_200 - 6;
    const low = clampPaneSplitRatio(root, 1_200, 0.1, 6);
    const high = clampPaneSplitRatio(root, 1_200, 0.95, 6);
    expect(low * roomy).toBeCloseTo(646);
    expect((1 - high) * roomy).toBeCloseTo(320);
    expect(clampPaneSplitRatio(root, 1_200, -1, 6)).toBeCloseTo(low);
    expect(clampPaneSplitRatio(root, 1_200, 2, 6)).toBeCloseTo(high);

    const skewedLeft: PaneSplit = { ...left, ratio: 0.65 };
    const skewedRoot: PaneSplit = { ...root, first: skewedLeft };
    const skewedFirstMinimum = 6 + Math.max(320 / 0.65, 320 / 0.35);
    const skewedLow = clampPaneSplitRatio(skewedRoot, 1_600, 0.1, 6);
    expect(skewedLow * (1_600 - 6)).toBeCloseTo(skewedFirstMinimum);

    // When the whole window is already below the aggregate minimum, freeze
    // the divider at the subtree-weighted ratio rather than shrinking one
    // branch disproportionately.
    expect(clampPaneSplitRatio(root, 900, 0.1, 6)).toBeCloseTo(646 / 966);
  });
});

describe("pane layout sanitization", () => {
  it("drops duplicate leaves and collapses invalid branches", () => {
    const duplicate = sanitizePaneLayout({
      root: {
        type: "split",
        id: "duplicate-session",
        direction: "right",
        ratio: 0.5,
        first: { type: "leaf", sessionId: "a" },
        second: { type: "leaf", sessionId: "a" },
      },
      focusedSessionId: "a",
    });
    expect(duplicate).toEqual(singletonPaneLayout("a"));

    const collapsed = sanitizePaneLayout({
      root: {
        type: "split",
        id: "invalid-child",
        direction: "down",
        ratio: 0.4,
        first: { type: "unknown" },
        second: { type: "leaf", sessionId: "b" },
      },
      focusedSessionId: "missing",
    });
    expect(collapsed).toEqual(singletonPaneLayout("b"));
  });

  it("repairs duplicate split ids and invalid split metadata", () => {
    const sanitized = sanitizePaneLayout({
      root: {
        type: "split",
        id: "same-id",
        direction: "sideways",
        ratio: 2,
        first: {
          type: "split",
          id: "same-id",
          direction: "down",
          ratio: 0.25,
          first: { type: "leaf", sessionId: "a" },
          second: { type: "leaf", sessionId: "b" },
        },
        second: { type: "leaf", sessionId: "c" },
      },
      focusedSessionId: "b",
    });

    const ids = collectSplitIds(sanitized.root);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rootSplit(sanitized)).toMatchObject({
      direction: "right",
      ratio: 0.5,
    });
    expect(sanitized.focusedSessionId).toBe("b");
  });

  it("preserves all four directions when sanitizing persisted layouts", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      const layout = sanitizePaneLayout({
        root: {
          type: "split",
          id: direction,
          direction,
          ratio: 0.5,
          first: paneLeaf("a"),
          second: paneLeaf("b"),
        },
        focusedSessionId: "b",
      });
      expect(rootSplit(layout).direction).toBe(direction);
    }
  });

  it("bounds hostile depth and cycles without losing every valid sibling", () => {
    let deep: unknown = { type: "leaf", sessionId: "too-deep" };
    for (let index = 0; index < MAX_PANE_LAYOUT_DEPTH + 5; index += 1) {
      deep = {
        type: "split",
        id: `deep-${index}`,
        direction: "down",
        ratio: 0.5,
        first: { type: "leaf", sessionId: `side-${index}` },
        second: deep,
      };
    }

    const bounded = sanitizePaneLayout({ root: deep, focusedSessionId: "too-deep" });
    expect(bounded.root).not.toBeNull();
    expect(nodeDepth(bounded.root)).toBeLessThanOrEqual(MAX_PANE_LAYOUT_DEPTH);
    expect(orderedLayoutSessionIds(bounded)).not.toContain("too-deep");
    expect(layoutContains(bounded, bounded.focusedSessionId ?? "")).toBe(true);

    const cyclic: Record<string, unknown> = {
      type: "split",
      id: "cycle",
      direction: "right",
      ratio: 0.5,
      first: { type: "leaf", sessionId: "safe" },
    };
    cyclic.second = cyclic;
    expect(sanitizePaneLayout({ root: cyclic, focusedSessionId: "safe" })).toEqual(
      singletonPaneLayout("safe"),
    );
  });

  it("prunes invalid Sessions with unary collapse and promoted-sibling focus", () => {
    const layout: PaneLayout = {
      root: {
        type: "split",
        id: "outer",
        direction: "right",
        ratio: 0.5,
        first: {
          type: "split",
          id: "inner",
          direction: "down",
          ratio: 0.4,
          first: paneLeaf("a"),
          second: paneLeaf("b"),
        },
        second: paneLeaf("c"),
      },
      focusedSessionId: "b",
    };

    const pruned = prunePaneLayout(layout, new Set(["a", "c"]));
    expect(orderedLayoutSessionIds(pruned)).toEqual(["a", "c"]);
    expect(pruned.focusedSessionId).toBe("a");
    expect(collectSplitIds(pruned.root)).toEqual(["outer"]);
    expect(prunePaneLayout(pruned, new Set(["a", "c"]))).toBe(pruned);
  });
});

describe("pane layout persistence", () => {
  it("persists split-group fold state by canonical membership", () => {
    const group = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "persisted-split",
    );
    const key = paneGroupIdentity(group);
    const sameGroup = { ...group, focusedSessionId: "b" };

    expect(paneGroupIdentity(sameGroup)).toBe(key);
    expect(persistPaneGroupExpansion({ [key]: false, stale: true })).toBe(true);
    expect(readPersistedPaneGroupExpansion()).toEqual({ [key]: false });

    window.localStorage.setItem(PANE_GROUP_EXPANSION_STORAGE_KEY, "not-json");
    expect(readPersistedPaneGroupExpansion()).toEqual({});
  });

  it("round-trips a versioned root, focus, ids, directions, and ratios", () => {
    let layout = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "down",
      "persisted-split",
    );
    layout = updateSplitRatio(layout, "persisted-split", 0.37);
    layout = focusPane(layout, "a");

    expect(persistTerminalLayout(layout)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY) ?? "null"))
      .toMatchObject({ version: TERMINAL_LAYOUT_VERSION });
    expect(readPersistedTerminalLayout()).toEqual({ ...layout, accent: "blue" });
  });

  it("degrades malformed, unknown-version, duplicate, and invalid data safely", () => {
    window.localStorage.setItem(TERMINAL_LAYOUT_STORAGE_KEY, "not-json");
    expect(readPersistedTerminalLayout()).toEqual(emptyPaneLayout());
    expect(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: TERMINAL_LAYOUT_VERSION + 1,
        root: { type: "leaf", sessionId: "a" },
        focusedSessionId: "a",
      }),
    );
    expect(readPersistedTerminalLayout()).toEqual(emptyPaneLayout());
    expect(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: TERMINAL_LAYOUT_VERSION,
        groups: [],
        activeLayout: {
          root: {
            type: "split",
            id: "corrupt",
            direction: "unknown",
            ratio: -1,
            first: { type: "leaf", sessionId: "a" },
            second: { type: "leaf", sessionId: "a" },
          },
          focusedSessionId: "missing",
        },
      }),
    );
    expect(readPersistedTerminalLayout()).toEqual(singletonPaneLayout("a"));
  });

  it("round-trips multiple disjoint split groups in activation order", () => {
    const first = splitPane(
      singletonPaneLayout("a"),
      "a",
      "b",
      "right",
      "first",
    );
    const second = splitPane(
      singletonPaneLayout("c"),
      "c",
      "d",
      "down",
      "second",
    );

    expect(persistTerminalLayouts([second, first], second)).toBe(true);
    const restored = readPersistedTerminalWorkspace();
    expect(restored.groups.map(orderedLayoutSessionIds)).toEqual([
      ["c", "d"],
      ["a", "b"],
    ]);
    expect(restored.groups.map((group) => group.accent)).toEqual([
      "blue",
      "violet",
    ]);
    expect(restored.activeLayout).toEqual({ ...second, accent: "blue" });
  });

  it("assigns distinct group accents and repairs persisted duplicates", () => {
    const first = splitPane(singletonPaneLayout("a"), "a", "b", "right", "first");
    const second = splitPane(singletonPaneLayout("c"), "c", "d", "down", "second");
    const third = splitPane(singletonPaneLayout("e"), "e", "f", "right", "third");

    expect(assignPaneGroupAccent(first, []).accent).toBe("blue");
    const withFirst = { ...first, accent: "blue" as const };
    expect(assignPaneGroupAccent(second, [withFirst]).accent).toBe("violet");

    const normalized = normalizePaneGroupAccents([
      withFirst,
      { ...second, accent: "blue" as const },
      third,
    ]);
    expect(normalized.changed).toBe(true);
    expect(normalized.groups.map((group) => group.accent)).toEqual([
      "blue",
      "violet",
      "teal",
    ]);

    const stable = normalizePaneGroupAccents(normalized.groups);
    expect(stable.changed).toBe(false);
    expect(normalizePaneGroupAccents([{ ...first, accent: "neon" as never }]).groups[0].accent)
      .toBe("blue");
  });

  it("migrates the previous single-layout persistence format", () => {
    window.localStorage.setItem(
      TERMINAL_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        root: {
          type: "split",
          id: "legacy",
          direction: "right",
          ratio: 0.5,
          first: { type: "leaf", sessionId: "a" },
          second: { type: "leaf", sessionId: "b" },
        },
        focusedSessionId: "b",
      }),
    );

    const restored = readPersistedTerminalWorkspace();
    expect(restored.groups.map(orderedLayoutSessionIds)).toEqual([["a", "b"]]);
    expect(orderedLayoutSessionIds(restored.activeLayout)).toEqual(["a", "b"]);
  });

  it("preserves a deliberately empty persisted workspace", () => {
    expect(persistTerminalLayout(emptyPaneLayout())).toBe(true);
    expect(readPersistedTerminalLayout()).toEqual(emptyPaneLayout());
    expect(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY)).not.toBeNull();
  });
});

describe("pane layout store reconciliation", () => {
  it("restores every persisted split group when the store initializes", async () => {
    const a = session("a");
    const b = session("b");
    const c = session("c");
    const d = session("d");
    const first = splitPane(
      singletonPaneLayout(a.id),
      a.id,
      b.id,
      "right",
      "first",
    );
    const second = splitPane(
      singletonPaneLayout(c.id),
      c.id,
      d.id,
      "down",
      "second",
    );
    expect(persistTerminalLayouts([second, first], second)).toBe(true);
    vi.resetModules();

    const store = await import("./store");
    store.applyProjectsSnapshot(projectWith(a, b, c, d));

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([
      c.id,
      d.id,
    ]);
    expect(store.getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [c.id, d.id],
      [a.id, b.id],
    ]);
  });

  it("restores focused active state and every layout PTY but no JSON-RPC Session", async () => {
    let persisted = splitPane(
      singletonPaneLayout("pty-a"),
      "pty-a",
      "rpc-b",
      "right",
      "outer",
    );
    persisted = splitPane(persisted, "rpc-b", "pty-c", "down", "middle");
    persisted = splitPane(persisted, "pty-c", "stale", "right", "stale-parent");
    expect(persistTerminalLayout(persisted)).toBe(true);
    vi.resetModules();

    const store = await import("./store");
    expect(store.getState().activeSessionId).toBe("stale");
    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([
      "pty-a",
      "rpc-b",
      "pty-c",
      "stale",
    ]);

    store.applyProjectsSnapshot(projectWith(
      session("pty-a"),
      session("rpc-b", "json_rpc"),
      session("pty-c"),
      session("outside"),
    ));

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([
      "pty-a",
      "rpc-b",
      "pty-c",
    ]);
    expect(store.getState().activeSessionId).toBe("pty-c");
    expect(store.getState().terminalLayout.focusedSessionId).toBe("pty-c");
    expect(store.getState().attachedIds).toEqual(["pty-a", "pty-c"]);
    expect(orderedLayoutSessionIds(readPersistedTerminalLayout())).toEqual([
      "pty-a",
      "rpc-b",
      "pty-c",
    ]);
  });

  it("keeps a remembered split while an outside Session is temporarily active", async () => {
    vi.resetModules();
    const store = await import("./store");
    const a = session("a");
    const b = session("b");
    const outside = session("outside");
    const terminalLayout = splitPane(
      singletonPaneLayout(a.id),
      a.id,
      b.id,
      "right",
      "remembered",
    );
    store.setState({
      projects: projectWith(a, b, outside),
      activeSessionId: outside.id,
      terminalLayout,
      attachedIds: [outside.id],
    });

    store.applyProjectsSnapshot(projectWith(a, b, outside));

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([
      outside.id,
    ]);
    expect(store.getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [a.id, b.id],
    ]);
    expect(store.getState().activeSessionId).toBe(outside.id);
    expect(store.getState().attachedIds).toEqual([outside.id]);
  });

  it("prunes remembered groups independently without dropping the others", async () => {
    vi.resetModules();
    const store = await import("./store");
    const a = session("a");
    const b = session("b");
    const c = session("c");
    const d = session("d");
    const first = splitPane(
      singletonPaneLayout(a.id),
      a.id,
      b.id,
      "right",
      "first",
    );
    const second = splitPane(
      singletonPaneLayout(c.id),
      c.id,
      d.id,
      "down",
      "second",
    );
    store.setState({
      projects: projectWith(a, b, c, d),
      activeSessionId: a.id,
      terminalLayout: first,
      terminalLayoutGroups: [first, second],
      attachedIds: [a.id, b.id],
    });

    store.applyProjectsSnapshot(projectWith(a, c, d));

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([a.id]);
    expect(store.getState().terminalLayoutGroups.map(orderedLayoutSessionIds)).toEqual([
      [c.id, d.id],
    ]);
    expect(store.getState().activeSessionId).toBe(a.id);
    expect(store.getState().attachedIds).toEqual([a.id]);
  });

  it("upgrades a valid legacy active Session to a singleton layout", async () => {
    vi.resetModules();
    const store = await import("./store");
    const legacy = session("legacy");
    store.setState({
      projects: projectWith(legacy),
      activeSessionId: legacy.id,
      attachedIds: [],
      terminalLayout: emptyPaneLayout(),
    });

    store.applyProjectsSnapshot(projectWith(legacy));

    expect(store.getState().terminalLayout).toEqual(singletonPaneLayout("legacy"));
    expect(store.getState().activeSessionId).toBe("legacy");
    expect(store.getState().attachedIds).toEqual(["legacy"]);
  });

  it("clears a removed leaf, collapses its parent, and restores sibling focus", async () => {
    vi.resetModules();
    const store = await import("./store");
    const a = session("a");
    const b = session("b");
    const c = session("c");
    const layout: PaneLayout = {
      root: {
        type: "split",
        id: "outer",
        direction: "right",
        ratio: 0.6,
        first: {
          type: "split",
          id: "inner",
          direction: "down",
          ratio: 0.4,
          first: paneLeaf("a"),
          second: paneLeaf("b"),
        },
        second: paneLeaf("c"),
      },
      focusedSessionId: "b",
    };
    store.setState({
      projects: projectWith(a, b, c),
      activeSessionId: "b",
      terminalLayout: layout,
      maximizedSessionId: "b",
      attachedIds: ["a", "b", "c"],
    });

    store.clearSessionScopedState("b");

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual(["a", "c"]);
    expect(collectSplitIds(store.getState().terminalLayout.root)).toEqual(["outer"]);
    expect(store.getState().activeSessionId).toBe("a");
    expect(store.getState().attachedIds).toEqual(["a", "c"]);
    expect(store.getState().maximizedSessionId).toBeNull();
  });
});

describe("optimal pane placement", () => {
  const workspace = { width: 1400, height: 900 };

  const gridAfter = (count: number) => {
    let layout = singletonPaneLayout("ses_1");
    for (let index = 2; index <= count; index += 1) {
      const rebuilt = buildGridPlacement(
        layout,
        `ses_${index}`,
        workspace.width,
        workspace.height,
        6,
      );
      expect(rebuilt).not.toBeNull();
      layout = { ...rebuilt!, focusedSessionId: `ses_${index}` };
    }
    return layout;
  };

  const sizesOf = (layout: PaneLayout) => {
    const root = layout.root;
    if (!root) return [];
    return orderedLayoutSessionIds(layout).map((id) =>
      paneSessionSize(root, id, workspace.width, workspace.height, 6),
    );
  };

  it("picks the most even grid shape for the pane count", () => {
    expect(chooseGridShape(1, workspace.width, workspace.height, 6)).toEqual({
      columns: 1,
      rows: 1,
    });
    expect(chooseGridShape(2, workspace.width, workspace.height, 6)).toEqual({
      columns: 2,
      rows: 1,
    });
    expect(chooseGridShape(4, workspace.width, workspace.height, 6)).toEqual({
      columns: 2,
      rows: 2,
    });
    expect(chooseGridShape(9, workspace.width, workspace.height, 6)).toEqual({
      columns: 3,
      rows: 3,
    });
  });

  it("adds several delegated Agents in one balanced grid rebuild", () => {
    const layout = buildGridPlacementForSessions(
      singletonPaneLayout("ses_1"),
      ["ses_2", "ses_3", "ses_3"],
      workspace.width,
      workspace.height,
      6,
    );
    expect(layout).not.toBeNull();
    expect(orderedLayoutSessionIds(layout!)).toEqual([
      "ses_1",
      "ses_2",
      "ses_3",
    ]);
    expect(layout?.focusedSessionId).toBe("ses_3");
  });

  it("keeps nine delegated Agents on a readable 3x3 grid", () => {
    const layout = gridAfter(9);
    const sizes = sizesOf(layout);
    expect(sizes).toHaveLength(9);
    // Nine columns used to leave ~150px slivers; a 3x3 grid stays ~460x300.
    expect(Math.min(...sizes.map((size) => size!.width))).toBeGreaterThan(400);
    expect(Math.min(...sizes.map((size) => size!.height))).toBeGreaterThan(250);
  });

  it("keeps every pane of an exact-fit layout balanced", () => {
    // Shapes that tile without an empty cell: no pane may be much smaller.
    for (const count of [2, 3, 4, 6, 9]) {
      const sizes = sizesOf(gridAfter(count)).map((size) => size!);
      const areas = sizes.map((size) => size.width * size.height);
      expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.6);
    }
  });

  it("never leaves a sliver, even when the grid cannot tile exactly", () => {
    for (const count of [5, 7, 8]) {
      const sizes = sizesOf(gridAfter(count)).map((size) => size!);
      // The narrowest pane stays readable rather than a 9-column sliver.
      expect(Math.min(...sizes.map((size) => size.width))).toBeGreaterThan(320);
    }
  });

  it("places a delegated pane right after its anchor", () => {
    let layout = singletonPaneLayout("ses_parent");
    layout = buildGridPlacementForSessions(layout, ["ses_a"], 1400, 900, 6)!;
    layout = buildGridPlacementForSessions(layout, ["ses_b"], 1400, 900, 6)!;
    // A new worker anchored at the parent sits beside it, not at the end.
    const anchored = buildGridPlacementForSessions(
      layout,
      ["ses_child"],
      1400,
      900,
      6,
      "ses_parent",
    )!;
    const order = orderedLayoutSessionIds(anchored);
    expect(order.indexOf("ses_child")).toBe(order.indexOf("ses_parent") + 1);
    // The grid shape still covers every pane.
    expect(order).toHaveLength(4);
  });

  it("anchoring never changes the grid shape", () => {
    // Build eight panes, then add the ninth both ways: the shape must stay 3x3
    // because the optimal-layout rule decides columns/rows, not the anchor.
    let layout = singletonPaneLayout("ses_1");
    for (let index = 2; index <= 8; index += 1) {
      layout = buildGridPlacementForSessions(layout, [`ses_${index}`], 1400, 900, 6)!;
    }
    const anchored = buildGridPlacementForSessions(
      layout,
      ["ses_9"],
      1400,
      900,
      6,
      "ses_1",
    )!;
    const plain = buildGridPlacementForSessions(layout, ["ses_9"], 1400, 900, 6)!;
    // Same grid and same cell sizes as a set: only which pane sits where
    // differs, because the planner still chose the shape.
    const cells = (candidate: PaneLayout) => {
      const root = candidate.root;
      if (!root) return [];
      return orderedLayoutSessionIds(candidate)
        .map((id) => paneSessionSize(root, id, 1400, 900, 6)!)
        .map((size) => Math.round(size.width))
        .sort((a, b) => a - b);
    };
    expect(cells(anchored)).toEqual(cells(plain));
    expect(orderedLayoutSessionIds(anchored).indexOf("ses_9")).toBe(
      orderedLayoutSessionIds(anchored).indexOf("ses_1") + 1,
    );
    expect(orderedLayoutSessionIds(plain).indexOf("ses_9")).toBe(8);
  });

  it("still reports an incremental candidate for explicit splits", () => {
    const planned = chooseSplitPlacement(
      singletonPaneLayout("ses_1"),
      workspace.width,
      workspace.height,
      6,
    );
    expect(planned?.sessionId).toBe("ses_1");
    expect(planned?.direction).toBe("right");
  });
});
