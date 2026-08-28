import { describe, expect, it } from "vitest";
import { orderAgentIds, visibleAgentIds } from "./agentOrder";

describe("orderAgentIds", () => {
  it("keeps the default shortcut order and has no display-count limit", () => {
    expect(orderAgentIds(undefined, ["pi", "qoder", "claude", "codex", "kimi", "shell"]))
      .toEqual(["shell", "codex", "claude", "kimi", "qoder", "pi"]);
  });

  it("preserves a saved order and appends a newly detected adapter", () => {
    expect(orderAgentIds(["pi", "codex"], ["codex", "pi", "qoder"]))
      .toEqual(["pi", "codex", "qoder"]);
  });
});

describe("visibleAgentIds", () => {
  it("returns a copy unchanged when nothing is hidden", () => {
    const ids = ["shell", "codex"];
    expect(visibleAgentIds(ids, undefined)).toEqual(ids);
    expect(visibleAgentIds(ids, [])).toEqual(ids);
  });

  it("drops hidden agents while preserving order", () => {
    expect(visibleAgentIds(["shell", "codex", "claude"], ["codex"]))
      .toEqual(["shell", "claude"]);
  });

  it("ignores hidden ids that are not present", () => {
    expect(visibleAgentIds(["shell"], ["kimi"])).toEqual(["shell"]);
  });
});
