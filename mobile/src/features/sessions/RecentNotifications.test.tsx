import { act, fireEvent, render, screen, cleanup } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecentNotifications } from "./RecentNotifications";
import recentStyles from "./recentNotifications.css?raw";
import type { InboxEntry } from "./attentionInbox";
import type { HostProfileSummary } from "../../protocol/remoteClient";
import { i18n } from "../../i18n";
const entry: InboxEntry = { hostId: "h", sessionId: "s", sessionTitle: "Build", kind: "turn_completed", runId: "r", runOrdinal: 1, sequence: 2, occurredAt: "2026-09-08T00:00:00Z" };
const host = { id: "h", name: "Mac", connectionState: "connected" } as HostProfileSummary;
beforeEach(async () => { await i18n.changeLanguage("en-US"); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(connected = true) {
  const onOpen = vi.fn(), onDismiss = vi.fn();
  render(<RecentNotifications entries={[entry]} hosts={[{ ...host, connectionState: connected ? "connected" : "disconnected" }]} onOpen={onOpen} onDismiss={onDismiss} />);
  return { onOpen, onDismiss, row: screen.getByRole("button", { name: /Build.*Turn completed/ }) };
}
describe("Recent message actions", () => {
  it.each(["opening", "offline"])("keeps the covering surface opaque while %s", state => {
    const style = document.createElement("style");
    style.textContent = recentStyles;
    document.head.append(style);
    try {
      const props = { entries: [entry], hosts: [host], onOpen: vi.fn(), onDismiss: vi.fn() };
      const { rerender } = render(<RecentNotifications {...props} />);
      const row = screen.getByRole("button", { name: /Build.*Turn completed/ });
      if (state === "opening") {
        fireEvent.click(row);
        rerender(<RecentNotifications {...props} opening="h:s" />);
        expect(row).toHaveAttribute("aria-busy", "true");
      } else rerender(<RecentNotifications {...props} hosts={[{ ...host, connectionState: "disconnected" }]} />);
      expect(row).toHaveAttribute("aria-disabled", "true");
      expect(row.closest("li")).not.toHaveClass("is-expanded");
      expect(getComputedStyle(row).opacity || "1").toBe("1");
      expect(getComputedStyle(row.querySelector(".recent-message-copy")!).opacity).toBe("0.8");
    } finally { style.remove(); }
  });
  it("opens without consuming the message until the workspace confirms viewing", () => {
    const { row, onOpen, onDismiss } = setup(); fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith(entry); expect(onDismiss).not.toHaveBeenCalled();
  });
  it("allows offline removal without opening or deleting a Session", async () => {
    const { row, onOpen, onDismiss } = setup(false);
    fireEvent.click(row); expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove notification for Build" }));
    expect(row.closest("li")).toHaveClass("is-removing");
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(entry);
  });
  it("reveals remove on horizontal movement without accidental opening", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { row, onOpen } = setup();
    fireEvent.pointerDown(row, { button: 0, clientX: 180, clientY: 20 });
    fireEvent.pointerMove(row, { clientX: 110, clientY: 22 });
    fireEvent.pointerUp(row); fireEvent.click(row);
    expect(row.closest("li")).toHaveClass("is-expanded"); expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Escape" }); expect(row.closest("li")).not.toHaveClass("is-expanded");
  });
  it("does not reveal remove during vertical scrolling", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { row } = setup();
    fireEvent.pointerDown(row, { button: 0, clientX: 180, clientY: 20 });
    fireEvent.pointerMove(row, { clientX: 170, clientY: 80 }); fireEvent.pointerUp(row);
    expect(row.closest("li")).not.toHaveClass("is-expanded");
  });
  it("does not create React commits for every drag frame", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const commits = vi.fn();
    render(<Profiler id="recent" onRender={commits}><RecentNotifications entries={[entry]} hosts={[host]} onOpen={vi.fn()} onDismiss={vi.fn()} /></Profiler>);
    const row = screen.getByRole("button", { name: /Build.*Turn completed/ });
    commits.mockClear();
    fireEvent.pointerDown(row, { button: 0, clientX: 180, clientY: 20 });
    for (let x = 170; x >= 80; x--) fireEvent.pointerMove(row, { clientX: x, clientY: 20 });
    expect(commits).not.toHaveBeenCalled();
    fireEvent.pointerUp(row); expect(commits).toHaveBeenCalledOnce();
  });
  it("cancels a pending animation on unmount", async () => {
    const { onDismiss } = setup(); fireEvent.click(screen.getByRole("button", { name: "Remove notification for Build" }));
    cleanup(); await vi.advanceTimersByTimeAsync(300); expect(onDismiss).not.toHaveBeenCalled();
  });
});
