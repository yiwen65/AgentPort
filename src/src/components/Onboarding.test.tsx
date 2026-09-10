// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { applyUiLanguage } from "../i18n";
import { getState, setState } from "../store";
import Onboarding from "./Onboarding";

describe("Onboarding localization", () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    setState({ adapters: [] });
    await applyUiLanguage("zh-CN", { persistHint: false });
  });

  it("adds the localized registry context exactly once", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    vi.spyOn(api, "listSupportedAgents").mockRejectedValueOnce(new Error("registry offline"));
    render(<Onboarding />);

    expect((await screen.findByRole("alert")).textContent)
      .toBe("无法加载 Agent 注册表：registry offline");
  });

  it("automatically probes all registered Agents once", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    vi.spyOn(api, "listSupportedAgents").mockResolvedValueOnce([
      { agent: "pi", displayName: "Pi", commandNames: ["pi"] },
    ]);
    const probe = vi.spyOn(api, "probeAgents").mockResolvedValueOnce([
      {
        agent: "pi",
        displayName: "Pi",
        state: "available",
        reason: null,
        notificationSetup: {
          agent: "pi", state: "failed", strategy: "extension",
          events: { completed: "unavailable", needsInput: "heuristic", failed: "process" },
          detail: "fixture permission denied", checkedAt: "2026-09-10T00:00:00Z",
        },
        install: {
          agentType: "pi",
          executablePath: "/home/test/.volta/bin/pi",
          versionText: "0.99.0",
          capabilityHash: "sha256:test",
          exactResume: true,
          hookStatus: "unavailable",
          approvalModel: "no_builtin_prompts",
          defaultTransport: "pty",
          probedAt: "2026-07-23T00:00:00Z",
          candidates: [],
          flags: [],
        },
        candidates: [],
      },
    ]);

    render(<Onboarding />);

    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("/home/test/.volta/bin/pi")).toBeTruthy();
    expect(screen.getByText("通知: 配置失败")).toBeTruthy();
    expect(getState().adapters.some((adapter) => adapter.agentType === "pi")).toBe(true);
  });

  it("browses for an executable file instead of an installation directory", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    vi.spyOn(api, "listSupportedAgents").mockResolvedValueOnce([
      { agent: "pi", displayName: "Pi", commandNames: ["pi"] },
    ]);
    vi.spyOn(api, "probeAgents").mockResolvedValueOnce([
      {
        agent: "pi",
        displayName: "Pi",
        state: "unavailable",
        reason: "not found",
        install: null,
        candidates: [],
      },
    ]);
    const pickFile = vi.spyOn(api, "pickFile").mockResolvedValueOnce("/opt/tools/pi");
    const pickDirectory = vi.spyOn(api, "pickDirectory");
    render(<Onboarding />);

    await screen.findByText("not found");
    await userEvent.click(screen.getByRole("button", { name: "浏览…" }));

    expect(pickFile).toHaveBeenCalledTimes(1);
    expect(pickDirectory).not.toHaveBeenCalled();
    expect((screen.getByLabelText("手动指定 Pi 路径") as HTMLInputElement).value)
      .toBe("/opt/tools/pi");
  });

  it("removes a stale cached Agent when automatic probing no longer finds it", async () => {
    setState({
      adapters: [{
        agentType: "pi",
        executablePath: "/stale/pi",
        versionText: "0.1.0",
        capabilityHash: "sha256:stale",
        exactResume: true,
        hookStatus: "unavailable",
        approvalModel: "no_builtin_prompts",
        defaultTransport: "pty",
        probedAt: "2026-07-23T00:00:00Z",
        candidates: [],
        flags: [],
      }],
    });
    vi.spyOn(api, "listSupportedAgents").mockResolvedValueOnce([
      { agent: "pi", displayName: "Pi", commandNames: ["pi"] },
    ]);
    vi.spyOn(api, "probeAgents").mockResolvedValueOnce([
      {
        agent: "pi",
        displayName: "Pi",
        state: "unavailable",
        reason: "not found",
        install: null,
        candidates: [],
      },
    ]);

    render(<Onboarding />);
    await screen.findByText("not found");

    expect(getState().adapters.some((adapter) => adapter.agentType === "pi")).toBe(false);
  });
});
