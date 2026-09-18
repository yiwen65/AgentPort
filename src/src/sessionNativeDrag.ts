import { SESSION_PANE_DND_MIME } from "./paneSessionDrag";

let sessionId: string | null = null;
let sourceSessionId: string | null = null;
let previousTarget: Element | null = null;

export function beginNativeSessionDrag(id: string): void {
  sourceSessionId = id;
  window.addEventListener("dragend", clearSource, { once: true });
}

function dispatch(target: Element, type: string, x = 0, y = 0, relatedTarget: Element | null = null) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData(SESSION_PANE_DND_MIME, JSON.stringify({ sessionId }));
  dataTransfer.effectAllowed = "move";
  target.dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: x, clientY: y, relatedTarget,
  }));
}

function clearSource(): void {
  // Native drop IPC can arrive after the browser's dragend. Keep the native
  // gesture alive until its own drop/leave, rather than losing its payload.
  sourceSessionId = null;
}

function endNativeSessionDrag(): void {
  if (previousTarget) dispatch(previousTarget, "dragleave");
  previousTarget = null;
  sessionId = null;
  sourceSessionId = null;
  window.removeEventListener("dragend", clearSource);
}

type NativeDrag =
  | { type: "enter" | "over" | "drop"; position: { x: number; y: number } }
  | { type: "leave" };

/** Wry's native file-drop handler consumes DOM drag events, including internal drags. */
export function forwardNativeSessionDrag(event: NativeDrag): boolean {
  sessionId ??= sourceSessionId;
  if (!sessionId) return false;
  if (event.type === "leave") {
    if (previousTarget) dispatch(previousTarget, "dragleave");
    previousTarget = null;
    sessionId = null;
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
  if (event.type === "drop") endNativeSessionDrag();
  return true;
}
