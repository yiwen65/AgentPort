// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../actions", () => ({ applyThemeSettings: vi.fn(), refreshProjects: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));
import { api } from "../api";
import { i18n } from "../i18n";
import { getState, setState } from "../store";
import type { AdapterInstall, AgentTypeStr, Settings } from "../types";
import SettingsDialog from "./SettingsDialog";

const settings: Settings = {
  logLimitMib: 200, notificationsEnabled: true, uiLanguage: "en-US", theme: "dark", terminalTheme: "one",
  terminalFontFamily: "system-monospace", terminalFontSize: 13, terminalCommand: "", reducedMotion: "system",
  screenReaderMode: false, searchIndexEnabled: true, agentOrder: ["codex", "claude"], agentHidden: ["codex"], telemetryEnabled: false,
};
const install = (agent: AgentTypeStr, path = `/chosen/${agent}`): AdapterInstall => ({
  agentType: agent, executablePath: path, versionText: "fixture", capabilityHash: `sha256:${agent}`,
  exactResume: true, hookStatus: "supported", approvalModel: "native_prompts", defaultTransport: "pty",
  probedAt: "2026-09-11T00:00:00Z", candidates: [], flags: [],
});
const supported = (...agents: AgentTypeStr[]) => agents.map(agent => ({ agent, displayName: agent, commandNames: [agent] }));
const found = (agent: AgentTypeStr) => ({ agent, displayName: agent, state: "available" as const, reason: null, candidates: [], install: install(agent) });
function openAdapters() {
  render(<SettingsDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Agent Adapters" }));
}
const detect = () => screen.getByRole("button", { name: /^(Detect missing Agents|Checking…)$/ }) as HTMLButtonElement;
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  setState({ settings: { ...settings }, adapters: [install("claude"), install("codex")], platform: null,
    projects: [], dialog: { kind: "settings" }, secretBackend: "Unavailable", indexState: "ready", rendererFallbackReason: null });
  vi.spyOn(api, "notificationSetups").mockResolvedValue([]);
  // The adapters table also reports each Agent's MCP registration; these rows
  // are covered by the dedicated test below.
  vi.spyOn(api, "mcpRegistrations").mockResolvedValue([
    { agent: "claude", state: "registered", target: "claude mcp", command: "/app/agentport-mcp", detail: "" },
    { agent: "codex", state: "missing", target: "codex mcp", command: "/app/agentport-mcp", detail: "" },
  ]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("MCP registration per Agent", () => {
  it("reflects each Agent's own registration and toggles only that Agent", async () => {
    const set = vi.spyOn(api, "setMcpRegistration").mockImplementation(async (agent, enabled) => ({
      agent: agent as AgentTypeStr,
      state: enabled ? "registered" : "missing",
      target: `${agent} mcp`,
      command: "/app/agentport-mcp",
      detail: "",
    }));
    openAdapters();
    const claude = await screen.findByRole("switch", {
      name: /Register the AgentPort MCP for Claude Code/,
    });
    const codex = screen.getByRole("switch", {
      name: /Register the AgentPort MCP for Codex/,
    });
    await waitFor(() => expect(claude.getAttribute("aria-checked")).toBe("true"));
    expect(codex.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(codex);
    await waitFor(() => expect(set).toHaveBeenCalledWith("codex", true));
    await waitFor(() => expect(codex.getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(claude);
    await waitFor(() => expect(set).toHaveBeenCalledWith("claude", false));
  });

  it("disables the switch for Agents without a verified mechanism", async () => {
    vi.spyOn(api, "mcpRegistrations").mockResolvedValue([
      { agent: "claude", state: "unsupported", target: "", command: null, detail: "no CLI" },
      { agent: "codex", state: "missing", target: "codex mcp", command: "/app/agentport-mcp", detail: "" },
    ]);
    openAdapters();
    const claude = await screen.findByRole("switch", {
      name: /Register the AgentPort MCP for Claude Code/,
    });
    await waitFor(() =>
      expect((claude as HTMLButtonElement).disabled).toBe(true),
    );
    expect(claude.getAttribute("title")).toBe("no CLI");
    const codex = screen.getByRole("switch", {
      name: /Register the AgentPort MCP for Codex/,
    });
    expect((codex as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("Agent enablement and missing-only discovery", () => {
  it("keeps disabled rows and uses reversible switches, including the last enabled Agent", async () => {
    const save = vi.spyOn(api, "saveSettings").mockResolvedValue(undefined);
    openAdapters();
    const table = screen.getByRole("table", { name: "Agent adapter list" });
    const claude = within(table).getByRole("switch", { name: /^Enable Claude Code$/ });
    const codex = within(table).getByRole("switch", { name: /^Enable Codex$/ });
    expect(claude.getAttribute("aria-checked")).toBe("true");
    expect(codex.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(claude);
    expect(claude.getAttribute("aria-checked")).toBe("false");
    // Two Agents × (MCP registration, enablement).
    expect(within(table).getAllByRole("switch")).toHaveLength(4);
    expect(within(table).queryByRole("button", { name: /Remove/ })).toBeNull();
    fireEvent.click(codex);
    expect(codex.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ agentHidden: ["claude"], agentOrder: ["codex", "claude"] })));
    expect(getState().adapters).toEqual([install("claude"), install("codex")]);
  });

  it("only probes missing IDs, skips disabled installed Agents, and preserves existing selections", async () => {
    vi.spyOn(api, "listSupportedAgents").mockResolvedValue(supported("claude", "codex", "omp", "gemini"));
    const all = vi.spyOn(api, "probeAgents");
    const probe = vi.spyOn(api, "probeAgent").mockImplementation(async agent => agent === "omp"
      ? found("omp") : { ...found("gemini"), state: "unavailable", install: null });
    openAdapters();
    fireEvent.click(detect());
    await waitFor(() => expect(detect().disabled).toBe(false));
    expect(probe.mock.calls).toEqual([["omp", null], ["gemini", null]]);
    expect(all).not.toHaveBeenCalled();
    expect(getState().adapters).toEqual([install("claude"), install("codex"), install("omp")]);
    expect(getState().settings).toMatchObject({ agentHidden: ["codex"], agentOrder: ["codex", "claude"] });
    expect(
      screen.getByRole("switch", { name: /^Enable Codex$/ }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("does no probing when every supported Agent is already present", async () => {
    vi.spyOn(api, "listSupportedAgents").mockResolvedValue(supported("claude", "codex"));
    const probe = vi.spyOn(api, "probeAgent");
    const all = vi.spyOn(api, "probeAgents");
    openAdapters(); fireEvent.click(detect());
    await waitFor(() => expect(detect().disabled).toBe(false));
    expect(probe).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    expect(getState().adapters).toHaveLength(2);
  });

  it("continues after a discovery error without losing successful or existing installs", async () => {
    vi.spyOn(api, "listSupportedAgents").mockResolvedValue(supported("omp", "gemini"));
    const probe = vi.spyOn(api, "probeAgent").mockRejectedValueOnce(new Error("fixture probe failed")).mockResolvedValueOnce(found("gemini"));
    openAdapters(); fireEvent.click(detect());
    await waitFor(() => expect(detect().disabled).toBe(false));
    expect(probe).toHaveBeenCalledTimes(2);
    expect(getState().adapters).toEqual([install("claude"), install("codex"), install("gemini")]);
  });

  it("merges with fresh store state and skips Agents discovered during the scan", async () => {
    vi.spyOn(api, "listSupportedAgents").mockResolvedValue(supported("omp", "gemini"));
    let finish!: (value: ReturnType<typeof found>) => void;
    const probe = vi.spyOn(api, "probeAgent").mockReturnValue(new Promise(resolve => { finish = resolve; }));
    openAdapters(); fireEvent.click(detect());
    await waitFor(() => expect(probe).toHaveBeenCalledOnce());
    expect(detect().disabled).toBe(true);
    act(() => setState({ adapters: [install("claude", "/new/claude"), install("codex"), install("gemini")] }));
    await act(async () => finish(found("omp")));
    expect(probe.mock.calls).toEqual([["omp", null]]);
    expect(getState().adapters).toEqual([install("claude", "/new/claude"), install("codex"), install("gemini"), install("omp")]);
  });
});
