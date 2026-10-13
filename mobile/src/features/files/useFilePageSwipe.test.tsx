import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFilePageSwipe } from "./useFilePageSwipe";

let now = 0;
const point = (x: number, y = 100, identifier = 1) => ({ clientX: x, clientY: y, identifier });
function touch(target: Element, type: string, x: number, y = 100, count = 1, identifier = 1) {
  const finger = point(x, y, identifier);
  const ending = type === "touchend" || type === "touchcancel";
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    touches: { value: ending ? [] : count === 2 ? [finger, point(x + 10, y, 2)] : [finger] },
    changedTouches: { value: [finger] },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}
function mount({ preview = true, hasPreview = true, active = true, reduced = false } = {}) {
  const tree = vi.fn();
  const showPreview = vi.fn();
  const parentEnd = vi.fn();
  const rowClick = vi.fn();
  const renders = vi.fn();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
  function Harness(props: { active: boolean; hasPreview: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(preview);
    renders();
    const { dragging } = useFilePageSwipe({ containerRef: ref, active: props.active, previewVisible: visible,
      hasPreview: props.hasPreview, onShowTree: () => { tree(); setVisible(false); },
      onShowPreview: () => { showPreview(); setVisible(true); } });
    return <div onTouchEnd={parentEnd}><div ref={ref} data-testid="viewport" data-visible={visible} data-dragging={dragging}>
      <div className="files-page-track" style={{ transform: visible ? "translateX(-100%)" : "translateX(0)" }}>
        <div data-testid="body">Ordinary text</div>
        <button className="files-row" data-page-swipe="true" onClick={rowClick}>File</button>
        <button data-testid="control">Action</button><a href="#" data-testid="link">Link</a>
        <input data-testid="input" /><textarea data-testid="textarea" />
        <div contentEditable data-testid="editable" /><div role="menu" data-testid="menu" />
        <pre data-horizontal-scroll data-testid="code">code</pre>
        <div className="files-preview-page" data-no-page-swipe><span data-testid="preview-text">Preview text</span></div>
      </div>
    </div></div>;
  }
  const view = render(<Harness active={active} hasPreview={hasPreview} />);
  const viewport = view.getByTestId("viewport");
  Object.defineProperty(viewport, "clientWidth", { value: 390 });
  const body = view.getByTestId("body");
  return { ...view, viewport, body, tree, showPreview, parentEnd, rowClick, renders,
    update: (next: { active: boolean; hasPreview: boolean }) => view.rerender(<Harness {...next} />) };
}
const offset = (element: HTMLElement) => element.style.getPropertyValue("--file-swipe-offset");
function swipe(target: Element, from: number, to: number, elapsed = 200) {
  touch(target, "touchstart", from);
  now += elapsed;
  const move = touch(target, "touchmove", to);
  now += 10;
  const end = touch(target, "touchend", to);
  return { move, end };
}

beforeEach(() => {
  now = 0;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useFilePageSwipe", () => {
  it("displaces synchronously and does not rerender on every move; short slow drags rebound", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 100;
    const move = touch(view.body, "touchmove", 118);
    expect(move.defaultPrevented).toBe(true);
    expect(offset(view.viewport)).toBe("18px");
    expect(view.viewport).toHaveAttribute("data-file-swiping", "true");
    expect(view.viewport).toHaveAttribute("data-dragging", "true");
    const renderCount = view.renders.mock.calls.length;
    now = 200; touch(view.body, "touchmove", 122);
    expect(offset(view.viewport)).toBe("22px");
    expect(view.renders).toHaveBeenCalledTimes(renderCount);
    now = 350; const end = touch(view.body, "touchend", 122);
    expect(end.defaultPrevented).toBe(true);
    expect(view.parentEnd).not.toHaveBeenCalled();
    expect(view.tree).not.toHaveBeenCalled();
    expect(offset(view.viewport)).toBe("0px");
    expect(view.viewport).not.toHaveAttribute("data-file-swiping");
    expect(view.viewport).toHaveAttribute("data-file-settling", "true");
    act(() => { vi.advanceTimersByTime(250); });
    expect(view.viewport).not.toHaveAttribute("data-file-settling");
  });

  it.each([true, false])("commits long drags with new base and zero offset in the same event (preview=%s)", preview => {
    const view = mount({ preview });
    const { end } = swipe(view.body, 200, preview ? 340 : 60);
    expect(end.defaultPrevented).toBe(true);
    expect(preview ? view.tree : view.showPreview).toHaveBeenCalledOnce();
    expect(view.viewport).toHaveAttribute("data-visible", String(!preview));
    expect(view.viewport.querySelector(".files-page-track")).toHaveStyle({ transform: preview ? "translateX(0)" : "translateX(-100%)" });
    expect(offset(view.viewport)).toBe("0px");
    expect(view.parentEnd).not.toHaveBeenCalled();
  });

  it.each([true, false])("commits a recent quick flick below the distance threshold (preview=%s)", preview => {
    const view = mount({ preview });
    swipe(view.body, 200, preview ? 240 : 160, 35);
    expect(preview ? view.tree : view.showPreview).toHaveBeenCalledOnce();
  });

  it("measures recent momentum after a long slow beginning, not whole-gesture average", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 100; touch(view.body, "touchmove", 110);
    now = 700; touch(view.body, "touchmove", 112);
    now = 730; touch(view.body, "touchmove", 150);
    now = 740; touch(view.body, "touchend", 154);
    expect(view.tree).toHaveBeenCalledOnce();
  });

  it("does not reuse old momentum after a pause at release", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 145);
    now = 300; touch(view.body, "touchend", 145);
    expect(view.tree).not.toHaveBeenCalled();
  });

  it("locks vertical first and leaves ordinary scrolling and parent observation alone", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; const first = touch(view.body, "touchmove", 103, 120);
    now = 80; const diagonal = touch(view.body, "touchmove", 300, 130);
    const end = touch(view.body, "touchend", 300, 130);
    expect(first.defaultPrevented).toBe(false);
    expect(diagonal.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(view.tree).not.toHaveBeenCalled();
    expect(view.parentEnd).toHaveBeenCalledOnce();
    expect(offset(view.viewport)).toBe("0px");
  });

  it.each(["code", "control", "link", "input", "textarea", "editable", "menu"])("does not take over %s", name => {
    const view = mount();
    const { move, end } = swipe(view.getByTestId(name), 100, 300);
    expect(move.defaultPrevented).toBe(false);
    expect(end.defaultPrevented).toBe(false);
    expect(view.tree).not.toHaveBeenCalled();
  });

  it("recognizes normal preview text inside App's no-page-swipe wrapper", () => {
    const view = mount();
    swipe(view.getByTestId("preview-text"), 100, 300);
    expect(view.tree).toHaveBeenCalledOnce();
  });

  it("permits row swipes but consumes the compatibility click, not keyboard activation", () => {
    const view = mount({ preview: false });
    const row = view.getByRole("button", { name: "File" });
    swipe(row, 250, 100);
    fireEvent.click(row, { detail: 1 });
    expect(view.rowClick).not.toHaveBeenCalled();
    fireEvent.click(row, { detail: 0 });
    expect(view.rowClick).toHaveBeenCalledOnce();
  });

  it("accepts a deliberate excluded-button touch after settling instead of swallowing its click", () => {
    const view = mount();
    const control = view.getByTestId("control");
    const clicked = vi.fn();
    control.addEventListener("click", clicked);
    swipe(view.body, 100, 300);
    act(() => { vi.advanceTimersByTime(300); });
    touch(control, "touchstart", 200);
    touch(control, "touchend", 200);
    fireEvent.click(control, { detail: 1 });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("accepts a genuine new mouse press after settling", () => {
    const view = mount();
    const control = view.getByTestId("control");
    const clicked = vi.fn();
    control.addEventListener("click", clicked);
    swipe(view.body, 100, 300);
    act(() => { vi.advanceTimersByTime(300); });
    const down = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    fireEvent(control, down);
    fireEvent.click(control, { detail: 1 });
    expect(clicked).toHaveBeenCalledOnce();
  });

  it.each(["touch", "touch-generated-mouse"])("keeps ghostclick suppression for %s pointer events", type => {
    const view = mount({ preview: false });
    const row = view.getByRole("button", { name: "File" });
    swipe(row, 250, 100);
    act(() => { vi.advanceTimersByTime(300); });
    const down = new Event("pointerdown", { bubbles: true });
    Object.defineProperties(down, {
      pointerType: { value: type === "touch" ? "touch" : "mouse" },
      sourceCapabilities: { value: { firesTouchEvents: true } },
    });
    fireEvent(row, down);
    fireEvent.click(row, { detail: 1 });
    expect(view.rowClick).not.toHaveBeenCalled();
  });

  it("does not let a new press bypass the settling guard", () => {
    const view = mount({ preview: false });
    const row = view.getByRole("button", { name: "File" });
    swipe(row, 250, 100);
    const down = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    fireEvent(row, down);
    touch(row, "touchstart", 200);
    touch(row, "touchend", 200);
    fireEvent.click(row, { detail: 1 });
    expect(view.rowClick).not.toHaveBeenCalled();
  });

  it("does not enter an empty preview and leaves tree right swipe to the App", () => {
    const view = mount({ preview: false, hasPreview: false });
    expect(swipe(view.body, 250, 100).end.defaultPrevented).toBe(false);
    expect(swipe(view.body, 100, 250).end.defaultPrevented).toBe(false);
    expect(view.showPreview).not.toHaveBeenCalled();
    expect(view.parentEnd).toHaveBeenCalledTimes(2);
  });

  it("does not recognize a gesture on selected text, or after a new selection/long press", () => {
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as Selection);
    const view = mount();
    expect(swipe(view.body, 100, 300).move.defaultPrevented).toBe(false);
    selection.mockReturnValue({ toString: () => "" } as Selection);
    touch(view.body, "touchstart", 100);
    now += 500; touch(view.body, "touchmove", 300);
    touch(view.body, "touchend", 300);
    expect(view.tree).not.toHaveBeenCalled();
    touch(view.body, "touchstart", 100);
    now += 30; touch(view.body, "touchmove", 120);
    selection.mockReturnValue({ toString: () => "new selection" } as Selection);
    now += 30; touch(view.body, "touchmove", 300);
    const end = touch(view.body, "touchend", 300);
    expect(end.defaultPrevented).toBe(true);
    expect(view.tree).not.toHaveBeenCalled();
    expect(offset(view.viewport)).toBe("0px");
  });

  it.each(["hold", "selection"])("does not let an unlocked %s become App's tree-back gesture", reason => {
    const view = mount({ preview: false });
    touch(view.body, "touchstart", 100);
    if (reason === "hold") {
      now = 500;
      expect(touch(view.body, "touchmove", 300).defaultPrevented).toBe(false);
    } else {
      const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected" } as Selection);
      fireEvent(document, new Event("selectionchange"));
      selection.mockReturnValue({ toString: () => "" } as Selection);
    }
    expect(touch(view.body, "touchend", 300).defaultPrevented).toBe(false);
    expect(view.parentEnd).not.toHaveBeenCalled();
    expect(view.showPreview).not.toHaveBeenCalled();
  });

  it("remembers a selection interruption even if selection clears before release", () => {
    const view = mount();
    const selection = vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "" } as Selection);
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 140);
    selection.mockReturnValue({ toString: () => "selected" } as Selection);
    fireEvent(document, new Event("selectionchange"));
    selection.mockReturnValue({ toString: () => "" } as Selection);
    expect(touch(view.body, "touchend", 300).defaultPrevented).toBe(true);
    expect(view.tree).not.toHaveBeenCalled();
    expect(view.parentEnd).not.toHaveBeenCalled();
    expect(offset(view.viewport)).toBe("0px");
  });

  it("does not own preview-left or a touch that starts inactive", () => {
    const view = mount();
    expect(swipe(view.body, 300, 100).move.defaultPrevented).toBe(false);
    expect(view.tree).not.toHaveBeenCalled();
    view.update({ active: false, hasPreview: true });
    expect(swipe(view.body, 100, 300).move.defaultPrevented).toBe(false);
    expect(view.tree).not.toHaveBeenCalled();
  });

  it.each(["touchstart", "touchmove"])("cancels owned gestures on a second finger (%s), including their final end", type => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 140);
    const multi = touch(view.body, type, 180, 100, 2);
    expect(multi.defaultPrevented).toBe(true);
    expect(offset(view.viewport)).toBe("0px");
    const end = touch(view.body, "touchend", 300);
    expect(end.defaultPrevented).toBe(true);
    expect(view.tree).not.toHaveBeenCalled();
    expect(view.parentEnd).not.toHaveBeenCalled();
  });

  it("resets touchcancel and identifier changes without navigation or parent leakage", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 140);
    const cancel = touch(view.body, "touchcancel", 140);
    expect(cancel.defaultPrevented).toBe(true);
    expect(offset(view.viewport)).toBe("0px");
    touch(view.body, "touchstart", 100);
    now += 30; touch(view.body, "touchmove", 140);
    touch(view.body, "touchmove", 300, 100, 1, 2);
    touch(view.body, "touchend", 300, 100, 1, 2);
    expect(view.tree).not.toHaveBeenCalled();
    expect(view.parentEnd).not.toHaveBeenCalled();
  });

  it.each(["blur", "resize", "hidden", "inactive", "removed-preview"])("resets an interrupted drag on %s", cause => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 140);
    if (cause === "inactive") view.update({ active: false, hasPreview: true });
    else if (cause === "removed-preview") view.update({ active: true, hasPreview: false });
    else if (cause === "hidden") {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      fireEvent(document, new Event("visibilitychange"));
    } else fireEvent(window, new Event(cause));
    expect(offset(view.viewport)).toBe("0px");
    expect(view.viewport).not.toHaveAttribute("data-file-swiping");
    expect(view.viewport).toHaveAttribute("data-dragging", "false");
    if (cause !== "inactive") {
      expect(touch(view.body, "touchend", 300).defaultPrevented).toBe(true);
      expect(view.parentEnd).not.toHaveBeenCalled();
    }
    expect(view.tree).not.toHaveBeenCalled();
  });

  it("removes listeners and pending timers on unmount", () => {
    const view = mount();
    swipe(view.body, 100, 300);
    view.unmount();
    const calls = view.tree.mock.calls.length;
    swipe(view.body, 100, 300);
    act(() => { vi.runAllTimers(); });
    expect(view.tree).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("damps movement past bounds and reverse tails without switching another layer", () => {
    const view = mount();
    touch(view.body, "touchstart", 100);
    now = 30; touch(view.body, "touchmove", 600);
    expect(Number.parseFloat(offset(view.viewport))).toBeCloseTo(409.8);
    now = 100; touch(view.body, "touchmove", 50);
    expect(offset(view.viewport)).toBe("-9px");
    now = 120; touch(view.body, "touchend", 50);
    expect(view.tree).not.toHaveBeenCalled();
    expect(view.parentEnd).not.toHaveBeenCalled();
  });

  it("guards a second gesture while settling and uses immediate reduced-motion cleanup", () => {
    const view = mount({ reduced: true });
    swipe(view.body, 100, 300);
    expect(view.tree).toHaveBeenCalledOnce();
    const blocked = swipe(view.body, 300, 100);
    expect(blocked.move.defaultPrevented).toBe(false);
    expect(blocked.end.defaultPrevented).toBe(false);
    expect(view.showPreview).not.toHaveBeenCalled();
    expect(view.parentEnd).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(0); });
    expect(view.viewport).not.toHaveAttribute("data-file-settling");
    swipe(view.body, 300, 100);
    expect(view.showPreview).toHaveBeenCalledOnce();
  });
});
