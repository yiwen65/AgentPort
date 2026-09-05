import { invoke } from "@tauri-apps/api/core";
import type {
  CredentialResult,
  HostAuthClient,
  HostProfileDetails,
  HostProfileDraft,
} from "../features/hosts-auth/types";

interface DeleteProfileResult {
  credentialId?: string;
}

export class TauriHostAuthClient implements HostAuthClient {
  getProfile(profileId: string): Promise<HostProfileDetails> {
    return invoke("mobile_get_host_profile", { profileId });
  }

  saveProfile(profile: HostProfileDraft): Promise<HostProfileDetails> {
    // getProfile also returns read-only status/trust fields, which the native
    // strict draft schema rejects. Preserve Relay pins but never forward status.
    const { id, name, hostname, port, username, preferredTransport, authentication,
      credentialId, relay, jump, moshUdpPortStart, moshUdpPortEnd, enabled, sortOrder } = profile;
    return invoke("mobile_save_host_profile", { request: {
      id, name, hostname, port, username, preferredTransport, authentication,
      credentialId, relay, jump, moshUdpPortStart, moshUdpPortEnd, enabled, sortOrder,
    } });
  }

  reconcileRelayProfile(profileId: string): Promise<HostProfileDetails> {
    return invoke("mobile_relay_pairing_reconcile", { profileId });
  }

  copyProfile(profileId: string): Promise<HostProfileDetails> {
    return invoke("mobile_copy_host_profile", { profileId });
  }

  async deleteProfile(
    profileId: string,
    deleteCredential: boolean,
    deleteTrust: boolean,
  ): Promise<void> {
    const result = await invoke<DeleteProfileResult>("mobile_delete_host_profile", {
      request: { profileId, deleteCredential, deleteTrust },
    });
    if (result.credentialId) {
      await invoke("mobile_delete_credential", { credentialId: result.credentialId });
    }
  }

  storePassword(password: string): Promise<CredentialResult> {
    return invoke("mobile_store_credential", { request: { secret: password } });
  }

  importPrivateKey(privateKey: string, passphrase?: string): Promise<CredentialResult> {
    return invoke("mobile_import_private_key_credential", {
      request: { privateKey, passphrase: passphrase || undefined },
    });
  }

  generatePrivateKey(): Promise<CredentialResult> {
    return invoke("mobile_generate_ed25519_credential");
  }

  deleteCredential(credentialId: string): Promise<void> {
    return invoke("mobile_delete_credential", { credentialId });
  }

  trustHostKey(profileId: string, fingerprint: string): Promise<void> {
    return invoke("mobile_trust_host_key", { profileId, fingerprint });
  }

  exportProfiles(passphrase: string): Promise<string> {
    return invoke("mobile_export_host_profiles", { request: { passphrase } });
  }

  async importProfiles(document: string, passphrase: string): Promise<number> {
    const result = await invoke<{ importedCount: number }>("mobile_import_host_profiles", {
      request: { document, passphrase },
    });
    return result.importedCount;
  }
}

export const hostAuthClient: HostAuthClient = new TauriHostAuthClient();
