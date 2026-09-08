import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installIosImeRouting, iosImeDiagnostics } from "./iosIme";

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

// Synthetic browser dispatch against real xterm; the Doubao batch regression
// below replays the event shape captured on iPhone, with neutral test content.
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
  it.each([false, true])("preserves every word's first character across WebKit space normalization (delayed: %s)", async delayed => {
    const { textarea, sent } = setup();
    for (const text of "abc abc abc") {
      down(textarea, text);
      if (delayed) await tick();
      // Real iPhone trace: the space key reports U+0020 but inserts U+00A0.
      // The next letter changes that retained NBSP to U+0020 in the same edit.
      const value = text === " " ? textarea.value + "\u00a0" : textarea.value.replace(/\u00a0/g, " ") + text;
      replace(textarea, value, text, "insertText");
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: text, keyCode: text === " " ? 32 : text.toUpperCase().charCodeAt(0) }));
      await tick();
    }
    expect(sent).toEqual(Array.from("abc abc abc"));
    expect(textarea.value).toBe("abc abc abc");
  });

  it.each(["a", "你", "🙂"])("appends %s after normalization without rewriting an unowned prefix", text => {
    const { textarea, sent, dispose } = setup();
    textarea.value = "older\u00a0";
    dispose.invalidate();
    replace(textarea, "older " + text, text, "insertText");
    expect(sent).toEqual([text]);
  });

  it("preserves an intentional NBSP instead of globally replacing pasted or typed text", () => {
    const { textarea, sent } = setup();
    replace(textarea, "\u00a0", "\u00a0", "insertText");
    replace(textarea, " a", "a", "insertText");
    expect(sent).toEqual(["\u00a0", "a"]);
  });

  it.each(["missing-beforeinput", "selected-prefix", "tab-change", "letter-change"])("does not invent append ownership for %s", boundary => {
    const { textarea, sent, dispose } = setup();
    textarea.value = boundary === "tab-change" ? "older\t" : "older\u00a0";
    dispose.invalidate();
    if (boundary === "selected-prefix") textarea.setSelectionRange(0, textarea.value.length);
    const value = boundary === "letter-change" ? "Older a" : "older a";
    if (boundary === "missing-beforeinput") {
      textarea.value = value;
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: "a" }));
    } else replace(textarea, value, "a", "insertText");
    expect(sent).toEqual([]);
  });

  it("uses actual appended bytes when event.data describes the entire word", () => {
    const { textarea, sent } = setup();
    replace(textarea, "abc\u00a0", "abc ", "insertText");
    replace(textarea, "abc a", "abc a", "insertText");
    expect(sent).toEqual(["abc ", "a"]);
    replace(textarea, "abc a", "abc a", "insertText");
    expect(sent).toHaveLength(2);
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
  it.each([0, 20, 1000])("waits for an asynchronous final DOM commit (%sms)", async delay => {
    const { textarea, sent } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    insert(textarea, "ni", "insertCompositionText", true);
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    await vi.advanceTimersByTimeAsync(delay);
    expect(sent).toEqual([]);
    textarea.value = "你";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromComposition", data: "你" }));
    await tick();
    replace(textarea, "你", "你", "insertText");
    expect(sent).toEqual(["你"]);
  });
  it("blocks xterm composition readers and 229 fallback with interleaved final input", async () => {
    const { textarea, sent } = setup();
    const leaked = vi.fn();
    for (const type of ["compositionstart", "compositionupdate", "compositionend", "input"]) textarea.addEventListener(type, leaked);
    down(textarea, "Process");
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    insert(textarea, "你", "insertText", false); // Some keyboards omit isComposing.
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "你" }));
    await tick(); expect(sent).toEqual([]);
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    replace(textarea, "你", "你", "insertText");
    await tick();
    replace(textarea, "你", "你", "insertFromComposition");
    expect(sent).toEqual(["你"]); expect(leaked).not.toHaveBeenCalled();
  });
  it("corrects proven CJK suffixes by scalar, not byte or cell width", () => {
    const { textarea, sent } = setup();
    replace(textarea, "你好世间", "你好世间", "insertFromDictation");
    textarea.setSelectionRange(0, 4);
    replace(textarea, "你好世界", "你好世界", "insertReplacementText");
    textarea.setSelectionRange(0, 4);
    replace(textarea, "你好世界！", "你好世界！", "insertFromDictation");
    expect(sent).toEqual(["你好世间", "\x7f界", "！"]);
  });
  it("commits composition replacement once rather than appending revised CJK", async () => {
    const { textarea, sent } = setup();
    insert(textarea, "你好"); textarea.setSelectionRange(0, 2);
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "您好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "您好" }));
    await tick();
    replace(textarea, "您好", "您好", "insertText");
    expect(sent).toEqual(["你好", "\x7f\x7f您好"]);
  });
  it("fences destructive corrections after out-of-band toolbar input", () => {
    const { textarea, sent, dispose } = setup();
    insert(textarea, "你好");
    dispose.invalidate(); // MobileTerminal calls this for toolbar/paste/reset.
    textarea.setSelectionRange(0, 2);
    replace(textarea, "您好", "您好", "insertReplacementText");
    expect(sent).toEqual(["你好"]);
  });
  it("owns soft deletion when beforeinput proves the suffix", () => {
    const { textarea, sent } = setup();
    insert(textarea, "你好"); textarea.setSelectionRange(2, 2);
    replace(textarea, "你", "", "deleteContentBackward");
    expect(sent).toEqual(["你好", "\x7f"]);
  });
  it.each(["abcdefghi", "甲乙丙丁戊己庚辛壬", "甲乙丙丁戊己庚辛。"])(
    "routes every Doubao retraction under one Backspace before the final phrase (%s)", async phrase => {
      const { textarea, sent } = setup();
      for (const char of phrase) {
        down(textarea, "Unidentified");
        replace(textarea, textarea.value + char, char, "insertText");
        up(textarea, "Unidentified");
      }
      const backspace = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 });
      textarea.dispatchEvent(backspace);
      // On-device: xterm canceled this keydown, then eight DOM deletions still
      // arrived under the SAME key. Model the first native deletion as the
      // key's default action; the IME's remaining eight edits are independent.
      if (!backspace.defaultPrevented) replace(textarea, textarea.value.slice(0, -1), "", "deleteContentBackward");
      for (let i = 0; i < 8; i++) replace(textarea, textarea.value.slice(0, -1), "", "deleteContentBackward");
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace", keyCode: 8 }));
      down(textarea, "Unidentified");
      replace(textarea, textarea.value + phrase, phrase, "insertText");
      up(textarea, "Unidentified");
      await tick();
      expect(sent.join("")).toBe(phrase + "\x7f".repeat(9) + phrase);
      expect(backspace.defaultPrevented).toBe(false);
      expect(textarea.value).toBe(phrase);
      const line: string[] = [];
      for (const char of sent.join("")) char === "\x7f" ? line.pop() : line.push(char);
      expect(line.join("")).toBe(phrase);
    },
  );
  it("preserves two intentional identical dictations with separate retraction batches", () => {
    const { textarea, sent } = setup();
    const phrase = "甲乙丙丁戊己庚辛。";
    for (let utterance = 1; utterance <= 2; utterance++) {
      for (const char of phrase) {
        down(textarea, "Unidentified"); insert(textarea, char); up(textarea, "Unidentified");
      }
      textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 }));
      for (let i = 0; i < phrase.length; i++) replace(textarea, textarea.value.slice(0, -1), "", "deleteContentBackward");
      textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace", keyCode: 8 }));
      down(textarea, "Unidentified"); insert(textarea, phrase); up(textarea, "Unidentified");
      expect(sent.join("")).toBe((phrase + "\x7f".repeat(9) + phrase).repeat(utterance));
      expect(textarea.value).toBe(phrase.repeat(utterance));
    }
  });
  it("does not infer an extra erase from Backspace when only eight DOM deletes arrive", () => {
    const { textarea, sent } = setup();
    insert(textarea, "abcdefghi");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 }));
    for (let i = 0; i < 8; i++) replace(textarea, textarea.value.slice(0, -1), "", "deleteContentBackward");
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Backspace", keyCode: 8 }));
    expect(sent).toEqual(["abcdefghi", ...Array(8).fill("\x7f")]);
    expect(textarea.value).toBe("a");
  });
  it("waits for actual DOM deletion instead of speculatively sending Backspace", () => {
    const { textarea, sent } = setup();
    insert(textarea, "你好");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 }));
    up(textarea, "Backspace");
    expect(sent).toEqual(["你好"]);
  });
  it("handles repeated Backspace then falls back to xterm when the owned suffix is empty", () => {
    const { textarea, sent } = setup();
    insert(textarea, "你好");
    for (let i = 0; i < 3; i++) {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8, repeat: i > 0 });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(i === 2);
      if (!event.defaultPrevented) replace(textarea, textarea.value.slice(0, -1), "", "deleteContentBackward");
    }
    up(textarea, "Backspace");
    expect(sent).toEqual(["你好", "\x7f", "\x7f", "\x7f"]);
  });
  it.each([
    [{ ctrlKey: true }, "\b"], [{ altKey: true }, "\x1b\x7f"],
    [{ metaKey: true }, "\x7f"], [{ shiftKey: true }, "\x7f"],
  ] as const)("leaves modified Backspace with xterm (%s)", (modifiers, output) => {
    const { textarea, sent } = setup();
    insert(textarea, "你好");
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8, ...modifiers }));
    expect(sent).toEqual(["你好", output]);
  });
  it.each(["invalidated", "changed-dom", "caret-moved", "selected", "complex-grapheme"])(
    "does not take Backspace from xterm without a safe owned tail (%s)", boundary => {
      const { textarea, sent, dispose } = setup();
      const text = boundary === "complex-grapheme" ? "👩‍💻" : "你好";
      insert(textarea, text);
      if (boundary === "invalidated") dispose.invalidate();
      if (boundary === "changed-dom") textarea.value = "别的";
      if (boundary === "caret-moved") textarea.setSelectionRange(1, 1);
      if (boundary === "selected") textarea.setSelectionRange(0, 2);
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 });
      textarea.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(sent).toEqual([text, "\x7f"]);
    },
  );
  it("finishes a pending composition before routing its native Backspace", () => {
    const { textarea, sent } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你好" }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace", keyCode: 8 }));
    replace(textarea, "你", "", "deleteContentBackward");
    expect(sent).toEqual(["你好", "\x7f"]);
  });
  it("does not emit canceled composition preedit", async () => {
    const { textarea, sent } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    insert(textarea, "ni", "insertCompositionText", true);
    textarea.value = "";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
    await tick(); expect(sent).toEqual([]);
  });
  it("cancels pending commits on disposal", async () => {
    const { textarea, sent, dispose } = setup();
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "hello";
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "hello" }));
    dispose(); await tick(); expect(sent).toEqual([]);
  });
  it("provides opt-in bounded diagnostics without text and clears on disable", () => {
    iosImeDiagnostics.disable();
    const { textarea } = setup(); insert(textarea, "private phrase");
    expect(iosImeDiagnostics.snapshot()).toEqual([]);
    iosImeDiagnostics.enable();
    for (let i = 0; i < 300; i++) insert(textarea, "secret");
    const records = iosImeDiagnostics.snapshot();
    expect(records).toHaveLength(256);
    expect(JSON.stringify(records)).not.toMatch(/private|secret/);
    expect(records.at(-1)).toMatchObject({ type: "input", dataLength: 6, emittedLength: 6 });
    iosImeDiagnostics.disable(); expect(iosImeDiagnostics.snapshot()).toEqual([]);
  });
  it("removes listeners on disposal (upstream timing regression returns)", async () => {
    const { textarea, sent, dispose } = setup(); dispose();
    down(textarea, "3"); await tick(); insert(textarea, "3"); up(textarea, "3"); await tick();
    expect(sent).toEqual([]);
  });
});
