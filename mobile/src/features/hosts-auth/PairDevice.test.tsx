import { cleanup, act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n";
import { PairDevice } from "./PairDevice";
import type { PairingClient, PairingReply } from "./pairingClient";
import type { HostAuthClient } from "./types";
const camera = vi.hoisted(() => ({ checkPermissions: vi.fn(), requestPermissions: vi.fn(), scan: vi.fn(), cancel: vi.fn() }));
vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({ ...camera, Format: { QRCode: "QR_CODE" } }));
const ssh = { name: "Mac", hostname: "192.0.2.1", port: 22, username: "test", fingerprint: "SHA256:test" };
function fixture() {
  const auth = {
    generatePrivateKey: vi.fn().mockResolvedValue({ credentialId: "new-key", publicKey: "public-key" }),
    saveProfile: vi.fn().mockImplementation(async profile => ({ ...profile, id: "new-host" })),
    trustHostKey: vi.fn().mockResolvedValue(undefined), deleteCredential: vi.fn(),
  } as unknown as HostAuthClient;
  const client: PairingClient = {
    preview: vi.fn().mockResolvedValue({ ssh, expiresAt: Date.now() / 1000 + 120 }),
    prepare: vi.fn().mockResolvedValue({ request: { requestId: "request", publicKey: "public-key", deviceName: "Phone" }, verificationCode: "1234-ABCD" }),
    exchange: vi.fn().mockResolvedValue({ requestId: "request", state: "approved", ssh }),
  };
  return { auth, client };
}
async function request() {
  fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
  fireEvent.change(await screen.findByLabelText("Name of this phone"), { target: { value: "Phone" } });
  fireEvent.click(screen.getByRole("button", { name: "Request authorization" }));
}
describe("pairing UI", () => {
  afterEach(() => cleanup());
  beforeEach(async () => {
    vi.resetAllMocks(); await i18n.changeLanguage("en-US");
    camera.checkPermissions.mockResolvedValue("granted"); camera.scan.mockResolvedValue({ content: "ephemeral-code" }); camera.cancel.mockResolvedValue(undefined);
  });
  it("has a denied-camera recovery path without generating a credential", async () => {
    camera.checkPermissions.mockResolvedValue("denied");
    const { auth, client } = fixture();
    render(<PairDevice auth={auth} client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Allow camera access");
    expect(screen.getByText("No camera? Paste pairing code")).toBeInTheDocument();
    expect(camera.scan).not.toHaveBeenCalled(); expect(auth.generatePrivateKey).not.toHaveBeenCalled();
  });
  it("renders the structured native camera-unavailable reason rather than object coercion", async () => {
    camera.scan.mockRejectedValue({ message: "No camera available on this device (e.g., iOS Simulator)" });
    const { auth, client } = fixture();
    render(<PairDevice auth={auth} client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No camera available");
    expect(auth.generatePrivateKey).not.toHaveBeenCalled();
  });
  it("scans windowed so Cancel stays reachable, then completes only explicit authorization", async () => {
    const { auth, client } = fixture(); const onPaired = vi.fn();
    render(<PairDevice auth={auth} client={client} onClose={vi.fn()} onPaired={onPaired} />);
    await request();
    await waitFor(() => expect(onPaired).toHaveBeenCalledWith("new-host"));
    expect(camera.scan).toHaveBeenCalledWith(expect.objectContaining({ windowed: true }));
    expect(auth.saveProfile).toHaveBeenCalledTimes(2);
  });
  it("unmount cancels scanner and restores the transparent surface", async () => {
    camera.scan.mockReturnValue(new Promise(() => undefined));
    const { auth, client } = fixture();
    const view = render(<PairDevice auth={auth} client={client} onClose={vi.fn()} onPaired={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Scan to pair" }));
    await waitFor(() => expect(camera.scan).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    view.unmount(); expect(camera.cancel).toHaveBeenCalled();
    expect(document.documentElement).not.toHaveClass("pairing-camera-active");
  });
  it("late network approval after closing does not enable or discard the pending key", async () => {
    const { auth, client } = fixture(); const onPaired = vi.fn();
    let resolve!: (reply: PairingReply) => void;
    vi.mocked(client.exchange).mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<PairDevice auth={auth} client={client} onClose={vi.fn()} onPaired={onPaired} />);
    await request(); await screen.findByText("1234-ABCD");
    view.unmount(); await act(async () => resolve({ requestId: "request", state: "approved", ssh }));
    expect(auth.trustHostKey).not.toHaveBeenCalled(); expect(auth.deleteCredential).not.toHaveBeenCalled(); expect(onPaired).not.toHaveBeenCalled();
  });
});
