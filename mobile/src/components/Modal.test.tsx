import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { Modal } from "./Modal";

function Example() {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open</button>{open ? <Modal title="Choices" onClose={() => setOpen(false)}><button>First</button><button>Last</button></Modal> : null}</>;
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

beforeEach(async () => { await i18n.changeLanguage("en-US"); });

describe("Modal", () => {
  it("isolates the background, traps Tab and restores focus and body state on Escape", () => {
    document.body.style.overflow = "auto";
    const existing = document.createElement("aside");
    existing.setAttribute("inert", "");
    document.body.append(existing);
    const { container } = render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Choices" });
    const close = within(dialog).getByRole("button", { name: "Close" });
    const last = within(dialog).getByRole("button", { name: "Last" });
    expect(close).toHaveFocus();
    expect(container).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("hidden");
    const scroll = window.scrollY;
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(container).not.toHaveAttribute("inert");
    expect(existing).toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("auto");
    expect(window.scrollY).toBe(scroll);
    existing.remove();
    document.body.style.overflow = "";
  });

  it("dismisses only a backdrop click, not content, and supports the close button", () => {
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "First" }));
    expect(dialog).toBeInTheDocument();
    fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("reverses entry on close and releases focus only when the bounded exit finishes", () => {
    const animations: { cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }[] = [];
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => undefined, writable: true });
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => {
      const animation = { cancel: vi.fn(), onfinish: null };
      animations.push(animation);
      return animation as unknown as Animation;
    });
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Open" });
    trigger.focus(); fireEvent.click(trigger);
    expect(animate).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(animate).toHaveBeenCalledTimes(4);
    act(() => animations[3].onfinish?.());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("skips movement and delayed dismissal when reduced motion is requested", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => undefined, writable: true });
    const animate = vi.spyOn(HTMLElement.prototype, "animate").mockImplementation(() => { throw new Error("must not animate"); });
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(animate).not.toHaveBeenCalled();
  });

});
