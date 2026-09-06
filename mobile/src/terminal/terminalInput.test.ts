import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); });

function setup(screenReaderMode = false) {
  const terminal = new Terminal({ screenReaderMode });
  const textarea = document.createElement("textarea");
  document.body.append(textarea);
  // Exercise the real xterm processors without canvas layout in jsdom.
  const core = (terminal as unknown as { _core: any })._core;
  core.textarea = textarea;
  textarea.addEventListener("input", event => core._inputEvent(event), true);
  textarea.addEventListener("keypress", event => core._keyPress(event), true);
  const send = vi.fn();
  const subscription = terminal.onData(data => send(data));
  cleanups.push(() => { subscription.dispose(); terminal.dispose(); textarea.remove(); });
  return { terminal, textarea, send };
}
function insert(textarea: HTMLTextAreaElement, data: string, inputType = "insertText") {
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
}

describe("single stock xterm input path", () => {
  it("demonstrates why input-only digits require screen reader mode off", () => {
    const { textarea, send } = setup(true);
    insert(textarea, "1");
    expect(send).not.toHaveBeenCalled();
  });
  it("emits input-only digits, repeated letters and punctuation exactly once", () => {
    const { terminal, textarea, send } = setup();
    for (const character of "1234567890aabb.@") insert(textarea, character);
    expect(send.mock.calls.map(([data]) => data).join("")).toBe("1234567890aabb.@");
    expect(send).toHaveBeenCalledTimes(16);
    expect(terminal.options.screenReaderMode).toBe(false);
  });
  it("does not duplicate an input event following a handled keypress", () => {
    const { textarea, send } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, charCode: 49, key: "1" }));
    insert(textarea, "1");
    expect(send.mock.calls).toEqual([["1"]]);
  });
  it("does not separately forward uncommitted composition or paste events", () => {
    const { textarea, send } = setup();
    insert(textarea, "ni", "insertCompositionText");
    insert(textarea, "你", "insertFromComposition");
    insert(textarea, "text", "insertFromPaste");
    expect(send).not.toHaveBeenCalled();
  });
});
