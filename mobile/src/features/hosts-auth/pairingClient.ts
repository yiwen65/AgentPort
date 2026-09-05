import { invoke } from "@tauri-apps/api/core";
import type { HostProfileDetails, RelayPeer } from "./types";
export interface PairingPreview { peer: RelayPeer; expiresAt: number }
export interface PreparedPairing extends PairingPreview { attemptId: string; profileId: string }
export interface PairingComparison { requestId: string; verificationCode: string }
export interface PairingClient {
  preview(code: string): Promise<PairingPreview>;
  prepare(code: string, deviceName: string): Promise<PreparedPairing>;
  begin(attemptId: string): Promise<PairingComparison>;
  wait(attemptId: string): Promise<HostProfileDetails>;
  cancel(attemptId: string): Promise<void>;
}
export const pairingClient: PairingClient = {
  preview: code => invoke("mobile_relay_pairing_preview", { code }),
  prepare: (code, deviceName) => invoke("mobile_relay_pairing_prepare", { code, deviceName }),
  begin: attemptId => invoke("mobile_relay_pairing_begin", { attemptId }),
  wait: attemptId => invoke("mobile_relay_pairing_wait", { attemptId }),
  cancel: attemptId => invoke("mobile_relay_pairing_cancel", { attemptId }),
};
/** Native prepare durably retains a disabled profile/key BEFORE any network
 * authorization. A late prepare after UI cancellation must also be cancelled.
 * No JS key generation, trust write or mutation retry is part of this flow. */
export async function pairViaRelay(code: string, deviceName: string, client: PairingClient,
  signal: AbortSignal, compare: (code: string) => void): Promise<string> {
  signal.throwIfAborted();
  const prepared = await client.prepare(code, deviceName);
  const cancel = () => { void client.cancel(prepared.attemptId).catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const comparison = await client.begin(prepared.attemptId);
    signal.throwIfAborted(); compare(comparison.verificationCode);
    const profile = await client.wait(prepared.attemptId);
    signal.throwIfAborted();
    if (profile.id !== prepared.profileId || profile.preferredTransport !== "relay" || !profile.enabled || !profile.relay?.approved
      || profile.relay.peer.hostId !== prepared.peer.hostId || profile.relay.peer.publicKey !== prepared.peer.publicKey) {
      throw new Error("Pairing approval identity mismatch");
    }
    return profile.id;
  } finally {
    signal.removeEventListener("abort", cancel);
    // Idempotent cleanup closes only this attempt, never discards credentials.
    await client.cancel(prepared.attemptId).catch(() => undefined);
  }
}
