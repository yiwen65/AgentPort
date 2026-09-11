// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { applyUiLanguage } from "../i18n";
import { getState, resolveConfirm, setState } from "../store";
import type { AdapterInstall, NotificationSetup } from "../types";
import NotificationSetupPanel from "./NotificationSetupPanel";

const install: AdapterInstall = {
  agentType: "claude", executablePath: "/chosen/claude", versionText: "test", capabilityHash: "sha256:test",
  exactResume: true, hookStatus: "supported", approvalModel: "native_prompts", defaultTransport: "pty",
  probedAt: "2026-09-10T00:00:00Z", candidates: [], flags: [],
};
function setup(state: NotificationSetup["state"] = "ready"): NotificationSetup {
  return {
    agent: "claude", state, strategy: "session-hooks",
    events: { completed: "hook", needsInput: state === "degraded" ? "heuristic" : "native", failed: "process" },
    detail: "fixture technical detail", checkedAt: "2026-09-10T00:00:00Z",
  };
}
function claudeRow() {
  return screen.getByRole("rowheader", { name: "Claude Code" }).closest("tr")!;
}

beforeEach(async () => {
  await applyUiLanguage("en-US", { persistHint: false });
  setState({ adapters: [install], confirm: null });
  vi.spyOn(api, "notificationSetups").mockResolvedValue([setup()]);
  vi.spyOn(api, "probeAgent").mockResolvedValue({
    agent: "claude", displayName: "Claude Code", state: "available", reason: null,
    install, candidates: [], notificationSetup: setup(),
  });
  vi.spyOn(api, "rollbackNotificationSetup").mockResolvedValue({ ...setup("unavailable"), strategy: "none" });
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await applyUiLanguage("zh-CN", { persistHint: false });
});

describe("Agent notification readiness", () => {
  it("offers a safe update without a destructive rollback or changing CLI selection", async () => {
    vi.mocked(api.notificationSetups).mockResolvedValue([{ ...setup(), updateAvailable: true }]);
    render(<NotificationSetupPanel />);
    const button = await screen.findByText("Safely update integration");
    expect(screen.getByText(/Integration update available/)).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(api.probeAgent).toHaveBeenCalledWith("claude", "/chosen/claude"));
    await waitFor(() => expect(screen.queryByText("Safely update integration")).toBeNull());
    expect(api.rollbackNotificationSetup).not.toHaveBeenCalled();
    expect(getState().adapters).toEqual([install]);
  });

  it("shows all fourteen Agents, separate CLI availability, and three event sources", async () => {
    render(<NotificationSetupPanel />);
    await waitFor(() => expect(within(claudeRow()).getByText("Ready")).toBeTruthy());
    expect(screen.getAllByRole("row")).toHaveLength(15);
    expect(screen.queryByRole("rowheader", { name: "Shell" })).toBeNull();
    expect(within(claudeRow()).getByText("Available")).toBeTruthy();
    expect(within(claudeRow()).getByText("Hook")).toBeTruthy();
    expect(within(claudeRow()).getByText("Native event")).toBeTruthy();
    expect(within(claudeRow()).getByText("Process event")).toBeTruthy();
    expect(within(claudeRow()).getByText(/fixture technical detail/)).toBeTruthy();
    expect(screen.getByText(/Existing Sessions are not restarted/)).toBeTruthy();
    expect(screen.getAllByText("Not detected")).toHaveLength(13);
  });

  it("shows partial coverage honestly and does not equate heuristics with exact events", async () => {
    vi.mocked(api.notificationSetups).mockResolvedValue([setup("degraded")]);
    render(<NotificationSetupPanel />);
    await waitFor(() => expect(within(claudeRow()).getByText("Partial / degraded")).toBeTruthy());
    expect(within(claudeRow()).getByText("Heuristic (not exact)")).toBeTruthy();
  });

  it("does not claim notification readiness when a previously configured CLI is missing", async () => {
    setState({ adapters: [] });
    render(<NotificationSetupPanel />);
    await waitFor(() => expect(screen.queryByText("Reading notification setup…")).toBeNull());
    expect(within(claudeRow()).queryByText("Ready")).toBeNull();
    expect(within(claudeRow()).getByText("Not detected")).toBeTruthy();
    expect(within(claudeRow()).getByRole("button", { name: /Roll back/ })).toBeTruthy();
  });

  it("retries the selected executable without hiding an available CLI on setup failure", async () => {
    vi.mocked(api.probeAgent).mockResolvedValue({
      agent: "claude", displayName: "Claude Code", state: "available", reason: null,
      install, candidates: [], notificationSetup: { ...setup("failed"), detail: "Permission denied: fixture" },
    });
    const onBusyChange = vi.fn();
    render(<NotificationSetupPanel onBusyChange={onBusyChange} />);
    await waitFor(() => expect(within(claudeRow()).getByText("Ready")).toBeTruthy());
    fireEvent.click(within(claudeRow()).getByRole("button", { name: /Probe and configure/ }));
    await waitFor(() => expect(within(claudeRow()).getByText("Setup failed")).toBeTruthy());
    expect(api.probeAgent).toHaveBeenCalledWith("claude", "/chosen/claude");
    expect(getState().adapters).toEqual([install]);
    expect(within(claudeRow()).getByText("Available")).toBeTruthy();
    expect(within(claudeRow()).getByText(/Permission denied/)).toBeTruthy();
    expect(claudeRow().querySelector("details")?.open).toBe(true);
    expect(onBusyChange).toHaveBeenCalledWith(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("preserves the CLI selection after a probe exception and offers retry", async () => {
    vi.mocked(api.probeAgent).mockRejectedValue(new Error("probe timeout"));
    render(<NotificationSetupPanel />);
    fireEvent.click(within(claudeRow()).getByRole("button", { name: /Probe and configure/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("probe timeout"));
    expect(getState().adapters).toEqual([install]);
    expect((within(claudeRow()).getByRole("button", { name: /Probe and configure/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("requires explicit rollback confirmation and leaves CLI/channels unchanged", async () => {
    render(<NotificationSetupPanel />);
    const rollback = await within(claudeRow()).findByRole("button", { name: /Roll back/ });
    fireEvent.click(rollback);
    expect(api.rollbackNotificationSetup).not.toHaveBeenCalled();
    expect(getState().confirm?.body).toContain("Later user edits will not be overwritten");
    await act(async () => resolveConfirm(false));
    expect(api.rollbackNotificationSetup).not.toHaveBeenCalled();
    fireEvent.click(rollback);
    await act(async () => resolveConfirm(true));
    expect(api.rollbackNotificationSetup).toHaveBeenCalledWith("claude");
    expect(getState().adapters).toEqual([install]);
    expect(within(claudeRow()).queryByText("Ready")).toBeNull();
  });

  it("preserves the displayed setup and CLI when rollback detects user edits", async () => {
    vi.mocked(api.rollbackNotificationSetup).mockRejectedValue(new Error("preserving user edits"));
    render(<NotificationSetupPanel />);
    fireEvent.click(await within(claudeRow()).findByRole("button", { name: /Roll back/ }));
    await act(async () => resolveConfirm(true));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("preserving user edits"));
    expect(within(claudeRow()).getByText("Ready")).toBeTruthy();
    expect(getState().adapters).toEqual([install]);
  });

  it("does not offer a meaningless rollback for an unconfigured installation", async () => {
    vi.mocked(api.notificationSetups).mockResolvedValue([{ ...setup("unavailable"), strategy: "none" }]);
    render(<NotificationSetupPanel />);
    await waitFor(() => expect(screen.queryByText("Reading notification setup…")).toBeNull());
    expect(within(claudeRow()).queryByRole("button", { name: /Roll back/ })).toBeNull();
    expect(within(claudeRow()).getByRole("button", { name: /Probe and configure/ })).toBeTruthy();
  });

  it("shows load errors and refreshes without probing or changing native configuration", async () => {
    vi.mocked(api.notificationSetups).mockRejectedValueOnce(new Error("status read denied"));
    render(<NotificationSetupPanel />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("status read denied"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    await waitFor(() => expect(within(claudeRow()).getByText("Ready")).toBeTruthy());
    expect(api.probeAgent).not.toHaveBeenCalled();
    expect(api.rollbackNotificationSetup).not.toHaveBeenCalled();
  });

  it("does not let a stale status request overwrite a newer successful setup", async () => {
    let resolveOld!: (setups: NotificationSetup[]) => void;
    vi.mocked(api.notificationSetups).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    render(<NotificationSetupPanel />);
    fireEvent.click(within(claudeRow()).getByRole("button", { name: /Probe and configure/ }));
    await waitFor(() => expect(within(claudeRow()).getByText("Ready")).toBeTruthy());
    await act(async () => resolveOld([setup("failed")]));
    expect(within(claudeRow()).getByText("Ready")).toBeTruthy();
    expect(within(claudeRow()).queryByText("Setup failed")).toBeNull();
  });
});
