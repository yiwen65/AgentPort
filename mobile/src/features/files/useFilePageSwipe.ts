import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

interface FilePageSwipeOptions {
  containerRef: RefObject<HTMLDivElement>;
  active: boolean;
  previewVisible: boolean;
  hasPreview: boolean;
  onShowTree: () => void;
  onShowPreview: () => void;
}

interface Sample { x: number; at: number }
interface Gesture {
  id: number;
  x: number;
  y: number;
  at: number;
  width: number;
  preview: boolean;
  locked: boolean;
  samples: Sample[];
}

const LOCK_DISTANCE = 8;
const LONG_PRESS_MS = 450;
const VELOCITY_WINDOW_MS = 120;
// Keep this just above the track's 220ms transition; reduced motion settles immediately.
const SETTLE_MS = 250;
const EXCLUDED = "[data-horizontal-scroll], [data-no-page-swipe], input, textarea, select, [contenteditable]:not([contenteditable=false]), a, [role=link], [role=menu], [role=menuitem], [role=dialog], .modal-backdrop, .centered-modal-backdrop";

function excludedTarget(target: EventTarget | null, container: HTMLElement) {
  const element = target instanceof Element ? target : null;
  if (!element || !container.contains(element)) return true;
  // The preview's ancestor may exclude App's outer gesture, not this inner one.
  const excluded = element.closest(EXCLUDED);
  if (excluded && excluded !== container && !excluded.matches(".files-preview-page[data-no-page-swipe]")) return true;
  const control = element.closest("button, [role=button], summary");
  return !!control && !control.matches(".files-row[data-page-swipe]");
}

/**
 * Two mounted panes, each one viewport wide, on a .files-page-track whose base
 * transform is controlled by previewVisible. CSS must add --file-swipe-offset
 * to that base, disable track transitions for [data-file-swiping], and otherwise
 * transition transform for 220ms (0ms for prefers-reduced-motion).
 * DOM writes handle movement; React only sees lock/release, not every touchmove.
 */
export function useFilePageSwipe(options: FilePageSwipeOptions): { dragging: boolean } {
  const { containerRef, active, previewVisible, hasPreview } = options;
  const latest = useRef(options);
  const cancelRef = useRef<(() => void) | undefined>();
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const previous = latest.current;
    latest.current = options;
    // React runs the old listener effect's cleanup before this layout effect
    // when active changes, so reset state explicitly as well as resetting DOM.
    if (!active) setDragging(false);
    if (!active || previous.previewVisible !== previewVisible || previous.hasPreview !== hasPreview) cancelRef.current?.();
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !active) return;
    let gesture: Gesture | undefined;
    // Cancelled owned gestures must still consume their eventual touchend.
    let consumeUntilEnd = false;
    let allowNativeTouch = false;
    let settling: ReturnType<typeof setTimeout> | undefined;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let suppressClick = false;
    let mounted = true;

    const offset = (x: number) => container.style.setProperty("--file-swipe-offset", `${x}px`);
    const selected = () => !!window.getSelection()?.toString();
    const consume = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    const clearClickSuppression = () => {
      suppressClick = false;
      clearTimeout(clickTimer);
    };
    const suppressNextClick = () => {
      suppressClick = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => { suppressClick = false; }, 450);
    };
    const clearSettling = () => {
      clearTimeout(settling);
      settling = undefined;
      container.removeAttribute("data-file-settling");
    };
    const reset = () => {
      if (gesture?.locked) { consumeUntilEnd = true; suppressNextClick(); }
      gesture = undefined;
      clearSettling();
      container.removeAttribute("data-file-swiping");
      offset(0);
      if (mounted) setDragging(false);
    };
    cancelRef.current = reset;

    const rejectSelectionOrHold = () => {
      const owned = !!gesture?.locked;
      reset();
      consumeUntilEnd = true;
      allowNativeTouch = !owned;
    };
    const sample = (current: Gesture, x: number, at: number) => {
      current.samples.push({ x, at });
      current.samples = current.samples.filter(point => point.at >= at - VELOCITY_WINDOW_MS);
    };
    const onStart = (event: TouchEvent) => {
      // A second finger cannot restart the recognizer or leak an owned gesture.
      if (event.touches.length !== 1) {
        const owned = !!gesture?.locked || consumeUntilEnd;
        reset();
        if (owned) { consumeUntilEnd = true; consume(event); }
        return;
      }
      if (settling) {
        consumeUntilEnd = true;
        allowNativeTouch = true;
        suppressNextClick();
        // Block another navigation layer, but do not block native vertical
        // scrolling when a reader touches again during the brief transition.
        event.stopPropagation();
        return;
      }
      if (gesture?.locked || consumeUntilEnd) {
        consume(event);
        return;
      }
      reset();
      consumeUntilEnd = false;
      allowNativeTouch = false;
      // A fresh single-finger press after settling is not the previous drag's
      // compatibility click, including when its target is an excluded control.
      clearClickSuppression();
      if (!latest.current.active || selected() || excludedTarget(event.target, container)) return;
      const width = container.clientWidth || container.getBoundingClientRect().width;
      if (!width) return;
      const touch = event.touches[0];
      const at = performance.now();
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at, width,
        preview: latest.current.previewVisible, locked: false, samples: [{ x: touch.clientX, at }] };
    };
    const onMove = (event: TouchEvent) => {
      if (consumeUntilEnd) {
        if (allowNativeTouch) event.stopPropagation();
        else consume(event);
        return;
      }
      const current = gesture;
      if (!current) return;
      const touch = event.touches[0];
      if (selected()) {
        rejectSelectionOrHold();
        if (allowNativeTouch) event.stopPropagation();
        else consume(event);
        return;
      }
      if (event.touches.length !== 1 || touch.identifier !== current.id) {
        const owned = current.locked;
        reset();
        if (owned) consume(event);
        return;
      }
      const at = performance.now();
      const dx = touch.clientX - current.x;
      const dy = touch.clientY - current.y;
      if (!current.locked) {
        // A hold/selection must not later fall through to App's tree-back
        // gesture; vertical-first motion stays fully native and observable.
        if (at - current.at > LONG_PRESS_MS) {
          rejectSelectionOrHold();
          event.stopPropagation();
          return;
        }
        if (Math.abs(dy) > LOCK_DISTANCE && Math.abs(dy) >= Math.abs(dx)) {
          gesture = undefined;
          return;
        }
        if (Math.abs(dx) <= LOCK_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.25) return;
        if ((current.preview && dx < 0) || (!current.preview && (dx > 0 || !latest.current.hasPreview))) {
          gesture = undefined;
          return;
        }
        current.locked = true;
        container.setAttribute("data-file-swiping", "true");
        setDragging(true);
      }
      consume(event);
      sample(current, touch.clientX, at);
      const directed = current.preview ? dx : -dx;
      const damped = directed < 0 ? directed * 0.18 : directed > current.width
        ? current.width + (directed - current.width) * 0.18 : directed;
      offset(current.preview ? damped : -damped);
    };
    const onEnd = (event: TouchEvent) => {
      if (consumeUntilEnd) {
        if (allowNativeTouch) event.stopPropagation();
        else consume(event);
        if (!event.touches.length) { consumeUntilEnd = false; allowNativeTouch = false; }
        return;
      }
      const current = gesture;
      gesture = undefined;
      if (!current?.locked) return;
      consume(event);
      suppressNextClick();
      const touch = event.changedTouches[0];
      if (event.touches.length || event.changedTouches.length !== 1 || touch.identifier !== current.id || selected()) {
        consumeUntilEnd = !!event.touches.length;
        reset();
        return;
      }
      const at = performance.now();
      sample(current, touch.clientX, at);
      const first = current.samples[0];
      const velocity = at > first.at ? (touch.clientX - first.x) / (at - first.at) : 0;
      const direction = current.preview ? 1 : -1;
      const distance = (touch.clientX - current.x) * direction;
      const commit = distance >= Math.max(64, current.width * 0.28)
        || (distance >= 24 && velocity * direction >= 0.45);

      // Establish the dragged visual before enabling the transition. Native
      // events are React-batched: synchronously commit the new base transform
      // before removing the offset, so there is no old-page zero-offset frame.
      container.querySelector(".files-page-track")?.getBoundingClientRect();
      container.setAttribute("data-file-settling", "true");
      container.removeAttribute("data-file-swiping");
      flushSync(() => {
        setDragging(false);
        if (commit) {
          if (current.preview) latest.current.onShowTree();
          else latest.current.onShowPreview();
        }
      });
      offset(0);
      // A committed render may call reset() via the layout seam; restore the
      // settling guard after that render so a rapid second gesture cannot jump.
      container.setAttribute("data-file-settling", "true");
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      settling = setTimeout(clearSettling, reduced ? 0 : SETTLE_MS);
    };
    const onCancel = (event: TouchEvent) => {
      const owned = !!gesture?.locked || consumeUntilEnd;
      reset();
      if (owned) consume(event);
      consumeUntilEnd = false;
      allowNativeTouch = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      const capabilities = (event as PointerEvent & { sourceCapabilities?: { firesTouchEvents: boolean } | null }).sourceCapabilities;
      // Touch-origin compatibility mouse events must not clear the old drag's
      // suppression. Touch input is cleared only by the fresh touchstart above.
      if (event.pointerType === "mouse" && !capabilities?.firesTouchEvents
        && !settling && !gesture?.locked && !consumeUntilEnd) clearClickSuppression();
    };
    const onClick = (event: MouseEvent) => {
      // Touch compatibility clicks have detail > 0; preserve keyboard activation.
      if (suppressClick && event.detail > 0) {
        consume(event);
        clearClickSuppression();
      }
    };
    const onHidden = () => { if (document.hidden) reset(); };
    const onSelection = () => { if (gesture && selected()) rejectSelectionOrHold(); };
    const onBlur = () => reset();
    container.addEventListener("touchstart", onStart, { capture: true, passive: false });
    container.addEventListener("touchmove", onMove, { capture: true, passive: false });
    container.addEventListener("touchend", onEnd, { capture: true, passive: false });
    container.addEventListener("touchcancel", onCancel, { capture: true, passive: false });
    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("click", onClick, true);
    document.addEventListener("visibilitychange", onHidden);
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    offset(0);
    return () => {
      mounted = false;
      reset();
      clearTimeout(clickTimer);
      cancelRef.current = undefined;
      container.removeEventListener("touchstart", onStart, true);
      container.removeEventListener("touchmove", onMove, true);
      container.removeEventListener("touchend", onEnd, true);
      container.removeEventListener("touchcancel", onCancel, true);
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("click", onClick, true);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [active, containerRef]);

  return { dragging };
}
