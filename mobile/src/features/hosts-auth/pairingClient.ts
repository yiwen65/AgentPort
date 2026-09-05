import { invoke } from "@tauri-apps/api/core";
import type { HostAuthClient, HostProfileDetails } from "./types";

export interface SshTarget { name: string; hostname: string; port: number; username: string; fingerprint: string }
export interface PairingPreview { ssh: SshTarget; expiresAt: number }
export interface PairingRequest { requestId: string; deviceName: string; publicKey: string }
export interface PreparedPairing { request: PairingRequest; verificationCode: string }
export interface PairingReply { requestId: string; state: string; ssh?: SshTarget }
export interface PairingClient {
  preview(code: string): Promise<PairingPreview>;
  prepare(code: string, publicKey: string, deviceName: string): Promise<PreparedPairing>;
  exchange(code: string, request: PairingRequest): Promise<PairingReply>;
}
export const pairingClient: PairingClient = {
  preview: code => invoke("mobile_pairing_preview", { code }),
  prepare: (code, publicKey, deviceName) => invoke("mobile_pairing_prepare", { code, publicKey, deviceName }),
  exchange: (code, request) => invoke("mobile_pairing_exchange", { code, request }),
};

/** Persist the new key's disabled profile before any request can authorize it.
 * Cancellation/unknown delivery never destroys a possibly authorized credential.
 * Only an authenticated approval can install trust and enable the profile.
 */
export async function preparePairing(code: string, deviceName: string, auth: HostAuthClient, client: PairingClient, signal: AbortSignal) {
  const preview = await client.preview(code);
  signal.throwIfAborted();
  const credential = await auth.generatePrivateKey();
  let prepared: PreparedPairing;
  try {
    signal.throwIfAborted();
    if (!credential.publicKey) throw new Error("Generated key has no public key");
    prepared = await client.prepare(code, credential.publicKey, deviceName);
    signal.throwIfAborted();
  } catch (error) {
    await auth.deleteCredential(credential.credentialId);
    throw error;
  }
  // A save failure can have an unknown commit outcome. Keep the new credential;
  // unlike deleting it, this cannot invalidate a successfully persisted profile.
  const profile = await auth.saveProfile({
    name: `${preview.ssh.name} · ${deviceName}`, hostname: preview.ssh.hostname,
    port: preview.ssh.port, username: preview.ssh.username, preferredTransport: "ssh",
    authentication: "private_key", credentialId: credential.credentialId, enabled: false, sortOrder: 0,
  });
  signal.throwIfAborted();
  return { preview, prepared, profile };
}
export async function finishPairing(reply: PairingReply, attempt: Awaited<ReturnType<typeof preparePairing>>, auth: HostAuthClient, signal: AbortSignal): Promise<HostProfileDetails> {
  signal.throwIfAborted();
  const expected = attempt.preview.ssh;
  if (reply.state !== "approved" || reply.requestId !== attempt.prepared.request.requestId
      || !reply.ssh || (Object.keys(expected) as (keyof SshTarget)[]).some(key => expected[key] !== reply.ssh![key])) {
    throw new Error("Pairing approval identity mismatch");
  }
  await auth.trustHostKey(attempt.profile.id, expected.fingerprint);
  signal.throwIfAborted();
  return auth.saveProfile({ ...attempt.profile, enabled: true });
}
