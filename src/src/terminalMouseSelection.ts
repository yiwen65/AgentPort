import type { Terminal } from "@xterm/xterm";

const DRAG_THRESHOLD_PX = 4;
/** Cadence of wheel reports forwarded to an Agent-owned scrollback. */
const AGENT_SCROLL_INTERVAL_MS = 80;

/** xterm's force-selection modifier: Shift on Linux/Windows, Option on macOS. */
export type TerminalForceSelectionModifier = "alt" | "shift";

export interface TerminalMouseSelectionOptions {
  enabled: () => boolean;
  forceModifier?: () => TerminalForceSelectionModifier;
  /** Called once when an edge drag hands scrolling to the Agent. The caller
   * must release the output freeze: the TUI's repaint is what scrolls. */
  onAgentScroll?: () => void;
  /** Whether the Agent can act on forwarded wheel reports (live attachment).
   * Read-only history panes keep the selection instead. */
  canAgentScroll?: () => boolean;
}

/** Keep Agent clicks/wheels, but let ordinary drags select terminal text.
 * Modifier drags (and the platform's own force-selection modifier) remain
 * xterm's responsibility. Replay through DOM so xterm owns selection geometry,
 * wide characters, rendering, auto-scroll and Linux primary selection.
 *
 * Alternate-screen TUIs keep their transcript themselves and have no local
 * scrollback, so xterm cannot auto-scroll a drag that leaves the screen. There
 * the gesture is handed back to the Agent as wheel reports instead. */
export function installTerminalMouseSelection(
  term: Terminal,
  container: HTMLElement,
  options: TerminalMouseSelectionOptions,
): () => void {
  const {
    enabled,
    forceModifier = () => "shift",
    onAgentScroll,
    canAgentScroll,
  } = options;
  const doc = container.ownerDocument;
  const win = doc.defaultView!;
  let replaying = false;
  let suppressClick = false;
  let wheelTimer: number | null = null;
  let wheelDirection: -1 | 0 | 1 = 0;
  let gesture: {
    down: MouseEvent;
    target: EventTarget;
    last: MouseEvent;
    dragging: boolean;
    forwarding: boolean;
  } | null = null;

  const screenElement = () =>
    term.element?.querySelector<HTMLElement>(".xterm-screen") ?? term.element ?? null;

  /** Whether the active buffer's history belongs to the Agent (alternate
   * screen) or is absent, i.e. xterm has nothing local to auto-scroll. */
  const agentOwnsScrollback = (): boolean => {
    if ((term.modes?.mouseTrackingMode ?? "none") === "none") return false;
    const buffer = term.buffer?.active;
    if (!buffer) return false;
    return buffer.type !== "normal" || buffer.baseY === 0;
  };

  /** Top/bottom edge zone, including the outermost rows: TUIs start their own
   * selection auto-scroll as soon as the pointer reaches the edge row, so a
   * pointer that only stops at the last row must count too. */
  const edgeDirection = (event: MouseEvent): -1 | 0 | 1 => {
    const screen = screenElement();
    if (!screen) return 0;
    const rect = screen.getBoundingClientRect();
    if (event.clientY < rect.top) return -1;
    if (event.clientY >= rect.bottom) return 1;
    const rowHeight = rect.height / Math.max(1, term.rows);
    const offset = event.clientY - rect.top;
    if (offset < rowHeight) return -1;
    if (offset >= rect.height - rowHeight) return 1;
    return 0;
  };

  const consume = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const replay = (
    target: EventTarget,
    event: MouseEvent,
    type = event.type,
    force = false,
  ) => {
    const modifier = force ? forceModifier() : null;
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
        altKey: modifier === "alt" || event.altKey,
        metaKey: event.metaKey,
        shiftKey: modifier === "shift" || event.shiftKey,
      }));
    } finally {
      replaying = false;
    }
  };
  const emitAgentWheel = (event: MouseEvent) => {
    const target = term.element;
    const screen = screenElement();
    if (!target || !screen || wheelDirection === 0) return;
    const rect = screen.getBoundingClientRect();
    const clientX = Math.min(Math.max(event.clientX, rect.left + 1), rect.right - 1);
    const clientY = Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1);
    // xterm's mouse-protocol wheel listener encodes this into the wire report
    // the TUI understands; keep it off the container so no viewport intent is
    // recorded for the synthetic gesture.
    target.dispatchEvent(new WheelEvent("wheel", {
      bubbles: false,
      cancelable: true,
      clientX,
      clientY,
      deltaY: wheelDirection < 0 ? -120 : 120,
      deltaMode: 0,
    }));
  };
  const stopAgentScroll = () => {
    if (wheelTimer !== null) {
      win.clearInterval(wheelTimer);
      wheelTimer = null;
    }
    wheelDirection = 0;
  };
  const startWheelTimer = () => {
    if (wheelTimer !== null) return;
    wheelTimer = win.setInterval(() => {
      const current = gesture;
      if (!current?.forwarding) {
        stopAgentScroll();
        return;
      }
      wheelDirection = edgeDirection(current.last);
      if (wheelDirection === 0) {
        stopAgentScroll();
        return;
      }
      emitAgentWheel(current.last);
    }, AGENT_SCROLL_INTERVAL_MS);
  };
  const startAgentScroll = () => {
    const active = gesture;
    if (!active || active.forwarding) return;
    // The TUI repaints as it scrolls, which erases the local selection, so end
    // xterm's drag first and let the Agent own the rest of the gesture.
    active.forwarding = true;
    replay(doc, active.last, "mouseup");
    term.clearSelection?.();
    onAgentScroll?.();
    wheelDirection = edgeDirection(active.last);
    if (wheelDirection === 0) return;
    emitAgentWheel(active.last);
    startWheelTimer();
  };
  const cancel = () => {
    stopAgentScroll();
    const active = gesture;
    gesture = null;
    if (active?.dragging && !active.forwarding) {
      // Only the mousedown needs the force modifier; repeating it on mouseup
      // makes xterm treat the release as an Option-click cursor move.
      replay(doc, active.last, "mouseup");
    }
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
    gesture = {
      down: event,
      target: term.element,
      last: event,
      dragging: false,
      forwarding: false,
    };
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
    if (!active.dragging) return;
    if (active.forwarding) {
      // The timer owns scrolling. Restart it when the pointer pushes an edge
      // again; the local selection stays ended either way.
      wheelDirection = edgeDirection(event);
      if (wheelDirection !== 0) startWheelTimer();
      return;
    }
    if (
      agentOwnsScrollback() &&
      (canAgentScroll?.() ?? true) &&
      edgeDirection(event) !== 0
    ) {
      startAgentScroll();
      return;
    }
    // Dispatch on document, not the screen: ANY mouse mode would otherwise
    // report this move before xterm's document-level selection listener.
    replay(doc, event, "mousemove");
  };
  const onMouseUp = (event: MouseEvent) => {
    const active = gesture;
    if (replaying || !active || event.button !== 0) return;
    stopAgentScroll();
    gesture = null;
    consume(event);
    if (active.dragging) {
      if (!active.forwarding) replay(doc, event, "mouseup");
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
