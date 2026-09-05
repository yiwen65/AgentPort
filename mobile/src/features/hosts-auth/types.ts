export type PreferredTransport = "ssh" | "mosh" | "relay";
export type AuthenticationKind = "password" | "private_key";

export interface RelayPeer { relayUrl: string; publicKey: string; hostId: string; name: string }
export interface RelayProfile { peer: RelayPeer; devicePublicKey: string | null; approved: boolean }

export interface HostProfileDraft {
  id?: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  preferredTransport: PreferredTransport;
  authentication: AuthenticationKind;
  credentialId: string;
  relay?: RelayProfile | null;
  jump?: { hostProfileId: string };
  moshUdpPortStart?: number;
  moshUdpPortEnd?: number;
  enabled: boolean;
  sortOrder: number;
}

export interface HostProfileDetails extends HostProfileDraft {
  id: string;
  trustedHostKey?: string;
  lastConnectedAt?: string;
  lastError?: string;
  lastKnownSummary?: string;
}

export interface CredentialResult {
  credentialId: string;
  publicKey?: string;
}

export interface HostAuthClient {
  getProfile(profileId: string): Promise<HostProfileDetails>;
  saveProfile(profile: HostProfileDraft): Promise<HostProfileDetails>;
  reconcileRelayProfile(profileId: string): Promise<HostProfileDetails>;
  copyProfile(profileId: string): Promise<HostProfileDetails>;
  deleteProfile(profileId: string, deleteCredential: boolean, deleteTrust: boolean): Promise<void>;
  storePassword(password: string): Promise<CredentialResult>;
  importPrivateKey(privateKey: string, passphrase?: string): Promise<CredentialResult>;
  generatePrivateKey(): Promise<CredentialResult>;
  deleteCredential(credentialId: string): Promise<void>;
  trustHostKey(profileId: string, fingerprint: string): Promise<void>;
  exportProfiles(passphrase: string): Promise<string>;
  importProfiles(document: string, passphrase: string): Promise<number>;
}
