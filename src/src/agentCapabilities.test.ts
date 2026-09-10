import { describe, expect, it } from "vitest";
import { ADDED_AGENT_IDS, availablePermissionModes, isAddedAgent, quickStartPermission } from "./agentCapabilities";
import { DEFAULT_AGENT_ORDER, orderAgentIds } from "./agentOrder";
import { agentDisplay, presetDisplayName } from "./format";
import type { AdapterInstall } from "./types";

const names = ["Oh My Pi", "OpenCode", "Amp", "Gemini CLI", "Cline CLI", "Kiro CLI", "Cursor CLI", "easy-pi", "Grok Build"];

describe("nine-agent frontend contract", () => {
  it.each(ADDED_AGENT_IDS)("registers %s without making permission promises", (agent) => {
    expect(isAddedAgent(agent)).toBe(true);
    expect(DEFAULT_AGENT_ORDER).toContain(agent);
    expect(agentDisplay(agent)).toBe(names[ADDED_AGENT_IDS.indexOf(agent)]);
    expect(quickStartPermission(agent)).toBe("native");
    expect(availablePermissionModes(agent)).toEqual(["native"]);
    const translated = presetDisplayName({ id: `pre_${agent}_safe`, name: "untranslated", builtIn: true });
    expect(translated).not.toContain("builtInPreset.");
    expect(translated).not.toBe("untranslated");
    expect(translated).toContain(agentDisplay(agent));
  });

  it("preserves original shortcuts and saved order while appending all nine", () => {
    expect(quickStartPermission("codex")).toBe("bypass");
    expect(quickStartPermission("pi")).toBe("native");
    expect(quickStartPermission("shell")).toBe("native");
    expect(orderAgentIds(["pi", "codex"], ["codex", "pi", ...ADDED_AGENT_IDS]))
      .toEqual(["pi", "codex", ...ADDED_AGENT_IDS]);
    expect(new Set(DEFAULT_AGENT_ORDER).size).toBe(DEFAULT_AGENT_ORDER.length);
  });

  it.each([
    ["omp", "approval-mode", ["native", "auto", "bypass"]],
    ["opencode", "auto", ["native", "auto"]],
    ["gemini", "approval-mode", ["native", "auto", "bypass"]],
    ["cline", "auto-approve", ["native", "auto", "bypass"]],
    ["kiro_cli", "trust-all-tools", ["native", "auto", "bypass"]],
    ["cursor_agent", "force", ["native", "auto", "bypass"]],
    ["grok_build", "permission-mode", ["native", "auto", "bypass"]],
  ] as const)("exposes %s modes only with its verified %s flag", (agent, flag, modes) => {
    const install = { approvalModel: "native_prompts", flags: [flag] } as AdapterInstall;
    expect(availablePermissionModes(agent, install)).toEqual(modes);
    expect(availablePermissionModes(agent, { ...install, flags: ["unrelated"] })).toEqual(["native"]);
  });

  it("never mistakes easy-pi project trust for tool approval", () => {
    const install = { approvalModel: "native_prompts", flags: ["approve", "no-approve", "approval-mode"] } as AdapterInstall;
    expect(availablePermissionModes("easy_pi", install)).toEqual(["native"]);
  });

  it("does not expose permission modes for a CLI without builtin prompts", () => {
    const install = { approvalModel: "no_builtin_prompts", flags: ["yolo", "approval-mode"] } as AdapterInstall;
    expect(availablePermissionModes("amp", install)).toEqual(["native"]);
  });
});
