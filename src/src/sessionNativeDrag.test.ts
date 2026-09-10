// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { beginNativeSessionDrag, forwardNativeSessionDrag } from "./sessionNativeDrag";
import { readSessionPaneDragPayload } from "./paneSessionDrag";

afterEach(() => {
  window.dispatchEvent(new Event("dragend"));
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("routes intercepted native Session drags to DOM split zones at CSS coordinates", () => {
  class Transfer {
    values = new Map<string, string>();
    setData(key: string, value: string) { this.values.set(key, value); }
    getData(key: string) { return this.values.get(key) ?? ""; }
  }
  class Drag extends MouseEvent {
    dataTransfer: DataTransfer | null;
    constructor(type: string, init: DragEventInit) {
      super(type, init);
      this.dataTransfer = init.dataTransfer ?? null;
    }
  }
  vi.stubGlobal("DataTransfer", Transfer);
  vi.stubGlobal("DragEvent", Drag);
  vi.stubGlobal("devicePixelRatio", 2);
  const pane = document.createElement("div");
  const zone = document.createElement("div");
  document.body.append(pane);
  const hit = vi.fn(() => pane);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  const enter = vi.fn(() => { pane.append(zone); hit.mockReturnValue(zone); });
  pane.addEventListener("dragenter", enter, { once: true });
  const dropped = vi.fn((event: Event) => {
    expect(readSessionPaneDragPayload((event as DragEvent).dataTransfer!)).toEqual({ sessionId: "source" });
  });
  zone.addEventListener("drop", dropped);
  beginNativeSessionDrag("source");
  expect(forwardNativeSessionDrag({ type: "over", position: { x: 200, y: 100 } })).toBe(true);
  expect(enter).toHaveBeenCalledOnce();
  expect(hit).toHaveBeenCalledWith(100, 50);
  window.dispatchEvent(new Event("dragend"));
  forwardNativeSessionDrag({ type: "drop", position: { x: 200, y: 100 } });
  expect(dropped).toHaveBeenCalledOnce();
  // External file drops must still reach the native file-path handler.
  expect(forwardNativeSessionDrag({ type: "drop", position: { x: 200, y: 100 } })).toBe(false);
});
