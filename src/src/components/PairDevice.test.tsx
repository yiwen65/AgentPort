// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import PairDevice, { pairErrorKey, parsePairingPayload } from "./PairDevice";
import { resetDevicesStoreForTests, setDevicesInvokerForTests } from "../devicesStore";

const addedDevice = {
  id: "dev_new",
  name: "Office PC",
  transport: "relay",
  peer: { relayUrl: "wss://relay.example/v1/relay", publicKey: "pk", hostId: "host-1" },
  lastConnectedAt: null,
  lastError: null,
};

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "inv-1",
    peer: {
      relayUrl: "wss://relay.example/v1/relay",
      publicKey: "pk",
      hostId: "host-1",
      name: "Office",
    },
    secret: "s3cret",
    expiresAt: Math.floor(Date.now() / 1000) + 120,
    ...overrides,
  };
}

function asPairLink(value: object): string {
  return `agentport-pair:${btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")}`;
}

const passwordField = () =>
  screen.getByLabelText("Password", { selector: "input[type='password']" });

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  resetDevicesStoreForTests();
  setDevicesInvokerForTests(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "device_pair_redeem" || command === "device_add_ssh") {
      return structuredClone(addedDevice);
    }
    if (command === "device_list") return [structuredClone(addedDevice)];
    throw new Error(`Unexpected command ${command}`);
  });
});

afterEach(cleanup);

describe("parsePairingPayload", () => {
  it("accepts raw invitation JSON", () => {
    const parsed = parsePairingPayload(JSON.stringify(invitation()));
    expect(parsed.id).toBe("inv-1");
  });

  it("accepts the agentport-pair: base64url form", () => {
    const parsed = parsePairingPayload(asPairLink(invitation()));
    expect(parsed.id).toBe("inv-1");
  });

  it("rejects garbage, missing fields, and expired invitations", () => {
    expect(() => parsePairingPayload("not json")).toThrow();
    expect(() => parsePairingPayload("{}")).toThrow("invalid");
    expect(() =>
      parsePairingPayload(JSON.stringify(invitation({ expiresAt: 1 }))),
    ).toThrow("expired");
  });
});

describe("pairErrorKey", () => {
  it("maps structured codes to stable tags", () => {
    expect(pairErrorKey("auth_failed")).toBe("authFailed");
    expect(pairErrorKey("host_key_changed")).toBe("hostKeyChanged");
    expect(pairErrorKey("timeout")).toBe("unreachable");
    expect(pairErrorKey("incompatible_major")).toBe("incompatible");
    expect(pairErrorKey("whatever")).toBe("generic");
  });
});

describe("pairing-code tab", () => {
  it("redeems a pasted payload and offers an immediate switch", async () => {
    const onClose = vi.fn();
    const onSwitchDevice = vi.fn();
    render(<PairDevice onClose={onClose} onSwitchDevice={onSwitchDevice} />);
    const payload = asPairLink(invitation());
    fireEvent.change(screen.getByLabelText("Pairing code / link"), {
      target: { value: payload },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await screen.findByText("Office PC added.");
    expect(mocks.invoke).toHaveBeenCalledWith("device_pair_redeem", {
      payload,
      name: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch to this device now" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSwitchDevice).toHaveBeenCalledWith({
      kind: "remote",
      deviceId: "dev_new",
      deviceName: "Office PC",
      capabilities: [],
    });
  });

  it("blocks expired codes client-side without invoking", async () => {
    render(<PairDevice onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Pairing code / link"), {
      target: { value: JSON.stringify(invitation({ expiresAt: 1 })) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await screen.findByText(/expired/);
    expect(mocks.invoke).not.toHaveBeenCalledWith(
      "device_pair_redeem",
      expect.anything(),
    );
  });

  it("surfaces structured redeem failures", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "device_pair_redeem") {
        throw { code: "pairing_expired", message: "invitation expired" };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    render(<PairDevice onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Pairing code / link"), {
      target: { value: JSON.stringify(invitation()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await screen.findByText(/generate a fresh one on the peer/);
  });
});

describe("manual SSH tab", () => {
  async function openSshTab() {
    render(<PairDevice onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Manual SSH" }));
  }

  it("submits a password draft and shows the success state", async () => {
    await openSshTab();
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "192.168.1.10" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dev" } });
    fireEvent.change(passwordField(), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & add" }));
    await screen.findByText("Office PC added.");
    expect(mocks.invoke).toHaveBeenCalledWith("device_add_ssh", {
      draft: {
        name: "192.168.1.10",
        hostname: "192.168.1.10",
        port: 22,
        username: "dev",
        auth: { kind: "password", password: "pw" },
      },
    });
  });

  it("switches auth kinds and posts a private-key draft", async () => {
    await openSshTab();
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "2222" } });
    fireEvent.click(screen.getByLabelText("Private key"));
    fireEvent.change(screen.getByLabelText("Private key (PEM)"), {
      target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\nx" },
    });
    fireEvent.change(screen.getByLabelText("Key passphrase (optional)"), {
      target: { value: "pp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect & add" }));
    await screen.findByText("Office PC added.");
    expect(mocks.invoke).toHaveBeenCalledWith("device_add_ssh", {
      draft: {
        name: "box",
        hostname: "box",
        port: 2222,
        username: "dev",
        auth: {
          kind: "privateKey",
          pem: "-----BEGIN OPENSSH PRIVATE KEY-----\nx",
          passphrase: "pp",
        },
      },
    });
  });

  it("validates required fields before invoking", async () => {
    await openSshTab();
    fireEvent.click(screen.getByRole("button", { name: "Connect & add" }));
    await screen.findByText("Hostname is required.");
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dev" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & add" }));
    await screen.findByText(/Port must be an integer/);
    expect(mocks.invoke).not.toHaveBeenCalledWith("device_add_ssh", expect.anything());
  });

  it("maps structured probe errors to distinct messages", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "device_add_ssh") {
        throw { code: "host_key_changed", message: "key mismatch" };
      }
      throw new Error(`Unexpected command ${command}`);
    });
    await openSshTab();
    fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "box" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "dev" } });
    fireEvent.change(passwordField(), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect & add" }));
    await screen.findByText(/host key differs from the pinned one/);
  });

  it("blocks closing while a request is in flight", async () => {
    let release!: (value: unknown) => void;
    mocks.invoke.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const onClose = vi.fn();
    render(<PairDevice onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Pairing code / link"), {
      target: { value: JSON.stringify(invitation()) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await screen.findByText("Connecting and verifying the peer…");
    release(structuredClone(addedDevice));
    await screen.findByText("Office PC added.");
  });
});
