// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { PairingSection } from "./PairingSection";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), qr: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
const candidate = { requestId: "phone-request", deviceName: "Temporary phone", fingerprint: "SHA256:fixture", verificationCode: "1234-ABCD" };
let phase = "pending";
beforeEach(async () => {
  vi.resetAllMocks(); phase = "pending"; await i18n.changeLanguage("en-US");
  mocks.qr.mockResolvedValue("data:image/png;base64,test");
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "desktop_pairing_defaults") return { address: "192.0.2.1", username: "test" };
    if (command === "desktop_pairing_devices") return [{ id: "phone-request", name: candidate.deviceName, fingerprint: candidate.fingerprint }];
    if (command === "desktop_pairing_start") return { id: "invitation", secret: "ephemeral-only", expiresAt: Date.now() / 1000 + 120 };
    if (command === "desktop_pairing_status") return { id: "invitation", state: phase, candidate };
    if (command === "desktop_pairing_decide") phase = "approved";
    return undefined;
  });
});
afterEach(cleanup);
it("requires desktop confirmation bound to exact invitation/request and clears QR after approval", async () => {
  render(<PairingSection />);
  await waitFor(() => expect((screen.getByLabelText("Address reachable from the phone") as HTMLInputElement).value).toBe("192.0.2.1"));
  fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
  await screen.findByText("1234-ABCD");
  expect(mocks.invoke.mock.calls.some(([command]) => command === "desktop_pairing_decide")).toBe(false);
  expect(screen.queryByText("ephemeral-only")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Codes match · Authorize" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_pairing_decide", { invitationId: "invitation", requestId: "phone-request", approve: true }));
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
});
it("revoke requires a second confirmation and includes expected fingerprint", async () => {
  render(<PairingSection />);
  fireEvent.click(await screen.findByRole("button", { name: "Revoke access" }));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "desktop_pairing_revoke")).toBe(false);
  expect(screen.getByText(/Already authenticated connections may remain active/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("desktop_pairing_revoke", { id: "phone-request", fingerprint: candidate.fingerprint }));
});
it("closes a late-created native invitation if settings was dismissed during start", async () => {
  const previous = mocks.invoke.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  mocks.invoke.mockImplementation((command: string, ...args: unknown[]) => command === "desktop_pairing_start" ? new Promise(done => { resolve = done; }) : previous(command, ...args));
  const view = render(<PairingSection />);
  await waitFor(() => expect((screen.getByLabelText("Address reachable from the phone") as HTMLInputElement).value).toBe("192.0.2.1"));
  fireEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
  await waitFor(() => expect(resolve).toBeDefined()); view.unmount();
  await act(async () => resolve({ id: "late", secret: "never-render", expiresAt: Date.now() / 1000 + 120 }));
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_pairing_close", { invitationId: "late" });
  expect(mocks.qr).not.toHaveBeenCalled();
});
