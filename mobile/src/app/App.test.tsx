import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAuthClient } from "../features/hosts-auth/types";
import { i18n } from "../i18n";
import type { RemoteClient } from "../protocol/remoteClient";
import { App } from "./App";

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
});
