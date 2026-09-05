import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { i18n } from "../../i18n";
import type { RemoteClient } from "../../protocol/remoteClient";
import { SessionDashboard } from "./SessionDashboard";

const hosts = [
  { id: "host-1", name: "Studio", hostname: "studio.local", port: 22, username: "dev", preferredTransport: "ssh" as const, connectionState: "connected" as const, lastConnectedAt: null, lastError: null },
  { id: "host-2", name: "Laptop", hostname: "laptop.local", port: 22, username: "dev", preferredTransport: "ssh" as const, connectionState: "connected" as const, lastConnectedAt: null, lastError: null },
];

function client(): RemoteClient {
  return {
    listHostProfiles: vi.fn().mockResolvedValue(hosts),
    connect: vi.fn(), disconnect: vi.fn(),
    request: vi.fn().mockImplementation((profileId, method) => {
      if (method === "session.list") return Promise.resolve(profileId === "host-1" ? [
        { id: "attention", projectId: "project-1", presetId: "p", title: "Approval task", cwd: "/repo", lifecycle: "running", resumePrecision: "exact", adapterType: "claude", transport: "pty", permissionMode: "bypass", hostAlive: true, unreadAttention: true, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:02:00Z" },
        { id: "shell", projectId: "project-1", presetId: "p", title: "Shell", cwd: "/repo", lifecycle: "running", resumePrecision: "exact", adapterType: "shell", transport: "pty", permissionMode: "native", hostAlive: true, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:01:00Z" },
        { id: "dead", projectId: "project-1", presetId: "p", title: "Dead agent", cwd: "/repo", lifecycle: "exited", resumePrecision: "exact", adapterType: "claude", transport: "pty", permissionMode: "bypass", hostAlive: false, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:30Z" },
      ] : [{ id: "laptop-session", projectId: "project-2", presetId: "p", title: "Laptop task", cwd: "/laptop", lifecycle: "running", resumePrecision: "exact", adapterType: "pi", transport: "pty", permissionMode: "native", hostAlive: true, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" }]);
      if (method === "project.list") return Promise.resolve([{ id: profileId === "host-1" ? "project-1" : "project-2", name: profileId === "host-1" ? "AgentPort" : "Laptop Project", rootPath: "/repo", pinned: false, sortOrder: 0 }]);
      if (method === "agent.supported") return Promise.resolve([{ agent: "claude", displayName: "Claude", install: {} }, { agent: "shell", displayName: "Shell", install: null }]);
      if (method === "agent.preferences") return Promise.resolve({ revision: 1, agentOrder: ["claude", "shell"], agentHidden: [] });
      if (method === "session.create") return Promise.resolve({ sessionId: "attention" });
      return Promise.resolve(undefined);
    }),
    subscribe: vi.fn(), onConnectionState: vi.fn().mockResolvedValue(async () => undefined),
  };
}

describe("V2 Session workspace", () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
  afterEach(() => cleanup());

  it("shows only pending completion/input attention in Recent and puts the dot on its icon", async () => {
    const remote = client();
    const request = remote.request;
    remote.request = vi.fn(async (host, method, params) => {
      const value = await request(host, method, params);
      if (method === "session.list") return (value as any[]).map(session => session.id === "attention" ? { ...session, latestAttentionKind: "approval_requested" } : session);
      return value;
    }) as RemoteClient["request"];
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    await screen.findByRole("button", { name: "Approval task" });
    const recent = screen.getByRole("button", { name: "Recent sessions" });
    expect(recent.querySelector(".toolbar-attention")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Show active sessions" }).querySelector(".toolbar-attention")).toBeNull();
    fireEvent.click(recent);
    const dialog = screen.getByRole("dialog", { name: "Recent sessions" });
    expect(within(dialog).getByRole("button", { name: "Approval task" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Shell" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Dead agent" })).not.toBeInTheDocument();
  });

  it("clears Recent only after successful opening, survives stale snapshots, and admits newer attention", async () => {
    const remote = client();
    const base = remote.request;
    let sequence = 1;
    remote.request = vi.fn(async (host, method, params) => {
      const value = await base(host, method, params);
      if (method === "session.list") return (value as any[]).map(session => session.id === "attention" ? { ...session, latestAttentionKind: "approval_requested", latestStatus: { runId: "run", runOrdinal: 1, sequence, state: "needs_input", occurredAt: session.updatedAt } } : session);
      return value;
    }) as RemoteClient["request"];
    const onOpenSession = vi.fn();
    const { rerender } = render(<SessionDashboard client={remote} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approval task" }));
    expect(screen.getByRole("button", { name: "Recent sessions" }).querySelector(".toolbar-attention")).not.toBeNull();
    const open = onOpenSession.mock.calls[0][0];
    rerender(<SessionDashboard client={remote} onOpenSession={onOpenSession} openedSession={{ open, token: 1 }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Recent sessions" }).querySelector(".toolbar-attention")).toBeNull());
    expect(remote.request).toHaveBeenCalledWith("host-1", "session.seen.mark", { sessionId: "attention", cursor: { runId: "run", runOrdinal: 1, sequence: 1 } });
    sequence = 2;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Recent sessions" }).querySelector(".toolbar-attention")).not.toBeNull());
  });

  it("offers the row action menu via keyboard without opening the terminal", async () => {
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={client()} onOpenSession={onOpenSession} />);
    const row = await screen.findByRole("button", { name: "Approval task" });
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const dialog = screen.getByRole("dialog", { name: "Approval task" });
    expect([...dialog.querySelectorAll(".terminal-action-grid button")].map(button => button.textContent)).toEqual(["Rename", "Pin", "Stop", "Archive", "Remove"]);
    expect(onOpenSession).not.toHaveBeenCalled();
  });

  it("opens actions on long press, suppresses its trailing click, and cancels when scrolling", async () => {
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={client()} onOpenSession={onOpenSession} />);
    const row = await screen.findByRole("button", { name: "Approval task" });
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(row, { clientX: 10, clientY: 30 });
      act(() => vi.advanceTimersByTime(501));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 10 });
      act(() => vi.advanceTimersByTime(501));
      expect(screen.getByRole("dialog", { name: "Approval task" })).toBeInTheDocument();
      fireEvent.pointerUp(row);
      fireEvent.click(row);
      expect(onOpenSession).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it("loads only the selected device and keeps device state separate", async () => {
    const remote = client();
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Approval task/ })).toBeInTheDocument();
    expect(remote.request).toHaveBeenCalledWith("host-1", "session.list", { includeArchived: false });
    expect(remote.request).not.toHaveBeenCalledWith("host-2", "session.list", expect.anything());

    fireEvent.change(screen.getByRole("combobox", { name: "Current device" }), { target: { value: "host-2" } });
    expect(await screen.findByRole("button", { name: /Laptop task/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Approval task/ })).not.toBeInTheDocument();
    expect(remote.request).toHaveBeenCalledWith("host-2", "session.list", { includeArchived: false });
  });

  it("matches Active Agent filtering and desktop quick-start parameters", async () => {
    const remote = client();
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={remote} onOpenSession={onOpenSession} />);
    expect(await screen.findByRole("button", { name: /Approval task/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    expect(screen.getByRole("button", { name: /Approval task/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Shell,/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dead agent/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Start agent in AgentPort" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Claude in AgentPort" }));
    await waitFor(() => expect(remote.request).toHaveBeenCalledWith("host-1", "session.create", expect.objectContaining({
      projectId: "project-1", agent: "claude", permission: "bypass", transport: "pty", riskAck: true,
    })));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({
      session: expect.objectContaining({ id: "attention" }),
    })));
    expect(screen.queryByText("The Session was created, but its latest summary could not be loaded.")).not.toBeInTheDocument();
  });

  it("can collapse the last expanded project without treating it as the default state", async () => {
    render(<SessionDashboard client={client()} onOpenSession={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Approval task/ })).toBeInTheDocument();

    const projectToggle = screen.getByRole("button", { name: "AgentPort" });
    expect(projectToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(projectToggle);

    expect(projectToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /Approval task/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("agentport-mobile-v2:workspace:host-1") ?? "null")).toMatchObject({
      expandedProjects: [],
      projectExpansionInitialized: true,
    });
  });
  it("renders only a status glyph, title and time in each row while preserving the accessible status", async () => {
    const { container } = render(<SessionDashboard client={client()} onOpenSession={vi.fn()} />);
    const button = await screen.findByRole("button", { name: /Approval task/ });
    expect(button.querySelector("small")).toBeNull();
    expect(button.querySelector(".session-row-meta")).toBeNull();
    expect(button.querySelector(".session-row-copy")?.firstElementChild).toHaveClass("session-row-status");
    expect(button.querySelector(".session-state .visually-hidden")).not.toBeNull();
    expect(button).toHaveAccessibleDescription(/Unknown/);
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    expect(container.querySelector(".active-agent-list")?.children.length).toBeGreaterThan(0);
  });

  it("uses one project launch entry, accessible view labels, and settings", async () => {
    const onOpenSettings = vi.fn();
    const { container } = render(<SessionDashboard client={client()} onOpenSession={vi.fn()} onOpenSettings={onOpenSettings} />);
    await screen.findByRole("button", { name: "Start agent in AgentPort" });
    const launch = screen.getByRole("button", { name: "Start agent in AgentPort" });
    expect(launch.textContent).toBe("");
    expect(launch.querySelector(".agentport-mark")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".mobile-workspace-caption")).toBeNull();
    expect(screen.getByText("Projects").closest(".visually-hidden")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Start Claude in AgentPort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Start agent in AgentPort" }));
    expect(screen.getByRole("dialog", { name: "Choose an agent" })).toHaveTextContent("Project: AgentPort");
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    expect(screen.getByRole("button", { name: "Show projects" })).toHaveAttribute("aria-pressed", "true");
  });

  it("uses selected host/project and preserves ordered installed/hidden preferences", async () => {
    const remote = client();
    const request = remote.request;
    remote.request = vi.fn().mockImplementation((host, method, params) => {
      if (method === "agent.supported") return Promise.resolve([
        { agent: "claude", displayName: "Claude", install: {} },
        { agent: "pi", displayName: "Pi", install: {} },
        { agent: "codex", displayName: "Codex", install: null },
        { agent: "shell", displayName: "Shell", install: null },
      ]);
      if (method === "agent.preferences") return Promise.resolve({ agentOrder: ["shell", "pi", "claude"], agentHidden: ["claude"] });
      return request(host, method, params);
    });
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={remote} onOpenSession={onOpenSession} />);
    await screen.findByRole("button", { name: "Start agent in AgentPort" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "host-2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Start agent in Laptop Project" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button").filter((button) => button.hasAttribute("data-agent")).map((button) => button.querySelector(".agent-picker-name")?.textContent)).toEqual(["Shell", "Pi"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start Shell in Laptop Project" }));
    await waitFor(() => expect(remote.request).toHaveBeenCalledWith("host-2", "session.create", expect.objectContaining({ projectId: "project-2", agent: "shell", permission: "native" })));
  });

  it.each(["close", "host switch"])("guards double submit and ignores completion after %s", async (cancel) => {
    const remote = client();
    const request = remote.request;
    let complete!: (value: { sessionId: string }) => void;
    remote.request = vi.fn().mockImplementation((host, method, params) => method === "session.create"
      ? new Promise((resolve) => { complete = resolve; }) : request(host, method, params));
    const onOpenSession = vi.fn();
    render(<SessionDashboard client={remote} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start agent in AgentPort" }));
    const start = screen.getByRole("button", { name: "Start Claude in AgentPort" });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(start).toBeDisabled();
    expect(screen.getByText(/Starting agent/)).toBeInTheDocument();
    expect(vi.mocked(remote.request).mock.calls.filter((call) => call[1] === "session.create")).toHaveLength(1);
    // Closing is always possible while create is already submitted.
    if (cancel === "close") fireEvent.click(screen.getByRole("button", { name: /close/i }));
    if (cancel === "host switch") {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "host-2" } });
      await screen.findByRole("button", { name: /Laptop task/ });
    }
    await act(async () => complete({ sessionId: "attention" }));
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])("handles failure without duplicate create retry after creation=%s", async (created) => {
    const remote = client();
    const request = remote.request;
    let submitted = false;
    remote.request = vi.fn().mockImplementation((host, method, params) => {
      if (method === "session.create") { submitted = true; return created ? Promise.resolve({ sessionId: "new" }) : Promise.reject(new Error("Launch denied")); }
      if (submitted && method === "session.list") return Promise.reject(new Error("List failed"));
      return request(host, method, params);
    });
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start agent in AgentPort" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Claude in AgentPort" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(created ? "Session created" : "Launch denied");
    const start = screen.getByRole("button", { name: "Start Claude in AgentPort" });
    if (created) expect(start).toBeDisabled(); else expect(start).toBeEnabled();
    expect(screen.getByRole("button", { name: /close/i })).toBeEnabled();
  });

  it("explains empty and offline launch states", async () => {
    const remote = client();
    const request = remote.request;
    let connection!: (event: { profileId: string; state: string }) => void;
    remote.onConnectionState = vi.fn().mockImplementation((callback) => { connection = callback; return Promise.resolve(async () => undefined); });
    remote.request = vi.fn().mockImplementation((host, method, params) => method === "agent.preferences" ? Promise.resolve({ agentHidden: ["claude", "shell"] }) : request(host, method, params));
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Start agent in AgentPort" }));
    expect(screen.getByText(/No visible agents available/)).toBeInTheDocument();
    act(() => connection({ profileId: "host-1", state: "disconnected" }));
    expect(screen.getByText("Connect this device to start an agent.")).toBeInTheDocument();
  });

});
