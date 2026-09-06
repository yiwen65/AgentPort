import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installTerminalInput } from "./terminalInput";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); });

function setup(withFallback = true) {
  const terminal = new Terminal({ screenReaderMode: true });
  const container = document.createElement("div");
  const textarea = document.createElement("textarea");
  container.append(textarea); document.body.append(container);
  // Real xterm input/key processors, without requiring a canvas layout in jsdom.
  const core = (terminal as unknown as { _core: any })._core;
  core.textarea = textarea;
  textarea.addEventListener("input", event => core._inputEvent(event), true);
  const send = vi.fn();
  const dispose = withFallback ? installTerminalInput(terminal, container, send) : terminal.onData(send).dispose;
  cleanups.push(() => { dispose(); terminal.dispose(); container.remove(); });
  return { terminal, textarea, send };
}
function insert(textarea: HTMLTextAreaElement, data: string, extra: InputEventInit = {}) {
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: false, inputType: "insertText", data, ...extra }));
}

describe("xterm accessible input-only soft keyboard fallback", () => {
  it("reproduces upstream dropping a digit without keypress in screen reader mode", () => {
    const { textarea, send } = setup(false);
    insert(textarea, "1");
    expect(send).not.toHaveBeenCalled();
  });
  it("sends digits and punctuation exactly once while retaining screen reader mode", () => {
    const { terminal, textarea, send } = setup();
    for (const digit of "1234567890.@") insert(textarea, digit);
    expect(send.mock.calls.map(([data]) => data).join("")).toBe("1234567890.@");
    expect(send).toHaveBeenCalledTimes(12);
    expect(terminal.options.screenReaderMode).toBe(true);
  });
  it("does not duplicate a physical keyboard emission before input", () => {
    const { terminal, textarea, send } = setup();
    textarea.addEventListener("keypress", () => terminal.input("1", true), true);
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "1" }));
    textarea.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "1" }));
    insert(textarea, "1");
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "1" }));
    insert(textarea, "2");
    expect(send.mock.calls).toEqual([["1"], ["2"]]);
  });
  it("leaves composition and its trailing commit to xterm, then accepts the next digit", () => {
    vi.useFakeTimers();
    const { terminal, textarea, send } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart"));
    insert(textarea, "ni", { isComposing: true, inputType: "insertCompositionText" });
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }));
    insert(textarea, "你");
    expect(send).not.toHaveBeenCalled();
    terminal.input("你", true);
    vi.runAllTimers();
    insert(textarea, "3");
    expect(send.mock.calls).toEqual([["你"], ["3"]]);
  });
  it("leaves keyCode 229 textarea reads to xterm before accepting further digits", async () => {
    vi.useFakeTimers();
    const { terminal, textarea, send } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, keyCode: 229 }));
    insert(textarea, "7");
    expect(send).not.toHaveBeenCalled();
    await Promise.resolve();
    terminal.input("7", true);
    vi.runAllTimers();
    insert(textarea, "8");
    expect(send.mock.calls).toEqual([["7"], ["8"]]);
  });
  it("does not intercept deletion or paste input events", () => {
    const { textarea, send } = setup();
    insert(textarea, "text", { inputType: "insertFromPaste" });
    insert(textarea, "", { inputType: "deleteContentBackward" });
    expect(send).not.toHaveBeenCalled();
  });
});
