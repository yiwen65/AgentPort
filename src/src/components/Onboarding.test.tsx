// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { applyUiLanguage } from "../i18n";
import Onboarding from "./Onboarding";

describe("Onboarding localization", () => {
  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await applyUiLanguage("zh-CN", { persistHint: false });
  });

  it("adds the localized registry context exactly once", async () => {
    await applyUiLanguage("zh-CN", { persistHint: false });
    vi.spyOn(api, "listSupportedAgents").mockRejectedValueOnce(new Error("registry offline"));
    render(<Onboarding />);

    expect((await screen.findByRole("alert")).textContent)
      .toBe("无法加载 Agent 注册表：registry offline");
  });
});
