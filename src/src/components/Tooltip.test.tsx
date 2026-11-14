import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import TooltipHost from "./Tooltip";

function renderHost() {
  return render(
    <div>
      <div data-testid="sidebar">
        <button data-testid="anchor" data-tip="完整 Session 名称">
          Session
        </button>
      </div>
      <div data-testid="terminal" />
      <TooltipHost />
    </div>,
  );
}

describe("TooltipHost", () => {
  afterEach(cleanup);

  it("keeps the tip when an unrelated surface scrolls", () => {
    renderHost();
    fireEvent.mouseOver(screen.getByTestId("anchor"));
    expect(screen.getByRole("tooltip").textContent).toBe("完整 Session 名称");

    fireEvent.scroll(screen.getByTestId("terminal"));

    expect(screen.getByRole("tooltip").textContent).toBe("完整 Session 名称");
  });

  it("dismisses the tip when its own container scrolls", () => {
    renderHost();
    fireEvent.mouseOver(screen.getByTestId("anchor"));

    fireEvent.scroll(screen.getByTestId("sidebar"));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("dismisses the tip when the pointer moves off it", () => {
    renderHost();
    fireEvent.mouseOver(screen.getByTestId("anchor"));
    expect(screen.getByRole("tooltip")).toBeTruthy();

    fireEvent.mouseOver(screen.getByTestId("terminal"));

    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
