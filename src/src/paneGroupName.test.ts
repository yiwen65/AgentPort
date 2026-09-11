// @vitest-environment jsdom
import { expect, it } from "vitest";
import { splitPane, singletonPaneLayout, movePane, removePane, prunePaneLayout, persistTerminalLayouts, readPersistedTerminalWorkspace, updateSplitRatio } from "./paneLayout";

it("preserves group names through transforms and persistence", () => {
  let group = { ...splitPane(singletonPaneLayout("a"), "a", "b", "right", "root"), name: "工作组" };
  group = splitPane(group, "b", "c", "down", "inner") as typeof group;
  group = movePane(group, "c", "a", "down", "moved") as typeof group;
  group = updateSplitRatio(group, "moved", 0.6) as typeof group;
  group = removePane(group, "b") as typeof group;
  group = prunePaneLayout(group, ["a", "c"]) as typeof group;
  expect(group.name).toBe("工作组");
  persistTerminalLayouts([group], group);
  expect(readPersistedTerminalWorkspace()?.groups[0].name).toBe("工作组");
  localStorage.clear();
});
