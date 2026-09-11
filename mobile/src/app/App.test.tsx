import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { i18n } from "../i18n";
import type { RemoteClient, RemoteEvent } from "../protocol/remoteClient";
import type { SessionEventPayload } from "../features/sessions/types";
import { App } from "./App";

vi.mock("../terminal/MobileTerminal", async () => {
  const { forwardRef } = await vi.importActual<typeof import("react")>("react");
  return {
    MobileTerminal: forwardRef(() => <div role="application" aria-label="Full terminal"><textarea className="xterm-helper-textarea" aria-label="Terminal input" /></div>),
  };
});

vi.mock("../features/hosts-auth/PairDevice", () => ({ PairDevice: ({ onPaired }: { onPaired: (id: string) => void }) => <button onClick={() => onPaired("new-relay")}>Complete scan</button> }));

const hostAuthClient: HostAuthClient = {
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  reconcileRelayProfile: vi.fn(),
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

function focusTestClient() {
  const listeners = new Set<(event: RemoteEvent<SessionEventPayload>) => void>();
  const sessions = ["Active task", "Other task"].map((title, index) => ({
    id: `ses-${index + 1}`, projectId: "project-1", presetId: "p", title, cwd: "/repo",
    lifecycle: "running", resumePrecision: "exact", adapterType: "pi", transport: "pty",
    permissionMode: "native", hostAlive: true, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
  }));
  const remote = client({
    listHostProfiles: vi.fn().mockResolvedValue([{ id: "host-1", name: "Studio", connectionState: "connected" }]),
    request: vi.fn().mockImplementation((_profileId, method, params) => {
      if (method === "session.list") return Promise.resolve(sessions);
      if (method === "project.list") return Promise.resolve([{ id: "project-1", name: "AgentPort", rootPath: "/repo", pinned: false, sortOrder: 0 }]);
      if (method === "agent.supported") return Promise.resolve([]);
      if (method === "agent.preferences") return Promise.resolve({ revision: 1, agentOrder: [], agentHidden: [] });
      if (method === "attention.poll") return Promise.resolve({ events: [] });
      if (method === "session.attach") return Promise.resolve({ attachmentId: `att-${params.sessionId}`, sessionId: params.sessionId, childAlive: true, runId: `run-${params.sessionId}`, runOrdinal: 1, features: [] });
      return Promise.resolve({});
    }),
    subscribe: vi.fn().mockImplementation(async (_profileId, _topics, listener) => {
      listeners.add(listener);
      return async () => { listeners.delete(listener); };
    }),
  });
  const emitState = (sessionId: string, sequence: number, state: string) => {
    const event: RemoteEvent<SessionEventPayload> = { subscriptionId: `att-${sessionId}`, eventType: "state", cursor: null,
      payload: { session_id: sessionId, run_id: `run-${sessionId}`, run_ordinal: 1, sequence, state,
        source: "process", confidence: "high", occurred_at: "2026-09-08T00:00:00Z" } };
    listeners.forEach(listener => listener(event));
  };
  return { remote, sessions, emitState };
}

const settleFocusFrames = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

describe("AgentPort Mobile V2 shell", () => {
  afterEach(cleanup);

  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage("zh-CN");
  });

  it("opens on Sessions without the V1 tab bar or product probes", async () => {
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    expect(await screen.findByRole("heading", { name: "Session" })).toBeInTheDocument();
    expect(await screen.findByText("先添加并连接一台主机。")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.queryByText("工作区")).not.toBeInTheDocument();
    expect(screen.queryByText("内容")).not.toBeInTheDocument();
  });

  it("keeps device management reachable as a modal sheet", async () => {
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    fireEvent.click(screen.getByRole("button", { name: "管理设备" }));
    const dialog = await screen.findByRole("dialog", { name: "电脑" });
    expect(dialog).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "还没有主机" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("opens one Theme without a selected session and applies the palette to the app", async () => {
    await i18n.changeLanguage("en-US");
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Interface appearance" })).getByRole("radio", { name: "Light" }));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f2f7f1");
    expect(document.documentElement.style.getPropertyValue("--terminal-bg")).toBe("");
    expect(document.body).not.toHaveClass("terminal-visible");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("returns from scanning to the dashboard for the newly connected computer", async () => {
    await i18n.changeLanguage("en-US");
    const remote = client({
      listHostProfiles: vi.fn().mockResolvedValue([
        { id: "old-host", name: "Old", connectionState: "disconnected" },
        { id: "new-relay", name: "New Mac", connectionState: "connected", preferredTransport: "relay" },
      ]),
      connect: vi.fn().mockResolvedValue({ profileId: "new-relay" }),
      request: vi.fn().mockImplementation((_, method) => Promise.resolve(method === "agent.preferences" ? {} : [])),
    });
    render(<App client={remote} hostAuthClient={hostAuthClient} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage devices" }));
    fireEvent.click(await screen.findByRole("button", { name: "Scan to pair" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete scan" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Computers" })).not.toBeInTheDocument());
    expect(remote.connect).toHaveBeenCalledWith("new-relay");
    await waitFor(() => expect(remote.request).toHaveBeenCalledWith("new-relay", "session.list", { includeArchived: false }));
  });

  it("supports the English resource set", async () => {
    await i18n.changeLanguage("en-US");
    render(<App client={client()} hostAuthClient={hostAuthClient} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sessions" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Manage devices" })).toBeInTheDocument();
  });

  it.each([0, 1])("does not dismiss terminal input when Session %s receives status updates", async index => {
    await i18n.changeLanguage("en-US");
    const { remote, sessions, emitState } = focusTestClient();
    const session = sessions[index];
    render(<App client={remote} hostAuthClient={hostAuthClient} />);
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(session.title) }));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    await settleFocusFrames();
    const input = screen.getByRole("textbox", { name: "Terminal input" });
    act(() => input.focus());
    for (const [index, state] of ["working", "idle", "needs_input"].entries()) {
      act(() => emitState(session.id, index + 1, state));
      await settleFocusFrames();
      expect(input).toHaveFocus();
      expect(screen.getByRole("textbox", { name: "Terminal input" })).toBe(input);
    }
    expect(vi.mocked(remote.request).mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(1);
    expect(vi.mocked(remote.request).mock.calls.filter(([, method]) => method === "session.detach")).toHaveLength(0);
  });

  it("does not steal a tap's input focus while the navigation focus frame is pending", async () => {
    await i18n.changeLanguage("en-US");
    const { remote } = focusTestClient();
    render(<App client={remote} hostAuthClient={hostAuthClient} />);
    const row = await screen.findByRole("button", { name: /Other task/ });
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
    try {
      fireEvent.click(row);
      const input = await screen.findByRole("textbox", { name: "Terminal input" });
      act(() => input.focus());
      act(() => frames.splice(0).forEach(callback => callback(performance.now())));
      expect(input).toHaveFocus();
    } finally { raf.mockRestore(); }
  });

  it("does not move dashboard focus when a hidden Session receives a state update", async () => {
    await i18n.changeLanguage("en-US");
    const { remote, emitState } = focusTestClient();
    const { container } = render(<App client={remote} hostAuthClient={hostAuthClient} />);
    fireEvent.click(await screen.findByRole("button", { name: /Active task/ }));
    await waitFor(() => expect(screen.getByRole("article")).toHaveAttribute("data-connection-state", "live"));
    await settleFocusFrames();
    const shell = container.querySelector(".app-shell")!;
    fireEvent.touchStart(shell, { touches: [{ clientX: 40, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 160, clientY: 224 }] });
    await settleFocusFrames();
    const otherRow = screen.getByRole("button", { name: /Other task/ });
    act(() => otherRow.focus());
    act(() => emitState("ses-1", 1, "working"));
    await settleFocusFrames();
    expect(otherRow).toHaveFocus();
  });

  it("swipes between the persistent list and the selected full-screen terminal", async () => {
    await i18n.changeLanguage("en-US");
    let systemDark = false;
    const systemListeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({ get matches() { return systemDark; }, addEventListener: (_: string, listener: () => void) => systemListeners.add(listener), removeEventListener: (_: string, listener: () => void) => systemListeners.delete(listener) }));
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
    const sessionButton = await screen.findByRole("button", { name: /Agent task/ });
    fireEvent.click(sessionButton);
    const stage = container.querySelector(".session-stage")!;
    expect(stage).toHaveClass("is-visible");
    await waitFor(() => expect(document.body).toHaveClass("terminal-visible"));
    await waitFor(() => expect(screen.getByRole("article", { name: "Agent task" })).toHaveFocus());

    const shell = container.querySelector(".app-shell")!;
    fireEvent.touchStart(shell, { touches: [{ clientX: 40, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 160, clientY: 224 }] });
    expect(stage).not.toHaveClass("is-visible");
    await waitFor(() => expect(document.body).not.toHaveClass("terminal-visible"));
    await waitFor(() => expect(sessionButton).toHaveFocus());

    const renderer = container.querySelector(".session-workspace");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    fireEvent.touchStart(shell, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 70, clientY: 224 }] });
    expect(stage).not.toHaveClass("is-visible");
    const terminalSettings = within(screen.getByRole("group", { name: "Terminal appearance" }));
    fireEvent.click(terminalSettings.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-app-theme", "dark");
    expect(renderer).toHaveAttribute("data-terminal-theme-mode", "dark");
    fireEvent.click(terminalSettings.getByRole("radio", { name: "Light" }));
    fireEvent.click(terminalSettings.getByRole("radio", { name: "Aurora" }));
    expect(renderer).toHaveAttribute("data-terminal-theme", "aurora");
    expect(renderer).toHaveAttribute("data-terminal-theme-mode", "light");
    expect(document.documentElement).toHaveAttribute("data-theme-family", "forest");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#101c15");
    expect((renderer as HTMLElement).style.getPropertyValue("--panel")).not.toBe("");
    fireEvent.click(within(screen.getByRole("group", { name: "Interface appearance" })).getByRole("radio", { name: "Light" }));
    expect(renderer).toHaveAttribute("data-terminal-theme-mode", "light");
    fireEvent.click(terminalSettings.getByRole("radio", { name: "System" }));
    act(() => { systemDark = true; systemListeners.forEach(listener => listener()); });
    expect(document.documentElement).toHaveAttribute("data-app-theme", "light");
    expect(renderer).toHaveAttribute("data-terminal-theme-mode", "dark");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f2f7f1");
    expect(container.querySelector(".session-workspace")).toBe(renderer);
    expect(vi.mocked(remote.request).mock.calls.filter(([, method]) => method === "session.attach")).toHaveLength(1);
    expect(vi.mocked(remote.request).mock.calls.filter(([, method]) => method === "session.detach")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // A picker opened after touch-start must also cancel the pending swipe.
    fireEvent.touchStart(shell, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.click(screen.getByRole("button", { name: "Start agent in AgentPort" }));
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 70, clientY: 224 }] });
    expect(stage).not.toHaveClass("is-visible");
    const backdrop = screen.getByRole("dialog", { name: "Choose an agent" }).parentElement!;
    fireEvent.touchStart(backdrop, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchEnd(backdrop, { changedTouches: [{ clientX: 70, clientY: 224 }] });
    expect(stage).not.toHaveClass("is-visible");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    fireEvent.touchStart(shell, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 70, clientY: 224 }] });
    expect(stage).toHaveClass("is-visible");
    await waitFor(() => expect(document.body).toHaveClass("terminal-visible"));
  });
});
