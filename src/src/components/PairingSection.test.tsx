// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { PairingSection } from "./PairingSection";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), qr: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
const candidate = { requestId: "phone-request", name: "Temporary phone", publicKey: "phone-key", verificationCode: "1234-ABCD" };
let status: any;
beforeEach(async () => {
  vi.resetAllMocks(); await i18n.changeLanguage("en-US");
  status = { phase: "connected", peer: { relayUrl: "wss://relay.example/v1/relay", name: "Test computer", publicKey: "computer", hostId: "route" }, devices: [{ name: candidate.name, publicKey: candidate.publicKey }], pairing: null, activeChannels: 0 };
  mocks.qr.mockResolvedValue("data:image/png;base64,test");
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "desktop_relay_status" || command === "desktop_relay_start") return structuredClone(status);
    if (command === "desktop_relay_control") {
      const req = args.request;
      if (req.kind === "invite_automatic") {
        status.pairing = { invitationId: "invitation", expiresAt: Date.now() / 1000 + 120, phase: "pending", candidate };
        return { kind: "invitation", invitation: { id: "invitation", expiresAt: status.pairing.expiresAt, secret: "ephemeral-only" } };
      }
      if (req.kind === "decide") status.pairing.phase = req.approve ? "approved" : "denied";
      if (req.kind === "revoke") status.devices = [];
      if (req.kind === "close_invitation") status.pairing = null;
      return { kind: "ok" };
    }
    throw new Error(`Unexpected command ${command}`);
  });
});
afterEach(cleanup);
async function loaded() { await screen.findByText("Background connected to Relay"); }
it("requests scan-to-authorize without a second confirmation and never invokes SSH pairing", async () => {
  render(<PairingSection />); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_relay_control", { request: { kind: "invite_automatic" } }));
  expect(mocks.invoke.mock.calls.some(([, args]) => args?.request?.kind === "decide")).toBe(false);
  expect(screen.queryByText("ephemeral-only")).toBeNull();
  expect(screen.queryByRole("button", { name: "Codes match · Authorize" })).toBeNull();
  expect(screen.queryByText("1234-ABCD")).toBeNull();
  expect(mocks.invoke.mock.calls.every(([command]) => !String(command).startsWith("desktop_pairing_"))).toBe(true);
});
it("revocation requires confirmation and binds the exact device key", async () => {
  render(<PairingSection />); fireEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
  expect(mocks.invoke.mock.calls.some(([, args]) => args?.request?.kind === "revoke")).toBe(false);
  expect(screen.getByText(/closes this phone’s current Relay channels/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_relay_control", { request: { kind: "revoke", public_key: "phone-key" } }));
});
it("closes a late invitation after dismissal, but leaves the background process running", async () => {
  const previous = mocks.invoke.getMockImplementation()!; let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation((command: string, args: any) => args?.request?.kind === "invite_automatic" ? new Promise(done => { resolve = done; }) : previous(command, args));
  const view = render(<PairingSection />); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
  await waitFor(() => expect(resolve).toBeDefined()); view.unmount();
  await act(async () => resolve({ kind: "invitation", invitation: { id: "late", expiresAt: Date.now() / 1000 + 120, secret: "never-render" } }));
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_relay_control", { request: { kind: "close_invitation", invitation_id: "late" } });
  expect(mocks.qr).not.toHaveBeenCalled(); expect(mocks.invoke.mock.calls.some(([, args]) => args?.request?.kind === "stop")).toBe(false);
});
it("sends the registration credential only to native configuration and clears its input", async () => {
  render(<PairingSection />); await loaded();
  fireEvent.change(screen.getByLabelText("Relay registration token"), { target: { value: "isolated-deployment-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_relay_control", { request: { kind: "configure", relay_url: "wss://relay.example/v1/relay", name: "Test computer", token: "isolated-deployment-token" } }));
  expect((screen.getByLabelText("Relay registration token") as HTMLInputElement).value).toBe("");
  expect(mocks.qr).not.toHaveBeenCalled();
});
it("does not replay an uncertain automatic invitation", async () => {
  const previous = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: any) => {
    if (args?.request?.kind === "invite_automatic") { return Promise.reject(new Error("unknown delivery")); }
    return previous(command, args);
  });
  render(<PairingSection />); await loaded(); fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
  await screen.findByText("unknown delivery");
  expect(mocks.invoke.mock.calls.filter(([, args]) => args?.request?.kind === "invite_automatic")).toHaveLength(1);
});
