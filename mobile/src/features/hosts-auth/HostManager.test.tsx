import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import type { RemoteClient } from "../../protocol/remoteClient";
import type { HostAuthClient, HostProfileDetails } from "./types";
import { HostManager } from "./HostManager";
vi.mock("./PairDevice", () => ({ PairDevice: ({ onPaired }: { onPaired: (id: string) => void }) => <button onClick={() => onPaired("paired-relay")}>Complete isolated scan</button> }));

const profile: HostProfileDetails = {
  id: "host_1",
  name: "Studio",
  hostname: "studio.local",
  port: 22,
  username: "dev",
  preferredTransport: "ssh",
  authentication: "password",
  credentialId: "cred_1",
  enabled: true,
  sortOrder: 0,
};

function clients() {
  const remote: RemoteClient = {
    listHostProfiles: vi.fn().mockResolvedValue([{ ...profile, connectionState: "disconnected", lastConnectedAt: null, lastError: null }]),
    connect: vi.fn().mockResolvedValue({ profileId: profile.id, protocolMajor: 1, protocolMinor: 1, agentportVersion: "1", platform: "macos", capabilities: [] }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn(),
    subscribe: vi.fn(),
    onConnectionState: vi.fn().mockResolvedValue(async () => undefined),
  };
  const auth: HostAuthClient = {
    getProfile: vi.fn().mockResolvedValue(profile),
    saveProfile: vi.fn().mockResolvedValue(profile),
    reconcileRelayProfile: vi.fn(),
    copyProfile: vi.fn().mockResolvedValue(profile),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    storePassword: vi.fn().mockResolvedValue({ credentialId: "cred_new" }),
    importPrivateKey: vi.fn(),
    generatePrivateKey: vi.fn(),
    deleteCredential: vi.fn(),
    trustHostKey: vi.fn().mockResolvedValue(undefined),
    exportProfiles: vi.fn(),
    importProfiles: vi.fn(),
  };
  return { remote, auth };
}

describe("host authentication manager", () => {
  it("connects the exact approved profile after scanning without a Connect tap", async () => {
    const { remote, auth } = clients();
    const connected = vi.fn();
    render(<HostManager remoteClient={remote} authClient={auth} onPairedConnected={connected} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete isolated scan" }));
    await waitFor(() => expect(remote.connect).toHaveBeenCalledWith("paired-relay"));
    expect(remote.connect).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledWith("paired-relay");
    expect(auth.saveProfile).not.toHaveBeenCalled();
  });
  afterEach(cleanup);
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  it("uses compact named icon actions and keeps deletion behind confirmation", async () => {
    const { remote, auth } = clients();
    render(<HostManager remoteClient={remote} authClient={auth} />);
    expect(await screen.findByRole("heading", { name: "Computers" })).toBeInTheDocument();
    const connect = await screen.findByRole("button", { name: "Connect" });
    expect(connect.textContent).toBe("");
    expect(connect.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Disconnected")).toHaveClass("visually-hidden");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(auth.deleteProfile).not.toHaveBeenCalled();
  });

  it("stores a password before saving only its opaque credential reference", async () => {
    const { remote, auth } = clients();
    vi.mocked(remote.listHostProfiles).mockResolvedValue([]);
    render(<HostManager remoteClient={remote} authClient={auth} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Add host" }))[0]);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Work" } });
    fireEvent.change(screen.getByLabelText("Address or hostname"), { target: { value: "work.test" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "agent" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "not-logged" } });
    fireEvent.click(screen.getByRole("button", { name: "Store securely" }));
    await waitFor(() => expect(auth.storePassword).toHaveBeenCalledWith("not-logged"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(auth.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "cred_new" })));
    expect(JSON.stringify(vi.mocked(auth.saveProfile).mock.calls)).not.toContain("not-logged");
  });

  it("requires explicit TOFU confirmation before retrying a connection", async () => {
    const { remote, auth } = clients();
    vi.mocked(remote.connect)
      .mockRejectedValueOnce({ code: "host_key_confirmation_required", message: "confirm", fingerprint: "SHA256:fixture", hostKeyHop: "direct" })
      .mockResolvedValueOnce({ profileId: profile.id, protocolMajor: 1, protocolMinor: 1, agentportVersion: "1", platform: "macos", capabilities: [] });
    render(<HostManager remoteClient={remote} authClient={auth} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByText("SHA256:fixture")).toBeInTheDocument();
    expect(auth.trustHostKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    await waitFor(() => expect(auth.trustHostKey).toHaveBeenCalledWith("host_1", "SHA256:fixture"));
    await waitFor(() => expect(remote.connect).toHaveBeenCalledTimes(2));
  });

  it("hard-blocks a changed host key without offering a trust action", async () => {
    const { remote, auth } = clients();
    vi.mocked(remote.connect).mockRejectedValue({ code: "host_key_changed", message: "host key changed", fingerprint: "SHA256:other", hostKeyHop: "direct" });
    render(<HostManager remoteClient={remote} authClient={auth} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("host key changed");
    expect(screen.queryByRole("button", { name: "Trust and connect" })).not.toBeInTheDocument();
  });
  it("edits Relay metadata without SSH fields and reconciles only through native authorization", async () => {
    const { remote, auth } = clients();
    const relayProfile: HostProfileDetails = { ...profile, name: "Relay fixture", preferredTransport: "relay", hostname: "wss://relay.example/v1/relay", username: "", enabled: false,
      relay: { peer: { name: "Mac", relayUrl: "wss://relay.example/v1/relay", publicKey: "computer-pin", hostId: "route" }, devicePublicKey: "phone", approved: false } };
    vi.mocked(remote.listHostProfiles).mockResolvedValue([{ ...relayProfile, connectionState: "disconnected", lastConnectedAt: null, lastError: null }]);
    vi.mocked(auth.getProfile).mockResolvedValue(relayProfile);
    vi.mocked(auth.reconcileRelayProfile).mockResolvedValue({ ...relayProfile, enabled: true, relay: { ...relayProfile.relay!, approved: true } });
    render(<HostManager remoteClient={remote} authClient={auth} />);
    fireEvent.click(await screen.findByRole("button", { name: /Relay fixture.*Disconnected/ }));
    await screen.findByText(/computer-pin/);
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check existing authorization" }));
    await waitFor(() => expect(auth.reconcileRelayProfile).toHaveBeenCalledWith("host_1"));
    await screen.findByText(/Relay identity is pinned/);
    expect(auth.saveProfile).not.toHaveBeenCalled(); expect(auth.trustHostKey).not.toHaveBeenCalled();
  });

  it("offers Disconnect when an authoritative initial snapshot is already connected", async () => {
    const { remote, auth } = clients();
    vi.mocked(remote.listHostProfiles).mockResolvedValue([{ ...profile, connectionState: "connected", lastConnectedAt: null, lastError: null }]);
    render(<HostManager remoteClient={remote} authClient={auth} />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(remote.disconnect).toHaveBeenCalledWith("host_1"));
    expect(remote.connect).not.toHaveBeenCalled();
  });

});
