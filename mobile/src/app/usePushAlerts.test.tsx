import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePushAlerts } from "./usePushAlerts";
import type { RemoteClient } from "../protocol/remoteClient";
import type { HostAuthClient } from "../features/hosts-auth/types";

const invoke = vi.fn();
const handlers = new Map<string, () => void>();
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (name: string, listener: () => void) => {
  handlers.set(name, listener);
  return Promise.resolve(() => handlers.delete(name));
} }));

const host = { id: "phone-mac", name: "Mac", hostname: "relay.example", port: 443,
  username: "user", preferredTransport: "relay" as const, connectionState: "connected" as const,
  lastConnectedAt: null, lastError: null };
const session = { id: "ses-1", projectId: "p", title: "Build" };
function setup(state: { token?: string | null; permission?: string; pendingTap?: { hostId: string; sessionId: string } | null; delayRegistration?: boolean } = {}) {
  const client = { listHostProfiles: vi.fn().mockResolvedValue([host]),
    request: vi.fn().mockResolvedValue([session]), connect: vi.fn().mockResolvedValue({}),
    onConnectionState: vi.fn().mockResolvedValue(() => {}) } as unknown as RemoteClient;
  const hostAuth = { getProfile: vi.fn().mockResolvedValue({ id: host.id, enabled: true,
    relay: { approved: true, peer: { hostId: "trusted-host" } } }) } as unknown as HostAuthClient;
  const open = vi.fn();
  invoke.mockImplementation((name: string) => {
    if (name === "mobile_push_take_state") return Promise.resolve({ token: state.token ?? null,
      permission: state.permission ?? "authorized", environment: "sandbox", pendingTap: state.pendingTap ?? null });
    if (name === "mobile_register_push_token" && state.delayRegistration) return new Promise(() => {});
    return Promise.resolve();
  });
  function View() { usePushAlerts(client, hostAuth, 0, open); return null; }
  const mounted = render(<View />);
  return { client, hostAuth, open, mounted };
}

describe("iOS visible push hint recovery", () => {
  beforeEach(() => { invoke.mockReset(); handlers.clear(); });
  it("binds OS token through the native authenticated Relay command, not the JS remote protocol", async () => {
    const { client, mounted } = setup({ token: "ab".repeat(32) });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mobile_register_push_token", {
      profileId: host.id, token: "ab".repeat(32), environment: "sandbox",
    }));
    expect(client.request).not.toHaveBeenCalled();
    mounted.unmount();
  });
  it("does not register a token when permission is denied", async () => {
    const { mounted } = setup({ token: "ab".repeat(32), permission: "denied" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("mobile_push_take_state"));
    expect(invoke.mock.calls.some(([name]) => name === "mobile_register_push_token")).toBe(false);
    mounted.unmount();
  });
  it("rejects untrusted push host IDs before selecting a Session", async () => {
    const { client, open, mounted } = setup({ pendingTap: { hostId: "forged-host", sessionId: "ses-1" } });
    await waitFor(() => expect(client.listHostProfiles).toHaveBeenCalled());
    expect(client.request).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(invoke.mock.calls.some(([name]) => name === "mobile_push_ack_tap")).toBe(false);
    mounted.unmount();
  });
  it("opens a trusted cold-start tap before an offline token registration can hang", async () => {
    const { open, mounted } = setup({ token: "ab".repeat(32), delayRegistration: true,
      pendingTap: { hostId: "trusted-host", sessionId: "ses-1" } });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith("mobile_push_ack_tap", { tap: { hostId: "trusted-host", sessionId: "ses-1" } });
    mounted.unmount();
  });
  it("verifies host and session over the authenticated connection before opening", async () => {
    const { open, mounted } = setup({ pendingTap: { hostId: "trusted-host", sessionId: "ses-1" } });
    await waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ hostProfileId: host.id,
      session: expect.objectContaining({ id: "ses-1" }) })));
    expect(invoke).toHaveBeenCalledWith("mobile_push_ack_tap", { tap: { hostId: "trusted-host", sessionId: "ses-1" } });
    act(() => handlers.get("mobile-push-tap")?.());
    mounted.unmount();
  });
});
