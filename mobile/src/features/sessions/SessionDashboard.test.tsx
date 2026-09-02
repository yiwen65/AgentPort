import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      if (method === "session.create") return Promise.resolve({ id: "attention" });
      return Promise.resolve(undefined);
    }),
    subscribe: vi.fn(), onConnectionState: vi.fn().mockResolvedValue(async () => undefined),
  };
}

describe("V2 Session workspace", () => {
  beforeEach(async () => { localStorage.clear(); await i18n.changeLanguage("en-US"); });
  afterEach(() => cleanup());

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
    render(<SessionDashboard client={remote} onOpenSession={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Approval task/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show active sessions" }));
    expect(screen.getByRole("button", { name: /Approval task/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Shell,/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dead agent/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show projects" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Claude in AgentPort" }));
    await waitFor(() => expect(remote.request).toHaveBeenCalledWith("host-1", "session.create", expect.objectContaining({
      projectId: "project-1", agent: "claude", permission: "bypass", transport: "pty", riskAck: true,
    })));
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
});
