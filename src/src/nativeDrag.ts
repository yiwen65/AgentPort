import { writeSessionPaneDragPayload } from "./paneSessionDrag";
import { writeDragPayload, type TreeDragPayload } from "./terminalDrop";

type WriteDragData = (dataTransfer: DataTransfer) => void;
let writeData: WriteDragData | null = null;
let sourceWriteData: WriteDragData | null = null;
let previousTarget: Element | null = null;

function beginNativeDrag(write: WriteDragData): void {
  endNativeDrag();
  sourceWriteData = write;
  window.addEventListener("dragend", clearSource, { once: true });
}

export function beginNativeSessionDrag(id: string): void {
  beginNativeDrag((dataTransfer) => writeSessionPaneDragPayload(dataTransfer, id));
}

export function beginNativeTreeDrag(payload: TreeDragPayload): void {
  beginNativeDrag((dataTransfer) => writeDragPayload(dataTransfer, payload));
}

function dispatch(target: Element, type: string, x = 0, y = 0, relatedTarget: Element | null = null) {
  const dataTransfer = new DataTransfer();
  writeData?.(dataTransfer);
  target.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: x, clientY: y, relatedTarget,
  }));
}

function clearSource(): void {
  // Native drop IPC can arrive after the browser's dragend. Keep the native
  // gesture alive until its own drop/leave, rather than losing its payload.
  sourceWriteData = null;
}

function endNativeDrag(): void {
  if (previousTarget) dispatch(previousTarget, "dragleave");
  previousTarget = null;
  writeData = null;
  sourceWriteData = null;
  window.removeEventListener("dragend", clearSource);
}

type NativeDrag =
  | { type: "enter" | "over" | "drop"; position: { x: number; y: number } }
  | { type: "leave" };

/** Wry consumes DOM drag events, including internal Session and tree drags.
 * Restore their in-memory payload: native events expose no paths for HTML drags. */
export function forwardNativeDrag(event: NativeDrag): boolean {
  writeData ??= sourceWriteData;
  if (!writeData) return false;
  if (event.type === "leave") {
    if (previousTarget) dispatch(previousTarget, "dragleave");
    previousTarget = null;
    writeData = null;
    return true;
  }
  // wry reports drag positions in logical (CSS) pixels on macOS and Linux
  // (NSView points / GTK widget coordinates; only webview2 uses physical
  // pixels, and this app ships no Windows build). elementFromPoint takes CSS
  // pixels, so the position is used as-is — dividing by devicePixelRatio
  // here mis-targets every drop on HiDPI displays.
  const x = event.position.x;
  const y = event.position.y;
  const target = document.elementFromPoint(x, y);
  if (previousTarget !== target) {
    if (previousTarget) dispatch(previousTarget, "dragleave", x, y, target);
    if (target) dispatch(target, "dragenter", x, y, previousTarget);
    previousTarget = target;
  }
  if (target) dispatch(target, event.type === "drop" ? "drop" : "dragover", x, y);
  if (event.type === "drop") endNativeDrag();
  return true;
}
