// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({
  applyThemeSettings: vi.fn(),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));

import { i18n } from "../i18n";
import { setState } from "../store";
import { resetDevicesStoreForTests, setDevicesInvokerForTests } from "../devicesStore";
import type { Settings } from "../types";
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
  agentOrder: ["codex", "claude"],
  agentHidden: [],
  telemetryEnabled: false,
};

describe("SettingsDialog initial section", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    resetDevicesStoreForTests();
    setDevicesInvokerForTests(async (command) => {
      if (command === "device_list") return [];
      throw new Error(`Unexpected command ${command}`);
    });
    setState({
      settings: { ...settings },
      adapters: [],
      platform: null,
      projects: [],
      dialog: { kind: "settings", section: "devices" },
      secretBackend: "Unavailable",
      indexState: "ready",
      rendererFallbackReason: null,
    });
  });

  afterEach(() => {
    cleanup();
    setDevicesInvokerForTests(undefined);
  });

  it("opens the requested Computers section", () => {
    render(<SettingsDialog initialSection="devices" />);

    expect(
      screen.getByRole("button", { name: "Computers" }).getAttribute("aria-current"),
    ).toBe("page");
  });
});
