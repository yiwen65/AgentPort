// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPLIT_RATIO,
  MAX_PANE_LAYOUT_DEPTH,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  TERMINAL_LAYOUT_STORAGE_KEY,
  TERMINAL_LAYOUT_VERSION,
  emptyPaneLayout,
  clampPaneSplitRatio,
  focusPane,
  layoutContains,
  movePane,
  orderedLayoutSessionIds,
  paneLeaf,
  paneLayoutFitsSize,
  paneMinimumSize,
  paneSessionSize,
  persistTerminalLayout,
  prunePaneLayout,
  readPersistedTerminalLayout,
  removePane,
  sanitizePaneLayout,
  singletonPaneLayout,
  splitPane,
  updateSplitRatio,
  visiblePaneLayout,
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
    logPath: `/tmp/${id}.log`,
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
    expect(readPersistedTerminalLayout()).toEqual(layout);
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
        root: {
          type: "split",
          id: "corrupt",
          direction: "unknown",
          ratio: -1,
          first: { type: "leaf", sessionId: "a" },
          second: { type: "leaf", sessionId: "a" },
        },
        focusedSessionId: "missing",
      }),
    );
    expect(readPersistedTerminalLayout()).toEqual(singletonPaneLayout("a"));
  });

  it("preserves a deliberately empty persisted workspace", () => {
    expect(persistTerminalLayout(emptyPaneLayout())).toBe(true);
    expect(readPersistedTerminalLayout()).toEqual(emptyPaneLayout());
    expect(window.localStorage.getItem(TERMINAL_LAYOUT_STORAGE_KEY)).not.toBeNull();
  });
});

describe("pane layout store reconciliation", () => {
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

    expect(orderedLayoutSessionIds(store.getState().terminalLayout)).toEqual([a.id, b.id]);
    expect(store.getState().activeSessionId).toBe(outside.id);
    expect(store.getState().attachedIds).toEqual([outside.id]);
    expect(orderedLayoutSessionIds(visiblePaneLayout(
      store.getState().terminalLayout,
      store.getState().activeSessionId,
    ))).toEqual([outside.id]);
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
