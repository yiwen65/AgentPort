// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../actions", () => ({
  applyThemeSettings: vi.fn(),
  refreshProjects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../terminals", () => ({ applyTerminalLanguage: vi.fn() }));

import { api } from "../api";
import { applyUiLanguage } from "../i18n";
import { setState } from "../store";
import type { Settings } from "../types";
import SettingsDialog from "./SettingsDialog";

const settings: Settings = {
  logLimitMib: 200,
  notificationsEnabled: true,
  uiLanguage: "zh-CN",
  theme: "system",
  terminalFontFamily: "system-monospace",
  terminalFontSize: 13,
  terminalCommand: "",
  reducedMotion: "system",
  screenReaderMode: false,
  searchIndexEnabled: true,
  agentOrder: ["claude", "codex", "shell"],
  telemetryEnabled: false,
};

describe("Commit AI settings", () => {
  beforeEach(async () => {
    await applyUiLanguage("zh-CN");
    setState({
      settings: { ...settings },
      platform: null,
      adapters: [],
      projects: [],
      dialog: { kind: "settings" },
      secretBackend: "Available(MacosKeychain)",
      indexState: "ready",
      rendererFallbackReason: null,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("saves provider configuration through the secure native boundary and clears the key field", async () => {
    vi.spyOn(api, "getCommitAiConfig").mockResolvedValue({
      provider: "openai",
      baseUrl: "",
      model: "",
      hasApiKey: false,
    });
    const save = vi.spyOn(api, "saveCommitAiConfig").mockResolvedValue({
      provider: "anthropic",
      baseUrl: "https://provider.example/v1",
      model: "claude-compatible",
      hasApiKey: true,
    });
    render(<SettingsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "提交 AI" }));
    await screen.findByLabelText("兼容协议");
    fireEvent.change(screen.getByLabelText("兼容协议"), {
      target: { value: "anthropic" },
    });
    fireEvent.change(screen.getByLabelText("服务地址（Base URL）"), {
      target: { value: "https://provider.example/v1" },
    });
    fireEvent.change(screen.getByLabelText("模型"), {
      target: { value: "claude-compatible" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "secret-api-key" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存提交 AI 配置" }));
    });

    expect(save).toHaveBeenCalledWith(
      "anthropic",
      "https://provider.example/v1",
      "claude-compatible",
      "secret-api-key",
    );
    await waitFor(() => {
      const key = screen.getByLabelText("API Key") as HTMLInputElement;
      expect(key.value).toBe("");
      expect(key.placeholder).toBe("已配置；留空则保持不变");
    });
  });
});
