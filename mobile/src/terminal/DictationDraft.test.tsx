import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationDraft } from "./DictationDraft";
import "../i18n";
import { i18n } from "../i18n";

afterEach(cleanup);
describe("native dictation draft", () => {
  const setup = () => {
    void i18n.changeLanguage("en-US");
    const insert = vi.fn((_text: string) => true);
    const close = vi.fn();
    const view = render(<DictationDraft available onInsert={insert} onClose={close} />);
    return { insert, close, view, field: screen.getByRole("textbox"), button: screen.getByRole("button", { name: "Insert" }) };
  };
  it("keeps cumulative replacements local and inserts the final value once, without Enter", () => {
    const { field, button, insert, close } = setup();
    for (const value of ["你好", "你好世界", "你好世界你好世界"]) fireEvent.change(field, { target: { value } });
    expect(insert).not.toHaveBeenCalled();
    fireEvent.click(button); fireEvent.click(button);
    expect(insert).toHaveBeenCalledExactlyOnceWith("你好世界你好世界");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("blocks composition and the gesture that began during composition", () => {
    const { field, button, insert } = setup();
    fireEvent.change(field, { target: { value: "draft" } });
    fireEvent.compositionStart(field);
    expect(button).toBeDisabled();
    fireEvent.pointerDown(button);
    fireEvent.compositionEnd(field);
    fireEvent.click(button);
    expect(insert).not.toHaveBeenCalled();
    fireEvent.pointerDown(button); fireEvent.click(button);
    expect(insert).toHaveBeenCalledExactlyOnceWith("draft");
  });
  it("cancels without sending, including during composition", () => {
    const { field, insert, close } = setup();
    fireEvent.compositionStart(field);
    fireEvent.change(field, { target: { value: "discard" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });
  it("retains unavailable drafts and permits intentional repeats in new drafts", () => {
    const { field, button, insert, close, view } = setup();
    fireEvent.change(field, { target: { value: "repeat" } });
    view.rerender(<DictationDraft available={false} onInsert={insert} onClose={close} />);
    fireEvent.click(button); expect(insert).not.toHaveBeenCalled();
    expect(field).toHaveValue("repeat");
    view.rerender(<DictationDraft available onInsert={insert} onClose={close} />);
    fireEvent.click(button);
    view.unmount();
    render(<DictationDraft available onInsert={insert} onClose={close} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "repeat" } });
    fireEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(insert.mock.calls).toEqual([["repeat"], ["repeat"]]);
  });
});
