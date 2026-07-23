// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { installDesktopEventGuards } from "./desktopEvents";

describe("desktop event guards", () => {
  it("suppresses the WebView native context menu everywhere in the app", () => {
    const uninstall = installDesktopEventGuards();
    const appHandler = vi.fn();
    document.body.addEventListener("contextmenu", appHandler);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });

    document.body.dispatchEvent(event);
    uninstall();

    expect(event.defaultPrevented).toBe(true);
    expect(appHandler).toHaveBeenCalledOnce();
  });
});
