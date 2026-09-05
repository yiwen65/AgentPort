import { describe, expect, it, vi } from "vitest";
import { finishPairing, preparePairing, type PairingClient } from "./pairingClient";
import type { HostAuthClient } from "./types";
const ssh = { name: "Mac", hostname: "192.0.2.1", port: 22, username: "test", fingerprint: "SHA256:test" };
function fixture() {
  const auth = {
    generatePrivateKey: vi.fn().mockResolvedValue({ credentialId: "new-key", publicKey: "public-key" }),
    saveProfile: vi.fn().mockImplementation(async profile => ({ ...profile, id: "pending-host" })),
    trustHostKey: vi.fn().mockResolvedValue(undefined),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
  } as unknown as HostAuthClient;
  const client: PairingClient = {
    preview: vi.fn().mockResolvedValue({ ssh, expiresAt: Date.now() / 1000 + 120 }),
    prepare: vi.fn().mockResolvedValue({ request: { requestId: "request", publicKey: "public-key", deviceName: "Phone" }, verificationCode: "1234-ABCD" }),
    exchange: vi.fn(),
  };
  return { auth, client, controller: new AbortController() };
}
describe("first-time pairing custody", () => {
  it("rejects invalid QR before generating credentials", async () => {
    const { auth, client, controller } = fixture();
    vi.mocked(client.preview).mockRejectedValue(new Error("expired"));
    await expect(preparePairing("code", "Phone", auth, client, controller.signal)).rejects.toThrow("expired");
    expect(auth.generatePrivateKey).not.toHaveBeenCalled();
  });
  it("saves only a disabled new-key reference before network authorization; enables only exact approval", async () => {
    const { auth, client, controller } = fixture();
    const attempt = await preparePairing("ephemeral-secret", "Phone", auth, client, controller.signal);
    expect(attempt.profile.enabled).toBe(false);
    expect(auth.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "new-key", enabled: false }));
    expect(JSON.stringify(vi.mocked(auth.saveProfile).mock.calls)).not.toContain("ephemeral-secret");
    expect(client.exchange).not.toHaveBeenCalled();
    await finishPairing({ requestId: "request", state: "approved", ssh }, attempt, auth, controller.signal);
    expect(auth.trustHostKey).toHaveBeenCalledWith("pending-host", ssh.fingerprint);
    expect(auth.saveProfile).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(vi.mocked(auth.trustHostKey).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(auth.saveProfile).mock.invocationCallOrder[1]);
  });
  it("retains pending key/profile and refuses late approval after cancellation", async () => {
    const { auth, client, controller } = fixture();
    const attempt = await preparePairing("code", "Phone", auth, client, controller.signal);
    controller.abort();
    await expect(finishPairing({ requestId: "request", state: "approved", ssh }, attempt, auth, controller.signal)).rejects.toThrow();
    expect(auth.trustHostKey).not.toHaveBeenCalled();
    expect(auth.saveProfile).toHaveBeenCalledTimes(1);
    expect(auth.deleteCredential).not.toHaveBeenCalled();
  });
  it.each(["denied", "mismatched-key", "mismatched-request"])("fails closed for %s", async kind => {
    const { auth, client, controller } = fixture();
    const attempt = await preparePairing("code", "Phone", auth, client, controller.signal);
    await expect(finishPairing({ state: kind === "denied" ? "denied" : "approved", requestId: kind === "mismatched-request" ? "other" : "request", ssh: { ...ssh, fingerprint: kind === "mismatched-key" ? "other" : ssh.fingerprint } }, attempt, auth, controller.signal)).rejects.toThrow("identity mismatch");
    expect(auth.trustHostKey).not.toHaveBeenCalled();
    expect(auth.saveProfile).toHaveBeenCalledTimes(1);
  });
  it("does not enable if trust persistence fails and does not delete a possibly persisted credential", async () => {
    const { auth, client, controller } = fixture();
    const attempt = await preparePairing("code", "Phone", auth, client, controller.signal);
    vi.mocked(auth.trustHostKey).mockRejectedValue(new Error("storage unavailable"));
    await expect(finishPairing({ requestId: "request", state: "approved", ssh }, attempt, auth, controller.signal)).rejects.toThrow();
    expect(auth.saveProfile).toHaveBeenCalledTimes(1);
    expect(auth.deleteCredential).not.toHaveBeenCalled();
  });
});
