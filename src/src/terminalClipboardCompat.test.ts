// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { copyText } from "./api";
import { getState, setState } from "./store";
import { installClipboardCompatibility } from "./terminals";

vi.mock("./api", async (importOriginal) => ({
  ...await importOriginal<typeof import("./api")>(),
  copyText: vi.fn().mockResolvedValue(true),
}));

const disposals: Array<() => void> = [];
const originalPlatform = getState().platform;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
  setState({ platform: {
    os: "linux", osVersion: "24.04", arch: "x86_64",
    webview: "WebKitGTK", appVersion: "0.1.2", windowDecorated: true,
  } });
});

afterEach(() => {
  disposals.splice(0).reverse().forEach((fn) => fn());
  setState({ platform: originalPlatform });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(selected = true) {
  const terminal = new Terminal({ cols: 40, rows: 10 });
  const container = document.createElement("div");
  document.body.append(container);
  terminal.open(container);
  const sent: string[] = [];
  const subscription = terminal.onData((data) => sent.push(data));
  const uninstall = installClipboardCompatibility(terminal, container);
  terminal.write("copy 中文");
  await vi.advanceTimersByTimeAsync(10);
  if (selected) terminal.select(0, 0, 9);
  disposals.push(() => {
    uninstall();
    subscription.dispose();
    terminal.dispose();
    container.remove();
  });
  const keyDown = (modifiers: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      key: modifiers.shiftKey ? "C" : "c", code: "KeyC",
      bubbles: true, cancelable: true, ...modifiers,
    });
    Object.defineProperty(event, "keyCode", { value: 67 });
    terminal.textarea!.dispatchEvent(event);
    return event;
  };
  return { terminal, sent, keyDown, uninstall };
}

describe("terminal copy shortcuts against real xterm 5.5", () => {
  it("copies Ctrl+Shift+C without relying on a browser copy event", async () => {
    const { sent, keyDown } = await setup();
    const event = keyDown({ ctrlKey: true, shiftKey: true });
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith("copy 中文");
    expect(sent).toEqual([]);
    expect(event.defaultPrevented).toBe(true);
  });

  it("copies Ctrl+C with a selection instead of interrupting the Agent", async () => {
    const { sent, keyDown } = await setup();
    keyDown({ ctrlKey: true });
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith("copy 中文");
    expect(sent).toEqual([]);
  });

  it("keeps Ctrl+C as terminal interrupt without a selection", async () => {
    const { sent, keyDown } = await setup(false);
    keyDown({ ctrlKey: true });
    expect(copyText).not.toHaveBeenCalled();
    expect(sent).toEqual(["\x03"]);
  });

  it("does not turn Ctrl+Shift+C without a selection into an interrupt", async () => {
    const { sent, keyDown } = await setup(false);
    keyDown({ ctrlKey: true, shiftKey: true });
    expect(copyText).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("leaves macOS Ctrl+C on the terminal interrupt path", async () => {
    const { sent, keyDown } = await setup();
    setState({ platform: { ...getState().platform!, os: "macos" } });
    keyDown({ ctrlKey: true });
    expect(copyText).not.toHaveBeenCalled();
    expect(sent).toEqual(["\x03"]);
  });

  it.each(["linux", "macos"] as const)("still copies through the native copy event on %s", async (os) => {
    const { terminal } = await setup();
    setState({ platform: { ...getState().platform!, os } });
    const event = new Event("copy", { bubbles: true, cancelable: true });
    terminal.textarea!.dispatchEvent(event);
    expect(copyText).toHaveBeenCalledOnce();
    expect(copyText).toHaveBeenCalledWith("copy 中文");
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { altKey: true },
    { metaKey: true },
    { isComposing: true },
  ])("does not consume other modifiers or composition: %j", async (modifiers) => {
    const { keyDown } = await setup();
    keyDown({ ctrlKey: true, ...modifiers });
    expect(copyText).not.toHaveBeenCalled();
  });

  it("removes the shortcut listener when uninstalled", async () => {
    const { sent, keyDown, uninstall } = await setup();
    uninstall();
    keyDown({ ctrlKey: true });
    expect(copyText).not.toHaveBeenCalled();
    expect(sent).toEqual(["\x03"]);
  });
});
