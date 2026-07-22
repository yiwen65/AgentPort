// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendererMocks = vi.hoisted(() => {
  const terminals: FakeTerminal[] = [];
  const config = { canvasShouldFail: false };
  class FakeTerminal {
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    element: HTMLDivElement | null = null;
    buffer = { active: { viewportY: 0, baseY: 0, type: "normal" } };
    loadAddon = vi.fn((addon: unknown) => {
      if (addon instanceof FakeCanvasAddon && config.canvasShouldFail) {
        throw new Error("Canvas unavailable");
      }
    });
    onData = vi.fn();
    onScroll = vi.fn();
    open(container: HTMLDivElement) {
      this.element = document.createElement("div");
      container.appendChild(this.element);
    }
    clearTextureAtlas = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terminals.push(this);
    }
  }
  class FakeCanvasAddon {}
  class FakeFitAddon {
    fit = vi.fn();
  }
  class FakeSearchAddon {}
  return { config, terminals, FakeTerminal, FakeCanvasAddon, FakeFitAddon, FakeSearchAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: rendererMocks.FakeTerminal }));
vi.mock("@xterm/addon-canvas", () => ({ CanvasAddon: rendererMocks.FakeCanvasAddon }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: rendererMocks.FakeFitAddon }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: rendererMocks.FakeSearchAddon }));
vi.mock("@tauri-apps/api/core", () => ({ Channel: class {} }));
vi.mock("./api", () => ({
  api: {
    attachSession: vi.fn().mockResolvedValue({ attachmentId: 1, childAlive: true, hostPid: null, logBytes: 0 }),
    detachSession: vi.fn(),
  },
  b64ToBytes: vi.fn(),
  bytesToB64: vi.fn(),
  errorText: (error: unknown) => String(error),
}));

import { disposeHandle, mountTerminal } from "./terminals";
import { getState, setState } from "./store";

describe("terminal renderer", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    rendererMocks.config.canvasShouldFail = false;
    setState({ rendererMode: "dom", rendererFallbackReason: null });
  });

  afterEach(() => {
    disposeHandle("renderer-test");
    vi.unstubAllGlobals();
  });

  it("uses CanvasAddon for the default interactive terminal renderer", () => {
    const container = document.createElement("div");
    mountTerminal("renderer-test", container);

    expect(rendererMocks.terminals[rendererMocks.terminals.length - 1]?.loadAddon).toHaveBeenCalledWith(
      expect.any(rendererMocks.FakeCanvasAddon),
    );
    expect(getState().rendererMode).toBe("canvas");
  });

  it("uses the DOM renderer only when CanvasAddon fails to initialize", () => {
    rendererMocks.config.canvasShouldFail = true;
    mountTerminal("renderer-test", document.createElement("div"));

    expect(getState().rendererMode).toBe("dom");
    expect(getState().rendererFallbackReason).toContain("Canvas unavailable");
  });
});
