import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installIosImeRouting } from "./iosIme";

const disposals: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {} }));
});
afterEach(() => { disposals.splice(0).reverse().forEach(fn => fn()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  const terminal = new Terminal({ screenReaderMode: false });
  const container = document.createElement("div"); document.body.append(container); terminal.open(container);
  const textarea = terminal.textarea!;
  const sent: string[] = []; terminal.onData(data => sent.push(data));
  const dispose = installIosImeRouting(container, textarea);
  disposals.push(() => { dispose(); terminal.dispose(); container.remove(); });
  return { textarea, sent, dispose };
}
function down(ta: HTMLTextAreaElement, key: string) {
  ta.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key, keyCode: 229 }));
}
function insert(ta: HTMLTextAreaElement, data: string, inputType = "insertText", isComposing = false) {
  ta.value += data;
  ta.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data, inputType, isComposing }));
}
function up(ta: HTMLTextAreaElement, key: string) {
  ta.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, composed: true, key }));
}
const tick = () => vi.advanceTimersByTimeAsync(1);

describe("captured iOS Pinyin events against a real opened xterm", () => {
  it.each([false, true])("emits each digit/symbol once (input arrives in a later task: %s)", async delayed => {
    const { textarea, sent } = setup();
    for (const text of "33355@￥，。+-") {
      down(textarea, text);
      if (delayed) await tick();
      insert(textarea, text); up(textarea, text); await tick();
    }
    expect(sent.join("")).toBe("33355@￥，。+-");
    expect(sent).toHaveLength(11);
  });
  it.each([false, true])("commits Chinese and trailing punctuation once (punctuation delayed: %s)", async delayed => {
    const { textarea, sent } = setup();
    down(textarea, "n");
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "ni" }));
    insert(textarea, "ni", "insertCompositionText", true); await tick();
    expect(sent).toEqual([]);
    textarea.value = "你";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    if (delayed) await tick();
    insert(textarea, "，"); up(textarea, "，"); await tick();
    down(textarea, "3"); await tick(); insert(textarea, "3"); up(textarea, "3"); await tick();
    expect(sent.join("")).toBe("你，3");
  });
  it("preserves hardware keypress input and Enter", () => {
    const { textarea, sent } = setup();
    textarea.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, key: "a", charCode: 97 }));
    insert(textarea, "a"); up(textarea, "a");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    expect(sent.join("")).toBe("a\r");
  });
  it("removes listeners on disposal (upstream timing regression returns)", async () => {
    const { textarea, sent, dispose } = setup(); dispose();
    down(textarea, "3"); await tick(); insert(textarea, "3"); up(textarea, "3"); await tick();
    expect(sent).toEqual([]);
  });
});
