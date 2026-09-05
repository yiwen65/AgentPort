import { beforeEach, expect, it, vi } from "vitest";
import { TauriHostAuthClient } from "./tauriHostAuthClient";
import type { HostProfileDetails } from "../features/hosts-auth/types";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => invoke.mockReset());
it("preserves Relay pins while saving only fields accepted by the native draft schema", async () => {
  const profile: HostProfileDetails = {
    id: "host_test", name: "Computer", hostname: "wss://relay.example/v1/relay", port: 443, username: "",
    preferredTransport: "relay", authentication: "private_key", credentialId: "cred_opaque", enabled: true, sortOrder: 0,
    relay: { peer: { relayUrl: "wss://relay.example/v1/relay", publicKey: "computer", hostId: "route", name: "Computer" }, devicePublicKey: "phone", approved: true },
    trustedHostKey: "read-only", lastConnectedAt: "yesterday", lastError: "old error", lastKnownSummary: "read-only",
  };
  await new TauriHostAuthClient().saveProfile(profile);
  const [command, args] = invoke.mock.calls[0];
  expect(command).toBe("mobile_save_host_profile");
  expect(args.request.relay).toEqual(profile.relay);
  expect(args.request.credentialId).toBe("cred_opaque");
  for (const key of ["trustedHostKey", "lastConnectedAt", "lastError", "lastKnownSummary"]) expect(args.request).not.toHaveProperty(key);
});
