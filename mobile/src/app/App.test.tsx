import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { i18n } from "../i18n";
import type { RemoteClient } from "../protocol/remoteClient";
import { App } from "./App";

vi.mock("../terminal/MobileTerminal", () => ({
  MobileTerminal: () => <div role="application" aria-label="Full terminal" />,
}));

const hostAuthClient: HostAuthClient = {
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  copyProfile: vi.fn(),
  deleteProfile: vi.fn(),
  storePassword: vi.fn(),
  importPrivateKey: vi.fn(),
  generatePrivateKey: vi.fn(),
  deleteCredential: vi.fn(),
  trustHostKey: vi.fn(),
  exportProfiles: vi.fn(),
  importProfiles: vi.fn(),
};

function client(overrides: Partial<RemoteClient> = {}): RemoteClient {
  return {
    listHostProfiles: vi.fn().mockResolvedValue([]),
    connect: vi.fn(),
    disconnect: vi.fn(),
    request: vi.fn(),
    subscribe: vi.fn(),
    onConnectionState: vi.fn().mockResolvedValue(async () => undefined),
    ...overrides,
  };
}

describe("AgentPort Mobile V2 shell", () => {
  afterEach(cleanup);

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("opens on Sessions without the V1 tab bar or product probes", async () => {
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    expect(await screen.findByRole("heading", { name: "Session" })).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("先添加并连接一台主机。");
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.queryByText("工作区")).not.toBeInTheDocument();
    expect(screen.queryByText("内容")).not.toBeInTheDocument();
  });

  it("keeps device management reachable as a modal sheet", async () => {
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    fireEvent.click(screen.getByRole("button", { name: "管理设备" }));
    const dialog = await screen.findByRole("dialog", { name: "你的电脑" });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "还没有主机" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("supports the English resource set", async () => {
    await i18n.changeLanguage("en-US");
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Manage devices" })).toBeInTheDocument();
  });

  it("swipes between the persistent list and the selected full-screen terminal", async () => {
    await i18n.changeLanguage("en-US");
    const remote = client({
      listHostProfiles: vi.fn().mockResolvedValue([{
        id: "host-1", name: "Studio", hostname: "studio.local", port: 22, username: "dev",
        preferredTransport: "ssh", connectionState: "connected", lastConnectedAt: null, lastError: null,
      }]),
      request: vi.fn().mockImplementation((_profileId, method) => {
        if (method === "session.list") return Promise.resolve([{
          id: "ses-1", projectId: "project-1", presetId: "p", title: "Agent task", cwd: "/repo",
          lifecycle: "running", resumePrecision: "exact", adapterType: "claude", transport: "pty",
          permissionMode: "bypass", hostAlive: true, createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-02T00:01:00Z",
        }]);
        if (method === "project.list") return Promise.resolve([{ id: "project-1", name: "AgentPort", rootPath: "/repo", pinned: false, sortOrder: 0 }]);
        if (method === "agent.supported") return Promise.resolve([]);
        if (method === "agent.preferences") return Promise.resolve({ revision: 1, agentOrder: [], agentHidden: [] });
        if (method === "attention.poll") return Promise.resolve({ events: [] });
        if (method === "session.attach") return Promise.resolve({ attachmentId: "att-1", sessionId: "ses-1", childAlive: true, features: ["terminal_geometry_v1"], runId: "run-1", runOrdinal: 1 });
        return Promise.resolve({});
      }),
      subscribe: vi.fn().mockResolvedValue(async () => undefined),
    });
    const { container } = render(<App client={remote} hostAuthClient={hostAuthClient} />);
    fireEvent.click(await screen.findByRole("button", { name: /Agent task/ }));
    const stage = container.querySelector(".session-stage")!;
    expect(stage).toHaveClass("is-visible");
    await waitFor(() => expect(document.body).toHaveClass("terminal-visible"));

    const shell = container.querySelector(".app-shell")!;
    fireEvent.touchStart(shell, { touches: [{ clientX: 40, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 160, clientY: 224 }] });
    expect(stage).not.toHaveClass("is-visible");
    await waitFor(() => expect(document.body).not.toHaveClass("terminal-visible"));

    fireEvent.touchStart(shell, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 70, clientY: 224 }] });
    expect(stage).toHaveClass("is-visible");
    await waitFor(() => expect(document.body).toHaveClass("terminal-visible"));
  });
});
