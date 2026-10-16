// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginNativeSessionDrag, beginNativeTreeDrag, forwardNativeDrag } from "./nativeDrag";
import { readSessionPaneDragPayload } from "./paneSessionDrag";
import { readDragPayload } from "./terminalDrop";

vi.mock("./terminals", () => ({ insertTextIntoTerminal: vi.fn() }));

let hit: ReturnType<typeof vi.fn>;
let hitDescriptor: PropertyDescriptor | undefined;
beforeEach(() => {
  class Transfer {
    values = new Map<string, string>();
    setData(key: string, value: string) { this.values.set(key, value); }
    getData(key: string) { return this.values.get(key) ?? ""; }
    get types() { return [...this.values.keys()]; }
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
  hit = vi.fn();
  hitDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
});

afterEach(() => {
  forwardNativeDrag({ type: "leave" });
  window.dispatchEvent(new Event("dragend"));
  if (hitDescriptor) Object.defineProperty(document, "elementFromPoint", hitDescriptor);
  else Reflect.deleteProperty(document, "elementFromPoint");
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("routes intercepted native Session drags to DOM split zones at wry's logical coordinates", () => {
  // DPR 2 guards against dividing wry's logical coordinates by devicePixelRatio.
  const pane = document.createElement("div");
  const zone = document.createElement("div");
  document.body.append(pane);
  hit.mockReturnValue(pane);
  const enter = vi.fn(() => { pane.append(zone); hit.mockReturnValue(zone); });
  pane.addEventListener("dragenter", enter, { once: true });
  const dropped = vi.fn((event: Event) => {
    expect(readSessionPaneDragPayload((event as DragEvent).dataTransfer!)).toEqual({ sessionId: "source" });
  });
  zone.addEventListener("drop", dropped);
  beginNativeSessionDrag("source");
  expect(forwardNativeDrag({ type: "over", position: { x: 200, y: 100 } })).toBe(true);
  expect(enter).toHaveBeenCalledOnce();
  expect(hit).toHaveBeenCalledWith(200, 100);
  window.dispatchEvent(new Event("dragend"));
  forwardNativeDrag({ type: "drop", position: { x: 200, y: 100 } });
  expect(dropped).toHaveBeenCalledOnce();
  // External file drops must still reach the native file-path handler.
  expect(forwardNativeDrag({ type: "drop", position: { x: 200, y: 100 } })).toBe(false);
});

it("keeps the tree source on leave/re-entry and clears it after cancellation", () => {
  const target = document.createElement("div");
  hit.mockReturnValue(target);
  const leave = vi.fn();
  target.addEventListener("dragleave", leave);
  const dropped = vi.fn((event: Event) => readDragPayload((event as DragEvent).dataTransfer!));
  target.addEventListener("drop", dropped);
  const payload = { path: "/tmp/My Docs/报告.md", isDir: false };
  beginNativeTreeDrag(payload);
  forwardNativeDrag({ type: "enter", position: { x: 200, y: 100 } });
  expect(forwardNativeDrag({ type: "leave" })).toBe(true);
  expect(leave).toHaveBeenCalledOnce();
  forwardNativeDrag({ type: "drop", position: { x: 200, y: 100 } });
  expect(dropped).toHaveBeenCalledOnce();
  expect(dropped.mock.results[0]?.value).toEqual(payload);

  beginNativeTreeDrag(payload);
  forwardNativeDrag({ type: "over", position: { x: 200, y: 100 } });
  window.dispatchEvent(new Event("dragend"));
  forwardNativeDrag({ type: "leave" });
  expect(forwardNativeDrag({ type: "drop", position: { x: 200, y: 100 } })).toBe(false);
  expect(dropped).toHaveBeenCalledOnce();
});

it("does not reuse tree data for a new Session drag", () => {
  const target = document.createElement("div");
  hit.mockReturnValue(target);
  beginNativeTreeDrag({ path: "/tmp/docs", isDir: true });
  forwardNativeDrag({ type: "over", position: { x: 200, y: 100 } });
  const dropped = vi.fn((event: Event) => {
    const dt = (event as DragEvent).dataTransfer!;
    expect(readDragPayload(dt)).toBeNull();
    expect(readSessionPaneDragPayload(dt)).toEqual({ sessionId: "new-session" });
  });
  target.addEventListener("drop", dropped);
  beginNativeSessionDrag("new-session");
  forwardNativeDrag({ type: "drop", position: { x: 200, y: 100 } });
  expect(dropped).toHaveBeenCalledOnce();
});
