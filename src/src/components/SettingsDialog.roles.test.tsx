// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../actions", () => ({ applyThemeSettings: vi.fn(), refreshProjects: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));
import { api } from "../api";
import { i18n } from "../i18n";
import { setState } from "../store";
import type { AgentRole, Settings } from "../types";
import SettingsDialog from "./SettingsDialog";

const settings: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "en-US",
  theme: "dark",
  terminalTheme: "one",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["codex"],
  agentHidden: [],
  telemetryEnabled: false,
};

const role = (overrides: Partial<AgentRole> = {}): AgentRole => ({
  id: "role_researcher",
  name: "Researcher",
  description: "Find and verify evidence",
  instructions: "Verify facts before recommending a path.",
  outputContract: "Return evidence and trade-offs.",
  enabled: true,
  revision: 1,
  builtIn: true,
  ...overrides,
});

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  setState({
    settings: { ...settings },
    adapters: [],
    platform: null,
    projects: [],
    dialog: { kind: "settings" },
    secretBackend: "Unavailable",
    indexState: "ready",
    rendererFallbackReason: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Agent roles", () => {
  it("loads roles and toggles the selected role with its revision", async () => {
    const current = role();
    vi.spyOn(api, "listAgentRoles").mockResolvedValue([current]);
    const setEnabled = vi.spyOn(api, "setAgentRoleEnabled").mockResolvedValue(
      role({ enabled: false, revision: 2 }),
    );
    render(<SettingsDialog initialSection="roles" />);

    const enabled = await screen.findByRole("switch", { name: "Enable Researcher" });
    expect(enabled.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(enabled);
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith("role_researcher", 1, false),
    );
  });

  it("creates a DIY role with the editor fields", async () => {
    vi.spyOn(api, "listAgentRoles").mockResolvedValue([role()]);
    const create = vi.spyOn(api, "createAgentRole").mockResolvedValue(
      role({ id: "role_custom", name: "Custom", builtIn: false, enabled: false }),
    );
    render(<SettingsDialog initialSection="roles" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add role" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Custom" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A custom role" } });
    fireEvent.change(screen.getByLabelText("Instructions"), { target: { value: "Work carefully." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        name: "Custom",
        description: "A custom role",
        instructions: "Work carefully.",
        outputContract: null,
      }),
    );
  });
});
