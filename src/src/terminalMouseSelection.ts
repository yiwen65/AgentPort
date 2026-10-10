import type { Terminal } from "@xterm/xterm";

const DRAG_THRESHOLD_PX = 4;

/** Keep Agent clicks/wheels, but let ordinary Linux drags select terminal text.
 * Shift selection remains xterm's responsibility; Ctrl/Alt/Meta drags pass
 * through to the Agent. Replay through DOM so xterm owns selection geometry,
 * wide characters, rendering, auto-scroll and Linux primary selection. */
export function installTerminalMouseSelection(
  term: Terminal,
  container: HTMLElement,
  enabled: () => boolean,
): () => void {
  const doc = container.ownerDocument;
  const win = doc.defaultView!;
  let replaying = false;
  let suppressClick = false;
  let gesture: {
    down: MouseEvent;
    target: EventTarget;
    last: MouseEvent;
    dragging: boolean;
  } | null = null;

  const consume = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const replay = (
    target: EventTarget,
    event: MouseEvent,
    type = event.type,
    shiftKey = event.shiftKey,
  ) => {
    replaying = true;
    try {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        buttons: type === "mouseup" ? 0 : event.buttons,
        detail: event.detail,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        shiftKey,
      }));
    } finally {
      replaying = false;
    }
  };
  const cancel = () => {
    const active = gesture;
    gesture = null;
    if (active?.dragging) replay(doc, active.last, "mouseup", true);
    suppressClick = false;
  };
  const onMouseDown = (event: MouseEvent) => {
    if (replaying) return;
    cancel();
    const mode = term.modes?.mouseTrackingMode;
    if (
      !enabled() || !mode || mode === "none" ||
      !(event.target instanceof win.Node) ||
      !term.element?.contains(event.target)
    ) return;
    if (event.button === 2 && term.getSelection()) {
      // A right press reported to the Agent is user input to xterm, which
      // clears the very selection that the following Copy menu needs.
      consume(event);
      return;
    }
    if (
      event.button !== 0 || event.shiftKey || event.ctrlKey ||
      event.altKey || event.metaKey
    ) return;

    // Do not let the Agent start its own selection until this is known to
    // be a click. A drag instead starts xterm's native forced selection.
    // Canvas/DOM renderer children can be replaced when focus redraws the
    // cursor. Replay on the persistent xterm root, never the hit-tested child.
    gesture = { down: event, target: term.element, last: event, dragging: false };
    term.focus();
    consume(event);
  };
  const onMouseMove = (event: MouseEvent) => {
    const active = gesture;
    if (replaying) return;
    if (!active) {
      if (
        enabled() && term.modes?.mouseTrackingMode === "any" &&
        term.getSelection() && event.target instanceof win.Node &&
        term.element?.contains(event.target) && event.buttons === 0
      ) consume(event); // Hover reports also clear selection in ANY mode.
      return;
    }
    active.last = event;
    if (!active.dragging && Math.hypot(
      event.clientX - active.down.clientX,
      event.clientY - active.down.clientY,
    ) >= DRAG_THRESHOLD_PX) {
      active.dragging = true;
      replay(active.target, active.down, "mousedown", true);
    }
    consume(event);
    if (active.dragging) {
      // Dispatch on document, not the screen: ANY mouse mode would otherwise
      // report this move before xterm's document-level selection listener.
      replay(doc, event, "mousemove", true);
    }
  };
  const onMouseUp = (event: MouseEvent) => {
    const active = gesture;
    if (replaying || !active || event.button !== 0) return;
    gesture = null;
    consume(event);
    if (active.dragging) {
      replay(doc, event, "mouseup", true);
      suppressClick = true;
    } else {
      replay(active.target, active.down);
      replay(event.target ?? doc, event);
    }
  };
  const onClick = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false;
    consume(event); // A drag must not also activate a terminal link.
  };

  container.addEventListener("mousedown", onMouseDown, true);
  container.addEventListener("click", onClick, true);
  doc.addEventListener("mousemove", onMouseMove, true);
  doc.addEventListener("mouseup", onMouseUp, true);
  win.addEventListener("blur", cancel);
  return () => {
    cancel();
    container.removeEventListener("mousedown", onMouseDown, true);
    container.removeEventListener("click", onClick, true);
    doc.removeEventListener("mousemove", onMouseMove, true);
    doc.removeEventListener("mouseup", onMouseUp, true);
    win.removeEventListener("blur", cancel);
  };
}
