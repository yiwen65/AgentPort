import { describe, expect, it } from "vitest";
import { orderAgentIds } from "./agentOrder";

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
