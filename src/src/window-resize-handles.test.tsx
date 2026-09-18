// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startResizeDragging = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startResizeDragging }),
}));

import WindowResizeHandles from "./components/WindowResizeHandles";
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

describe("window resize handles (frameless Linux)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setState({ platform: null });
  });

  afterEach(cleanup);

  it("renders all eight edge/corner zones on frameless Linux", () => {
    setState({ platform: platform("linux", false) });

    const { container } = render(<WindowResizeHandles />);

    const handles = container.querySelectorAll(".resize-handle");
    expect(handles.length).toBe(8);
    for (const id of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      expect(container.querySelector(`.resize-handle-${id}`)).toBeTruthy();
    }
  });

  it("forwards left-button drags to the native resize grab", () => {
    setState({ platform: platform("linux", false) });

    const { container } = render(<WindowResizeHandles />);

    fireEvent.mouseDown(container.querySelector(".resize-handle-s")!, { button: 0 });
    expect(startResizeDragging).toHaveBeenCalledWith("South");

    fireEvent.mouseDown(container.querySelector(".resize-handle-nw")!, { button: 0 });
    expect(startResizeDragging).toHaveBeenCalledWith("NorthWest");
  });

  it("ignores non-primary buttons", () => {
    setState({ platform: platform("linux", false) });

    const { container } = render(<WindowResizeHandles />);

    fireEvent.mouseDown(container.querySelector(".resize-handle-e")!, { button: 2 });
    expect(startResizeDragging).not.toHaveBeenCalled();
  });

  it("renders nothing on macOS, decorated Linux, or unknown platforms", () => {
    for (const info of [
      platform("macos", true),
      platform("linux", true),
      null,
    ] as Array<PlatformInfo | null>) {
      setState({ platform: info });
      const { container } = render(<WindowResizeHandles />);
      expect(container.querySelectorAll(".resize-handle").length).toBe(0);
      cleanup();
    }
  });
});
