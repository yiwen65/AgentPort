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
  const dispose = installIosImeRouting(container, textarea, text => terminal.input(text, true));
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

// Synthetic event sequences, not a captured iPhone dictation trace.
describe("iOS edit routing against a real opened xterm 5.5", () => {
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
  async function compose(textarea: HTMLTextAreaElement, text: string) {
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value += text;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: text }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: text }));
    await tick();
  }
  function replace(textarea: HTMLTextAreaElement, value: string, data: string, inputType: string) {
    textarea.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType, data }));
    textarea.value = value;
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
  }
  it.each(["insertText", "insertFromComposition", "insertReplacementText", "insertFromDictation"])("ignores a delayed unchanged commit notification (%s)", async inputType => {
    const { textarea, sent } = setup();
    await compose(textarea, "hello");
    await vi.advanceTimersByTimeAsync(100);
    replace(textarea, "hello", "hello", inputType);
    expect(sent).toEqual(["hello"]);
  });
  it("demonstrates upstream duplicate for the same delayed insertText", async () => {
    const { textarea, sent, dispose } = setup(); dispose();
    await compose(textarea, "hello");
    replace(textarea, "hello", "hello", "insertText");
    expect(sent).toEqual(["hello", "hello"]);
  });
  it("keeps consecutive identical compositions and identical appended text", async () => {
    const { textarea, sent } = setup();
    await compose(textarea, "hello");
    await compose(textarea, "hello");
    insert(textarea, "hello");
    expect(sent).toEqual(["hello", "hello", "hello"]);
  });
  it.each(["insertReplacementText", "insertFromDictation"])("routes append and proven tail replacement (%s)", inputType => {
    const { textarea, sent } = setup();
    replace(textarea, "hello", "hello", inputType);
    textarea.setSelectionRange(0, 5);
    replace(textarea, "hello world", "hello world", inputType);
    textarea.setSelectionRange(0, 11);
    replace(textarea, "hello word", "hello word", inputType);
    textarea.setSelectionRange(10, 10);
    replace(textarea, "hello wordhello word", "hello word", inputType);
    expect(sent).toEqual(["hello", " world", "\x7f\x7fd", "hello word"]);
  });
  it("uses selection evidence for insertText replacement rather than appending the full phrase", async () => {
    const { textarea, sent } = setup();
    await compose(textarea, "hello");
    textarea.setSelectionRange(0, 5);
    replace(textarea, "hello world", "hello world", "insertText");
    expect(sent).toEqual(["hello", " world"]);
  });
  it.each([false, true])("owns cumulative ordinary edits without composition (beforeinput: %s)", withBefore => {
    const { textarea, sent } = setup();
    const update = (value: string) => {
      if (withBefore) textarea.setSelectionRange(0, textarea.value.length);
      if (withBefore) replace(textarea, value, value, "insertText");
      else {
        textarea.value = value;
        textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
      }
    };
    update("hello"); update("hello world"); update("hello world");
    expect(sent).toEqual(["hello", " world"]);
    if (withBefore) {
      update("hello word");
      expect(sent.at(-1)).toBe("\x7f\x7fd");
    }
    const phrase = textarea.value;
    textarea.setSelectionRange(phrase.length, phrase.length);
    replace(textarea, phrase + phrase, phrase, "insertText");
    expect(sent.at(-1)).toBe(phrase); // intentional identical utterance
  });
  it("preserves identical insertion after a witnessed textarea reset", () => {
    const { textarea, sent } = setup();
    insert(textarea, "hello");
    textarea.value = "";
    replace(textarea, "hello", "hello", "insertText");
    expect(sent).toEqual(["hello", "hello"]);
  });
  it("demonstrates upstream no-composition cumulative duplication", () => {
    const { textarea, sent, dispose } = setup(); dispose();
    replace(textarea, "hello", "hello", "insertText");
    textarea.setSelectionRange(0, 5);
    replace(textarea, "hello world", "hello world", "insertText");
    replace(textarea, "hello world", "hello world", "insertText");
    expect(sent).toEqual(["hello", "hello world", "hello world"]);
  });
  it("declines unproven corrections and complex grapheme deletion", () => {
    const { textarea, sent } = setup();
    insert(textarea, "hello");
    textarea.value = "world";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "world" }));
    expect(sent).toEqual(["hello"]);
    textarea.dispatchEvent(new Event("blur"));
    insert(textarea, "👩‍💻");
    textarea.setSelectionRange(5, textarea.value.length);
    replace(textarea, "worldX", "X", "insertText");
    expect(sent).toEqual(["hello", "👩‍💻"]);
  });
  it("demonstrates upstream omission of dictation-specific input types", () => {
    const { textarea, sent, dispose } = setup(); dispose();
    replace(textarea, "hello", "hello", "insertFromDictation");
    textarea.setSelectionRange(0, 5);
    replace(textarea, "hello world", "hello world", "insertReplacementText");
    expect(sent).toEqual([]);
  });
  it("does not rewrite terminal state after hardware navigation", () => {
    const { textarea, sent } = setup();
    replace(textarea, "hello", "hello", "insertFromDictation");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft", keyCode: 37 }));
    textarea.setSelectionRange(0, 5);
    replace(textarea, "world", "world", "insertReplacementText");
    expect(sent).toEqual(["hello", "\x1b[D"]);
  });
  it("preserves paste through xterm", () => {
    const { textarea, sent } = setup();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => "hello hello" } });
    textarea.dispatchEvent(event);
    expect(sent).toEqual(["hello hello"]);
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
