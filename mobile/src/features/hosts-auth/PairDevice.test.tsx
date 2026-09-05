import { cleanup, act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { PairDevice } from "./PairDevice";
import type { PairingClient } from "./pairingClient";
import type { HostProfileDetails } from "./types";
const camera = vi.hoisted(() => ({ checkPermissions: vi.fn(), requestPermissions: vi.fn(), scan: vi.fn(), cancel: vi.fn() }));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({ ...camera, Format: { QRCode: "QR_CODE" } }));
const peer = { name: "Mac", relayUrl: "wss://relay.example/v1/relay", publicKey: "computer-key", hostId: "route" };
const profile: HostProfileDetails = { id: "new-host", name: "Mac", hostname: peer.relayUrl, port: 443, username: "", preferredTransport: "relay", authentication: "private_key", credentialId: "opaque-key", enabled: true, sortOrder: 0, relay: { peer, devicePublicKey: "phone-key", approved: true } };
function fixture(): PairingClient {
  return {
    preview: vi.fn().mockResolvedValue({ peer, expiresAt: Date.now() / 1000 + 120 }),
    prepare: vi.fn().mockResolvedValue({ attemptId: "attempt", profileId: "new-host", peer, expiresAt: Date.now() / 1000 + 120 }),
    begin: vi.fn().mockResolvedValue({ requestId: "candidate", verificationCode: "1234-ABCD" }),
    wait: vi.fn().mockResolvedValue(profile), cancel: vi.fn().mockResolvedValue(undefined),
  };
}
async function request() {
  fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
  fireEvent.change(await screen.findByLabelText("Name of this phone"), { target: { value: "Phone" } });
  fireEvent.click(screen.getByRole("button", { name: "Request authorization" }));
}
describe("Relay pairing UI", () => {
  afterEach(cleanup);
  beforeEach(async () => {
    vi.resetAllMocks(); await i18n.changeLanguage("en-US");
    camera.checkPermissions.mockResolvedValue("granted"); camera.scan.mockResolvedValue({ content: "ephemeral-code" }); camera.cancel.mockResolvedValue(undefined);
  });
  it("recovers from denied camera without beginning native key custody", async () => {
    camera.checkPermissions.mockResolvedValue("denied"); const client = fixture();
    render(<PairDevice client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Allow camera access");
    expect(screen.getByText("No camera? Paste pairing code")).toBeInTheDocument();
    expect(camera.scan).not.toHaveBeenCalled(); expect(client.prepare).not.toHaveBeenCalled();
  });
  it("shows structured native scanner errors", async () => {
    camera.scan.mockRejectedValue({ message: "No camera available on this device (e.g., iOS Simulator)" }); const client = fixture();
    render(<PairDevice client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No camera available"); expect(client.prepare).not.toHaveBeenCalled();
  });
  it("keeps windowed Cancel reachable and completes only native Relay approval", async () => {
    const client = fixture(); const onPaired = vi.fn();
    render(<PairDevice client={client} onClose={vi.fn()} onPaired={onPaired} />);
    await request(); await waitFor(() => expect(onPaired).toHaveBeenCalledWith("new-host"));
    expect(camera.scan).toHaveBeenCalledWith(expect.objectContaining({ windowed: true }));
    expect(client.prepare).toHaveBeenCalledTimes(1); expect(client.wait).toHaveBeenCalledTimes(1);
  });
  it("unmount cancels scanning and restores the preview surface", async () => {
    camera.scan.mockReturnValue(new Promise(() => undefined));
    const view = render(<PairDevice client={fixture()} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" })); await waitFor(() => expect(camera.scan).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument(); view.unmount();
    expect(camera.cancel).toHaveBeenCalled(); expect(document.documentElement).not.toHaveClass("pairing-camera-active");
  });
  it("cancels a pending exchange and ignores late approval after closing", async () => {
    const client = fixture(); const onPaired = vi.fn(); let resolve!: (profile: HostProfileDetails) => void;
    vi.mocked(client.wait).mockReturnValue(new Promise(done => { resolve = done; }));
    const view = render(<PairDevice client={client} onClose={vi.fn()} onPaired={onPaired} />);
    await request(); await screen.findByText("1234-ABCD"); view.unmount();
    expect(client.cancel).toHaveBeenCalledWith("attempt"); await act(async () => resolve(profile)); expect(onPaired).not.toHaveBeenCalled();
  });
  it("offers a new scan after failure without replaying an unknown mutation", async () => {
    const client = fixture(); vi.mocked(client.wait).mockRejectedValue(new Error("unknown approval"));
    render(<PairDevice client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    await request(); expect(await screen.findByRole("alert")).toHaveTextContent("unknown approval");
    fireEvent.click(screen.getByRole("button", { name: "Scan a new code" })); expect(screen.getByRole("button", { name: "Scan to pair" })).toBeInTheDocument();
    expect(client.wait).toHaveBeenCalledTimes(1);
  });
});
