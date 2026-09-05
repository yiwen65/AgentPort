import { expect, it, vi } from "vitest";
import { pairViaRelay, type PairingClient, type PreparedPairing } from "./pairingClient";
import type { HostProfileDetails } from "./types";
const peer = { name: "Mac", relayUrl: "wss://relay.example/v1/relay", publicKey: "computer-key", hostId: "computer-route" };
export const prepared: PreparedPairing = { attemptId: "opaque-attempt", profileId: "pending-host", peer, expiresAt: Date.now() / 1000 + 120 };
export const profile: HostProfileDetails = { id: "pending-host", name: "Mac", hostname: peer.relayUrl, port: 443, username: "", preferredTransport: "relay", authentication: "private_key", credentialId: "opaque-credential", relay: { peer, devicePublicKey: "phone-key", approved: true }, enabled: true, sortOrder: 0 };
function fixture(): PairingClient {
  return { preview: vi.fn(), prepare: vi.fn().mockResolvedValue(prepared), begin: vi.fn().mockResolvedValue({ requestId: "candidate", verificationCode: "1234-ABCD" }), wait: vi.fn().mockResolvedValue(profile), cancel: vi.fn().mockResolvedValue(undefined) };
}
it("uses native custody, begins only after prepare and reports success only after native approval", async () => {
  const client = fixture(); const compare = vi.fn();
  await expect(pairViaRelay("QR-secret", "Phone", client, new AbortController().signal, compare)).resolves.toBe("pending-host");
  expect(client.prepare).toHaveBeenCalledWith("QR-secret", "Phone");
  expect(client.begin).toHaveBeenCalledWith("opaque-attempt"); expect(client.wait).toHaveBeenCalledWith("opaque-attempt");
  expect(vi.mocked(client.prepare).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.begin).mock.invocationCallOrder[0]);
  expect(compare).toHaveBeenCalledWith("1234-ABCD"); expect(client.cancel).toHaveBeenCalledWith("opaque-attempt");
});
it("cancels a late native prepare without beginning or discarding the retained credential", async () => {
  const client = fixture(); const abort = new AbortController();
  let resolve!: (value: PreparedPairing) => void;
  vi.mocked(client.prepare).mockReturnValue(new Promise(done => { resolve = done; }));
  const result = pairViaRelay("code", "Phone", client, abort.signal, vi.fn());
  const rejected = expect(result).rejects.toThrow(); abort.abort(); resolve(prepared); await rejected;
  expect(client.begin).not.toHaveBeenCalled(); expect(client.cancel).toHaveBeenCalledWith("opaque-attempt");
});
it("does not retry an unknown exchange or claim success after UI cancellation", async () => {
  const client = fixture(); vi.mocked(client.wait).mockRejectedValue(new Error("unknown"));
  await expect(pairViaRelay("code", "Phone", client, new AbortController().signal, vi.fn())).rejects.toThrow("unknown");
  expect(client.prepare).toHaveBeenCalledTimes(1); expect(client.begin).toHaveBeenCalledTimes(1); expect(client.wait).toHaveBeenCalledTimes(1);
});
it.each(["profile", "computer", "unapproved"])("rejects mismatched native %s confirmation", async mode => {
  const client = fixture();
  vi.mocked(client.wait).mockResolvedValue({ ...profile, id: mode === "profile" ? "other" : profile.id, relay: { ...profile.relay!, approved: mode !== "unapproved", peer: { ...peer, publicKey: mode === "computer" ? "other" : peer.publicKey } } });
  await expect(pairViaRelay("code", "Phone", client, new AbortController().signal, vi.fn())).rejects.toThrow("identity mismatch");
});
