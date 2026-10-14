import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { HostProfileSummary, RemoteClient, RemoteConnectionStateEvent } from "../../protocol/remoteClient";
import type { SessionSummary } from "./types";
import { SessionDashboard } from "./SessionDashboard";
import { AttentionInbox } from "./attentionInbox";

const hosts: HostProfileSummary[] = ["Studio", "Laptop", "Offline"].map((name, index) => ({
  id: `host-${index + 1}`, name, hostname: "local", port: 22, username: "dev", preferredTransport: "ssh",
  connectionState: index === 2 ? "disconnected" : "connected", lastConnectedAt: null, lastError: null,
}));
function session(title: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: "same-id", title, projectId: "project", presetId: "p", cwd: "/repo", lifecycle: "running",
    resumePrecision: "exact", adapterType: "shell", transport: "pty", permissionMode: "native", hostAlive: true,
    createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", ...overrides };
}
function setup(profiles = hosts) {
  const listeners = new Set<(event: RemoteConnectionStateEvent) => void>();
  const remote: RemoteClient = {
    listHostProfiles: vi.fn().mockResolvedValue(profiles), connect: vi.fn(), disconnect: vi.fn(), subscribe: vi.fn(),
    onConnectionState: vi.fn(async listener => { listeners.add(listener); return async () => { listeners.delete(listener); }; }),
    request: vi.fn(async (id, method) => {
      if (method === "session.list") return [session(id === "host-1" ? "Studio shell" : "Laptop task", { unreadAttention: id === "host-2" })];
      if (method === "project.list") return [{ id: "project", name: `${id} project`, rootPath: "/repo", pinned: false, sortOrder: 0 }];
      if (method === "agent.supported") return [];
      if (method === "agent.preferences") return { revision: 1, agentOrder: [], agentHidden: [] };
      if (method === "attention.poll") return { events: [] };
      return {};
    }) as RemoteClient["request"],
  };
  return { remote, emit: (event: RemoteConnectionStateEvent) => listeners.forEach(listener => listener(event)) };
}
async function showActive() {
  await screen.findByRole("combobox", { name: "Current device" });
  fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
}
const lists = (remote: RemoteClient) => vi.mocked(remote.request).mock.calls.filter(([, method]) => method === "session.list");

describe("Global mobile Active Sessions", () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["preferred device", "selected device deletion"])("keeps global Active mode after %s changes in management", async change => {
    const { remote } = setup(); const props = { client: remote, onOpenSession: vi.fn() };
    const view = render(<SessionDashboard {...props} />); await showActive();
    await screen.findByRole("button", { name: "Laptop task" });
    if (change === "selected device deletion") vi.mocked(remote.listHostProfiles).mockResolvedValue(hosts.slice(1));
    view.rerender(<SessionDashboard {...props} preferredHostId={change === "preferred device" ? "host-2" : undefined} hostProfilesEpoch={1} />);
    await waitFor(() => expect(remote.listHostProfiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(`All connected devices · ${change === "preferred device" ? 2 : 1}`)).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show projects" }));
    expect(screen.getByRole("combobox")).toHaveValue("host-2");
  });

  it("restores a changed Projects device's scroll immediately from already-loaded Active data", async () => {
    const key = (id: string) => `agentport-mobile-v2:workspace:${id}`;
    localStorage.setItem("agentport-mobile-v2:selected-device", "host-1");
    localStorage.setItem(key("host-1"), JSON.stringify({ layout: "active", scrollTop: 240 }));
    localStorage.setItem(key("host-2"), JSON.stringify({ scrollTop: 75 }));
    const { remote } = setup(); const props = { client: remote, onOpenSession: vi.fn() };
    const view = render(<main className="main-content"><SessionDashboard {...props} /></main>);
    await screen.findByRole("button", { name: "Laptop task" });
    const scroller = view.container.querySelector("main")!;
    await waitFor(() => expect(scroller.scrollTop).toBe(240));
    view.rerender(<main className="main-content"><SessionDashboard {...props} preferredHostId="host-2" hostProfilesEpoch={1} /></main>);
    await waitFor(() => expect(scroller.scrollTop).toBe(75));
    scroller.scrollTop = 125; view.unmount();
    expect(JSON.parse(localStorage.getItem(key("host-2"))!).scrollTop).toBe(125);
  });

  it("releases a Projects foreground check when switching to global Active before it completes", async () => {
    const { remote } = setup();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Studio shell" });
    const original = vi.mocked(remote.request).getMockImplementation()!;
    let finish!: (value: unknown) => void;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "agent.preferences" && args[3]?.signal
      ? new Promise(resolve => { finish = resolve; }) : original(...args));
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await showActive(); await screen.findByRole("button", { name: "Laptop task" });
    await act(async () => finish({}));
    fireEvent.click(screen.getByRole("button", { name: "Show projects" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(remote.connect).not.toHaveBeenCalled(); expect(remote.disconnect).not.toHaveBeenCalled();
  });

  it("restores a cold global Active scroll from its own data and persists the current position", async () => {
    const key = "agentport-mobile-v2:workspace:host-1";
    localStorage.setItem("agentport-mobile-v2:selected-device", "host-1");
    localStorage.setItem(key, JSON.stringify({ layout: "active", scrollTop: 240 }));
    const { remote } = setup(); const original = vi.mocked(remote.request).getMockImplementation()!;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "session.list" && !args[3]?.signal
      ? new Promise(() => {}) : original(...args));
    const view = render(<main className="main-content"><SessionDashboard client={remote} onOpenSession={vi.fn()} /></main>);
    await screen.findByRole("button", { name: "Laptop task" });
    const scroller = view.container.querySelector("main")!;
    await waitFor(() => expect(scroller.scrollTop).toBe(240));
    scroller.scrollTop = 120; view.unmount();
    expect(JSON.parse(localStorage.getItem(key)!).scrollTop).toBe(120);
  });

  it("mixes connected devices by existing priority, labels each source and routes duplicate IDs correctly", async () => {
    const { remote } = setup(); const open = vi.fn();
    const { container } = render(<SessionDashboard client={remote} onOpenSession={open} />);
    await screen.findByRole("button", { name: "Studio shell" });
    await showActive();
    const laptop = await screen.findByRole("button", { name: "Laptop task" });
    const studio = await screen.findByRole("button", { name: "Studio shell" });
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("All connected devices · 2")).toBeInTheDocument();
    expect(laptop).toHaveAccessibleDescription(/Laptop/); expect(studio).toHaveAccessibleDescription(/Studio/);
    expect([...container.querySelectorAll(".active-agent-list [data-host-id]")].map(row => row.getAttribute("data-host-id"))).toEqual(["host-2", "host-1"]);
    fireEvent.click(laptop);
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ hostProfileId: "host-2", session: expect.objectContaining({ id: "same-id" }) }));
    fireEvent.contextMenu(laptop);
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() => expect(remote.request).toHaveBeenCalledWith("host-2", "session.pin", { sessionId: "same-id", pinned: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lists(remote).some(([id]) => id === "host-3")).toBe(false);
    expect(remote.connect).not.toHaveBeenCalled(); expect(remote.disconnect).not.toHaveBeenCalled();
  });

  it("restores the Projects device after opening another device's active session and returning", async () => {
    localStorage.setItem("agentport-mobile-v2:selected-device", "host-2");
    const { remote } = setup(); const open = vi.fn();
    const props = { client: remote, onOpenSession: open };
    const view = render(<SessionDashboard {...props} />);
    await screen.findByRole("button", { name: "Laptop task" });
    await showActive(); fireEvent.click(await screen.findByRole("button", { name: "Studio shell" }));
    expect(open.mock.calls[0][0].hostProfileId).toBe("host-1");
    view.rerender(<SessionDashboard {...props} active={false} />);
    view.rerender(<SessionDashboard {...props} active />);
    expect(screen.getByText("All connected devices · 2")).toBeInTheDocument();
    await screen.findByRole("button", { name: "Studio shell" });
    fireEvent.click(screen.getByRole("button", { name: "Show projects" }));
    expect(screen.getByRole("combobox", { name: "Current device" })).toHaveValue("host-2");
    expect(await screen.findByRole("button", { name: "Laptop task" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Studio shell" })).not.toBeInTheDocument();
  });

  it.each(["populated", "empty", "failed"])("does not repeat the initial loading notice during background polls (%s result)", async result => {
    vi.useFakeTimers();
    localStorage.setItem("agentport-mobile-v2:selected-device", "host-1");
    localStorage.setItem("agentport-mobile-v2:workspace:host-1", JSON.stringify({ layout: "active" }));
    const { remote } = setup(); const base = vi.mocked(remote.request).getMockImplementation()!;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] !== "session.list" ? base(...args)
      : result === "failed" ? Promise.reject(new Error("Read unavailable"))
        : result === "empty" ? Promise.resolve([]) : base(...args));
    const view = render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText("Loading active sessions from devices…")).not.toBeInTheDocument();
    if (result === "empty") expect(screen.getByText("No active sessions on connected devices.")).toBeInTheDocument();
    if (result === "populated") expect(screen.getByRole("button", { name: "Laptop task" })).toBeInTheDocument();
    if (result === "failed") expect(screen.getByText("Laptop: status unconfirmed; actions unavailable.")).toBeInTheDocument();

    const initial = vi.mocked(remote.request).getMockImplementation()!;
    const pending: (() => void)[] = [];
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "session.list"
      ? new Promise(resolve => { pending.push(() => resolve(initial(...args))); }) : initial(...args));
    for (let cycle = 0; cycle < 3; cycle++) {
      vi.mocked(remote.request).mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(lists(remote).map(([id]) => id).sort()).toEqual(["host-1", "host-2"]);
      expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("aria-busy", "true");
      expect(screen.queryByText("Loading active sessions from devices…")).not.toBeInTheDocument();
      if (result === "empty") expect(screen.getByText("No active sessions on connected devices.")).toBeInTheDocument();
      await act(async () => { pending.splice(0).forEach(finish => finish()); });
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    }
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.queryByText("Loading active sessions from devices…")).not.toBeInTheDocument();
    await act(async () => { pending.splice(0).forEach(finish => finish()); });
    view.rerender(<SessionDashboard client={remote} onOpenSession={vi.fn()} active={false} />);
    view.rerender(<SessionDashboard client={remote} onOpenSession={vi.fn()} active />);
    expect(pending).toHaveLength(2);
    expect(screen.queryByText("Loading active sessions from devices…")).not.toBeInTheDocument();
    await act(async () => { pending.splice(0).forEach(finish => finish()); });
  });

  it("refreshes every connected host once and pauses all list reads offscreen", async () => {
    vi.useFakeTimers(); const { remote } = setup(); const props = { client: remote, onOpenSession: vi.fn() };
    const view = render(<SessionDashboard {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(remote.request).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    expect(lists(remote).map(([id]) => id).sort()).toEqual(["host-1", "host-2"]);
    vi.mocked(remote.request).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(lists(remote).map(([id]) => id).sort()).toEqual(["host-1", "host-2"]);
    view.rerender(<SessionDashboard {...props} active={false} />);
    vi.mocked(remote.request).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(lists(remote)).toHaveLength(0);
    view.rerender(<SessionDashboard {...props} active />);
    await act(async () => {});
    expect(lists(remote).map(([id]) => id).sort()).toEqual(["host-1", "host-2"]);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    vi.mocked(remote.request).mockClear();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(lists(remote)).toHaveLength(0);
  });

  it("retains failed host rows as unconfirmed and inoperable without disabling healthy devices", async () => {
    const { remote } = setup(); const open = vi.fn();
    render(<SessionDashboard client={remote} onOpenSession={open} />); await showActive();
    await screen.findByRole("button", { name: "Laptop task" });
    const original = vi.mocked(remote.request).getMockImplementation()!;
    let failed = true;
    vi.mocked(remote.request).mockImplementation((...args) => failed && args[0] === "host-2" && args[1] === "session.list"
      ? Promise.reject(new Error("read failed")) : original(...args));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Laptop: status unconfirmed; actions unavailable.");
    const laptop = screen.getByRole("button", { name: "Laptop task" });
    expect(laptop).toBeDisabled(); expect(screen.getByRole("button", { name: "Studio shell" })).toBeEnabled();
    fireEvent.contextMenu(laptop); fireEvent.click(laptop);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText("No active sessions on connected devices.")).not.toBeInTheDocument();
    failed = false; fireEvent.click(screen.getByRole("button", { name: "Retry Laptop" }));
    await waitFor(() => expect(laptop).toBeEnabled());
    expect(screen.queryByText("Laptop: status unconfirmed; actions unavailable.")).not.toBeInTheDocument();
  });

  it("drops disconnected rows and dismisses their actions, then restores after reconnect", async () => {
    const { remote, emit } = setup();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />); await showActive();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Laptop task" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => emit({ profileId: "host-2", state: "disconnected" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Laptop task" })).not.toBeInTheDocument();
    expect(screen.getByText("All connected devices · 1")).toBeInTheDocument();
    act(() => emit({ profileId: "host-2", state: "connected" }));
    expect(await screen.findByRole("button", { name: "Laptop task" })).toBeEnabled();
    expect(remote.connect).not.toHaveBeenCalled();
  });

  it("keeps slow-device loading distinct from no activity and first-read failures", async () => {
    const { remote } = setup(); const original = vi.mocked(remote.request).getMockImplementation()!;
    let fail!: (error: Error) => void;
    vi.mocked(remote.request).mockImplementation((...args) => args[0] === "host-2" && args[1] === "session.list"
      ? new Promise((_, reject) => { fail = reject; }) : original(...args));
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />); await showActive();
    expect(await screen.findByRole("button", { name: "Studio shell" })).toBeEnabled();
    expect(screen.getByText("Loading active sessions from devices…")).toBeInTheDocument();
    expect(screen.queryByText("No active sessions on connected devices.")).not.toBeInTheDocument();
    await act(async () => fail(new Error("unavailable")));
    expect(screen.getByText("Laptop: status unconfirmed; actions unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("Loading active sessions from devices…")).not.toBeInTheDocument();
  });

  it.each([true, false])("distinguishes no connected devices from no active sessions (connected=%s)", async connected => {
    const { remote } = setup(hosts.map(host => ({ ...host, connectionState: connected ? "connected" : "disconnected" })));
    const original = vi.mocked(remote.request).getMockImplementation()!;
    vi.mocked(remote.request).mockImplementation((...args) => args[1] === "session.list" ? Promise.resolve([]) : original(...args));
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />); await showActive();
    expect(await screen.findByText(connected ? "No active sessions on connected devices." : "No connected devices. Connect a device in device management.")).toBeInTheDocument();
    if (!connected) { expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled(); expect(lists(remote)).toHaveLength(0); }
    expect(remote.connect).not.toHaveBeenCalled();
  });

  it("isolates phone unread receipts for same Session IDs across devices", async () => {
    const event = { sessionId: "same-id", runId: "r", kind: "approval_requested" as const,
      cursor: { sessionId: "same-id", runOrdinal: 1, sequence: 1, occurredAt: "2026-09-02T00:02:00Z" } };
    new AttentionInbox("host-2").ingest({ events: [event] });
    const { remote } = setup(); render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />); await showActive();
    const laptop = await screen.findByRole("button", { name: "Laptop task" });
    const studio = await screen.findByRole("button", { name: "Studio shell" });
    expect(laptop.querySelector(".session-unread")).not.toBeNull();
    expect(studio.querySelector(".session-unread")).toBeNull();
  });
});
