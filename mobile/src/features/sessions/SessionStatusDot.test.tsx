import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n";
import { SessionStatusDot, sessionDisplayState, sessionDotClass } from "./SessionStatusDot";
import type { SessionSummary } from "./types";

const session = (state = "working", lifecycle = "running") => ({
  lifecycle, hostAlive: true,
  latestStatus: { state },
} as SessionSummary);
beforeEach(async () => { await i18n.changeLanguage("en-US"); });
afterEach(cleanup);

describe("session state presentation", () => {
  it.each(["creating", "exited", "interrupted", "stopped"])("lifecycle %s overrides old working state", (lifecycle) => {
    expect(sessionDisplayState(session("working", lifecycle))).toBe(lifecycle);
  });
  it("does not equate missing or unrecognized status with running or success", () => {
    expect(sessionDisplayState({ lifecycle: "running" } as SessionSummary)).toBe("unknown");
    expect(sessionDisplayState(session("future-state"))).toBe("unknown");
    expect(sessionDisplayState(session("idle", "future-lifecycle"))).toBe("unknown");
  });
  it("shows ended, not failed, because SessionSummary has no exit-code evidence", () => {
    render(<SessionStatusDot session={session("working", "exited")} />);
    expect(screen.getByText("Ended")).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });
  it.each([["working", "Working"], ["needs_input", "Needs input"], ["idle", "Idle"], ["unknown", "Unknown"]])("gives %s a text label and a desktop dot class", (state, label) => {
    const { container } = render(<SessionStatusDot session={session(state)} />);
    expect(screen.getByText(label).closest(".visually-hidden")).not.toBeNull();
    const dot = container.querySelector(".session-status-dot");
    expect(dot).toHaveClass(state);
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });
  it("draws ended sessions with the desktop stopped dot", () => {
    expect(sessionDotClass(session("working", "exited"))).toBe("stopped");
    const { container } = render(<SessionStatusDot session={session("working", "exited")} />);
    expect(container.querySelector(".session-status-dot")).toHaveClass("stopped");
  });
  it.each(["cached", "dead host"])("marks %s as last-known and suppresses live motion", (reason) => {
    const value = session();
    if (reason === "dead host") value.hostAlive = false;
    const { container } = render(<SessionStatusDot session={value} stale={reason === "cached"} />);
    expect(screen.getByText(/Last known/)).toBeInTheDocument();
    expect(container.querySelector(".session-status-dot")).toHaveClass("is-cached");
  });
  it("localizes status without conflating unread completion with current work", async () => {
    await i18n.changeLanguage("zh-CN");
    render(<SessionStatusDot session={{ ...session("idle"), unreadAttention: true, latestAttentionKind: "turn_completed" }} />);
    expect(screen.getByText("空闲")).toBeInTheDocument();
    expect(screen.queryByText("等待输入")).not.toBeInTheDocument();
  });
});
