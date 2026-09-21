// @vitest-environment jsdom
// Real @xterm/xterm 5.5 against the captured WebKitGTK + fcitx5/Rime event
// shape: keydown(229) -> beforeinput/input "insertFromComposition"
// (isComposing) -> compositionend, and never a compositionstart. Linux IME
// users reported the whole line being typed again ("整段又插一遍"), because
// xterm's CompositionHelper keeps its start offset at 0 without that
// compositionstart and re-forwards its scratch textarea on compositionend.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { installInputCompatibility } from "./terminals";

const disposals: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
});

afterEach(() => {
  disposals.splice(0).reverse().forEach((fn) => fn());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup() {
  const terminal = new Terminal({ cols: 40, rows: 10 });
  const container = document.createElement("div");
  document.body.append(container);
  terminal.open(container);
  const textarea = terminal.textarea!;
  const sent: string[] = [];
  const subscription = terminal.onData((data) => sent.push(data));
  const uninstall = installInputCompatibility(terminal, container);
  disposals.push(() => {
    uninstall();
    subscription.dispose();
    terminal.dispose();
    container.remove();
  });
  return { textarea, sent, uninstall };
}

function keyDown(
  textarea: HTMLTextAreaElement,
  init: KeyboardEventInit,
  keyCode: number,
) {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  Object.defineProperty(event, "keyCode", { value: keyCode });
  textarea.dispatchEvent(event);
}

function beforeInput(
  textarea: HTMLTextAreaElement,
  data: string,
  inputType: string,
) {
  textarea.dispatchEvent(
    new InputEvent("beforeinput", {
      data,
      inputType,
      isComposing: true,
      bubbles: true,
      composed: true,
    }),
  );
}

function insert(
  textarea: HTMLTextAreaElement,
  data: string,
  inputType: string,
  isComposing: boolean,
) {
  textarea.value += data;
  textarea.dispatchEvent(
    new InputEvent("input", {
      data,
      inputType,
      isComposing,
      bubbles: true,
      composed: true,
    }),
  );
}

/** The exact shape captured from WebKitGTK + fcitx5/Rime on Linux. */
async function webkitGtkCommit(textarea: HTMLTextAreaElement, text: string) {
  keyDown(textarea, { key: "Unidentified", code: "Unidentified" }, 229);
  beforeInput(textarea, text, "insertFromComposition");
  insert(textarea, text, "insertFromComposition", true);
  textarea.dispatchEvent(
    new CompositionEvent("compositionend", {
      data: text,
      bubbles: true,
      composed: true,
    }),
  );
  await vi.advanceTimersByTimeAsync(2);
}

describe("WebKitGTK IME commits against a real xterm 5.5", () => {
  it("forwards every committed segment exactly once", async () => {
    const { textarea, sent } = setup();
    await webkitGtkCommit(textarea, "你好");
    await webkitGtkCommit(textarea, "世界");
    await webkitGtkCommit(textarea, "再见");

    expect(sent).toEqual(["你好", "世界", "再见"]);
  });

  it("forwards a candidate picked without a keydown exactly once", async () => {
    const { textarea, sent } = setup();
    await webkitGtkCommit(textarea, "你好");
    sent.length = 0;

    // Selecting a candidate with the mouse commits without any key event.
    beforeInput(textarea, "世界", "insertFromComposition");
    insert(textarea, "世界", "insertFromComposition", true);
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "世界",
        bubbles: true,
        composed: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(2);

    expect(sent).toEqual(["世界"]);
  });

  it("keeps text typed on the terminal's own key path untouched", async () => {
    const { textarea, sent } = setup();
    await webkitGtkCommit(textarea, "你好");
    sent.length = 0;

    // jsdom does not derive keyCode/charCode, which xterm 5.5 needs for
    // printable keys.
    const event = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(event, "keyCode", { value: 65 });
    Object.defineProperty(event, "charCode", { value: 97 });
    textarea.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(2);

    // xterm translates the keydown itself; the compat layer must not fill in.
    expect(sent).toEqual(["a"]);
  });

  it("leaves platforms that announce compositionstart to xterm", async () => {
    const { textarea, sent } = setup();
    await webkitGtkCommit(textarea, "你好");
    sent.length = 0;

    // macOS/Chrome shape: a real composition whose commit xterm forwards from
    // its own compositionend slice. Filling in here would double-send it.
    textarea.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true, composed: true }),
    );
    beforeInput(textarea, "世界", "insertFromComposition");
    insert(textarea, "世界", "insertFromComposition", false);
    textarea.dispatchEvent(
      new CompositionEvent("compositionend", {
        data: "世界",
        bubbles: true,
        composed: true,
      }),
    );
    await vi.advanceTimersByTimeAsync(2);

    expect(sent).toEqual(["世界"]);
  });

  it("cancels a queued commit fill-in when the layer is uninstalled", async () => {
    const { textarea, sent, uninstall } = setup();
    beforeInput(textarea, "你好", "insertFromComposition");
    insert(textarea, "你好", "insertFromComposition", true);
    uninstall();
    await vi.advanceTimersByTimeAsync(2);

    expect(sent).toEqual([]);
  });
});
