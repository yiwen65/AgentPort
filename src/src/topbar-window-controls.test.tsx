// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const windowApi = {
  startDragging: vi.fn().mockResolvedValue(undefined),
  minimize: vi.fn().mockResolvedValue(undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  onResized: vi.fn().mockResolvedValue(() => {}),
};

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowApi,
}));
vi.mock("./actions", () => ({
  toggleActiveAgentsView: vi.fn(),
  toggleSidebarCollapsed: vi.fn(),
}));
vi.mock("./documents", () => ({ toggleExplorer: vi.fn() }));
vi.mock("./gitCenter", () => ({
  closeGitCenter: vi.fn(),
  openGitCenter: vi.fn(),
}));

import TopBar from "./components/TopBar";
import { setState } from "./store";
import type { PlatformInfo } from "./types";

const platform = (os: string, windowDecorated: boolean): PlatformInfo => ({
  os,
  osVersion: "24.04",
  arch: "x86_64",
  webview: "WebKitGTK",
  appVersion: "0.1.0",
  windowDecorated,
});

describe("topbar frameless-Linux window controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    windowApi.isMaximized.mockResolvedValue(false);
    setState({ platform: null });
  });

  afterEach(cleanup);

  it("renders minimize/maximize/close on frameless Linux and calls the window API", async () => {
    setState({ platform: platform("linux", false) });

    render(<TopBar />);

    const minimize = await screen.findByRole("button", { name: "最小化" });
    const maximize = screen.getByRole("button", { name: "最大化" });
    const close = screen.getByRole("button", { name: "关闭" });

    minimize.click();
    expect(windowApi.minimize).toHaveBeenCalledTimes(1);

    maximize.click();
    expect(windowApi.toggleMaximize).toHaveBeenCalledTimes(1);

    close.click();
    expect(windowApi.close).toHaveBeenCalledTimes(1);
  });

  it("offers restore instead of maximize while the window is maximized", async () => {
    windowApi.isMaximized.mockResolvedValue(true);
    setState({ platform: platform("linux", false) });

    render(<TopBar />);

    expect(await screen.findByRole("button", { name: "还原" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最大化" })).toBeNull();
  });

  it("toggles maximize on drag-region double-click only when frameless", async () => {
    setState({ platform: platform("linux", false) });

    const { container } = render(<TopBar />);
    const header = container.querySelector("header.topbar");
    expect(header).toBeTruthy();
    fireEvent.doubleClick(header!);
    expect(windowApi.toggleMaximize).toHaveBeenCalledTimes(1);

    windowApi.toggleMaximize.mockClear();
    await act(async () => {
      setState({ platform: platform("linux", true) });
    });
    fireEvent.doubleClick(header!);
    expect(windowApi.toggleMaximize).not.toHaveBeenCalled();
  });

  it("renders no window controls on macOS, decorated Linux, or unknown platforms", async () => {
    for (const info of [
      platform("macos", true),
      platform("linux", true),
      null,
    ] as Array<PlatformInfo | null>) {
      setState({ platform: info });
      render(<TopBar />);
      // flush the (skipped or real) maximized sync before asserting
      await act(async () => {});
      expect(screen.queryByRole("button", { name: "最小化" })).toBeNull();
      expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
      cleanup();
    }
  });
});
