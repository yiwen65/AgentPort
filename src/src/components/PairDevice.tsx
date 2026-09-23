// Add-device modal: redeem a pairing code/link from another AgentPort PC, or
// add a machine manually over SSH. Both paths end with an optional immediate
// switch to the new device. New desktop code (desktop multi-device switching).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DeviceContext } from "../deviceContext";
import {
  addSshDevice,
  deviceCommandError,
  redeemPairing,
  type DeviceProfile,
  type DeviceSwitchHandler,
} from "../devicesStore";
import Modal from "./Modal";

type Tab = "code" | "ssh";

interface ParsedInvitation {
  id: string;
  expiresAt: number;
}

/** Client-side pre-validation only; the Rust redeem path re-validates fully. */
export function parsePairingPayload(payload: string): ParsedInvitation {
  let text = payload.trim();
  if (!text) throw new Error("empty");
  if (text.startsWith("agentport-pair:")) {
    const body = text.slice("agentport-pair:".length);
    const base64 = body.replace(/-/g, "+").replace(/_/g, "/");
    text = atob(base64);
  }
  const value: unknown = JSON.parse(text);
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const peer =
    record && typeof record.peer === "object" && record.peer !== null
      ? (record.peer as Record<string, unknown>)
      : null;
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.secret !== "string" ||
    typeof record.expiresAt !== "number" ||
    !peer ||
    typeof peer.relayUrl !== "string" ||
    typeof peer.publicKey !== "string" ||
    typeof peer.hostId !== "string"
  ) {
    throw new Error("invalid");
  }
  if (record.expiresAt * 1000 <= Date.now()) throw new Error("expired");
  return { id: record.id, expiresAt: record.expiresAt };
}

/** Map structured Rust error codes to stable i18n keys. */
export function pairErrorKey(code: string): string {
  switch (code) {
    case "auth_failed":
    case "authentication_failed":
    case "permission_denied":
      return "authFailed";
    case "host_key_changed":
      return "hostKeyChanged";
    case "connect_failed":
    case "unreachable":
    case "timeout":
    case "io":
      return "unreachable";
    case "protocol_incompatible":
    case "incompatible_version":
    case "incompatible_major":
      return "incompatible";
    case "pairing_expired":
    case "invitation_expired":
    case "expired":
      return "expired";
    case "invalid_payload":
    case "invalid_invitation":
    case "invalid_pairing_code":
      return "invalid";
    case "pairing_denied":
    case "denied":
      return "denied";
    default:
      return "generic";
  }
}

/** Literal key map keeps t() fully type-checked (no template-literal keys). */
const PAIR_ERROR_I18N_KEYS = {
  authFailed: "settings:ui.devices.pair.errors.authFailed",
  hostKeyChanged: "settings:ui.devices.pair.errors.hostKeyChanged",
  unreachable: "settings:ui.devices.pair.errors.unreachable",
  incompatible: "settings:ui.devices.pair.errors.incompatible",
  expired: "settings:ui.devices.pair.errors.expired",
  invalid: "settings:ui.devices.pair.errors.invalid",
  denied: "settings:ui.devices.pair.errors.denied",
  generic: "settings:ui.devices.pair.errors.generic",
} as const;

type PairErrorTag = keyof typeof PAIR_ERROR_I18N_KEYS;

export default function PairDevice(props: {
  onClose: () => void;
  onSwitchDevice?: DeviceSwitchHandler;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [tab, setTab] = useState<Tab>("code");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<DeviceProfile | null>(null);

  // Pairing-code tab state
  const [payload, setPayload] = useState("");
  const [pairName, setPairName] = useState("");

  // SSH tab state
  const [sshName, setSshName] = useState("");
  const [hostname, setHostname] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState<"password" | "privateKey">("password");
  const [password, setPassword] = useState("");
  const [pem, setPem] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const fail = (cause: unknown) => {
    const structured = deviceCommandError(cause);
    setError(
      t(PAIR_ERROR_I18N_KEYS[pairErrorKey(structured.code) as PairErrorTag], {
        detail: structured.message,
      }),
    );
  };

  const submitCode = async () => {
    setError(null);
    try {
      parsePairingPayload(payload);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : "invalid";
      setError(
        t(
          reason === "expired"
            ? "settings:ui.devices.pair.errors.expired"
            : "settings:ui.devices.pair.errors.invalid",
        ),
      );
      return;
    }
    setBusy(true);
    try {
      setAdded(await redeemPairing(payload, pairName.trim() || undefined));
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const submitSsh = async () => {
    setError(null);
    const parsedPort = Number.parseInt(port, 10);
    if (!hostname.trim()) {
      setError(t("settings:ui.devices.pair.errors.hostnameRequired"));
      return;
    }
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setError(t("settings:ui.devices.pair.errors.portInvalid"));
      return;
    }
    if (!username.trim()) {
      setError(t("settings:ui.devices.pair.errors.usernameRequired"));
      return;
    }
    if (authKind === "password" && !password) {
      setError(t("settings:ui.devices.pair.errors.passwordRequired"));
      return;
    }
    if (authKind === "privateKey" && !pem.trim()) {
      setError(t("settings:ui.devices.pair.errors.pemRequired"));
      return;
    }
    setBusy(true);
    try {
      setAdded(
        await addSshDevice({
          name: sshName.trim() || hostname.trim(),
          hostname: hostname.trim(),
          port: parsedPort,
          username: username.trim(),
          auth:
            authKind === "password"
              ? { kind: "password", password }
              : {
                  kind: "privateKey",
                  pem: pem.trim(),
                  passphrase: passphrase || undefined,
                },
        }),
      );
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  };

  const switchNow = () => {
    if (!added) return;
    const target: DeviceContext = {
      kind: "remote",
      deviceId: added.id,
      deviceName: added.name,
      capabilities: [],
    };
    props.onClose();
    void Promise.resolve(props.onSwitchDevice?.(target)).catch(() => undefined);
  };

  return (
    <Modal
      title={t("settings:ui.devices.pair.title")}
      onClose={busy ? () => undefined : props.onClose}
      wide
    >
      {added ? (
        <div className="pair-device-success">
          <p>
            {t("settings:ui.devices.pair.success", { name: added.name })}
          </p>
          <div className="pairing-buttons">
            <button className="btn primary" onClick={switchNow}>
              {t("settings:ui.devices.pair.switchNow")}
            </button>
            <button className="btn" onClick={props.onClose}>
              {t("common:actions.done")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="pair-device-tabs" role="tablist">
            <button
              className="pair-device-tab"
              role="tab"
              aria-selected={tab === "code"}
              disabled={busy}
              onClick={() => {
                setTab("code");
                setError(null);
              }}
            >
              {t("settings:ui.devices.pair.codeTab")}
            </button>
            <button
              className="pair-device-tab"
              role="tab"
              aria-selected={tab === "ssh"}
              disabled={busy}
              onClick={() => {
                setTab("ssh");
                setError(null);
              }}
            >
              {t("settings:ui.devices.pair.sshTab")}
            </button>
          </div>
          {tab === "code" ? (
            <div className="pair-device-form">
              <label htmlFor="pair-payload" className="full-row">
                {t("settings:ui.devices.pair.payloadLabel")}
              </label>
              <textarea
                id="pair-payload"
                className="full-row"
                autoComplete="off"
                spellCheck={false}
                placeholder={t("settings:ui.devices.pair.payloadPlaceholder")}
                value={payload}
                disabled={busy}
                onChange={(event) => setPayload(event.target.value)}
              />
              <label htmlFor="pair-name">
                {t("settings:ui.devices.pair.nameLabel")}
              </label>
              <input
                id="pair-name"
                maxLength={80}
                autoComplete="off"
                placeholder={t("settings:ui.devices.pair.namePlaceholder")}
                value={pairName}
                disabled={busy}
                onChange={(event) => setPairName(event.target.value)}
              />
              <p className="form-hint full-row">
                {t("settings:ui.devices.pair.codeHint")}
              </p>
              <div className="pairing-buttons full-row">
                <button
                  className="btn primary"
                  disabled={busy || !payload.trim()}
                  onClick={() => void submitCode()}
                >
                  {t("settings:ui.devices.pair.redeem")}
                </button>
                <button className="btn" disabled={busy} onClick={props.onClose}>
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <div className="pair-device-form">
              <label htmlFor="pair-ssh-host">
                {t("settings:ui.devices.pair.hostname")}
              </label>
              <input
                id="pair-ssh-host"
                autoComplete="off"
                spellCheck={false}
                placeholder="192.168.1.10"
                value={hostname}
                disabled={busy}
                onChange={(event) => setHostname(event.target.value)}
              />
              <label htmlFor="pair-ssh-port">
                {t("settings:ui.devices.pair.port")}
              </label>
              <input
                id="pair-ssh-port"
                inputMode="numeric"
                autoComplete="off"
                value={port}
                disabled={busy}
                onChange={(event) => setPort(event.target.value)}
              />
              <label htmlFor="pair-ssh-user">
                {t("settings:ui.devices.pair.username")}
              </label>
              <input
                id="pair-ssh-user"
                autoComplete="off"
                spellCheck={false}
                value={username}
                disabled={busy}
                onChange={(event) => setUsername(event.target.value)}
              />
              <label htmlFor="pair-ssh-name">
                {t("settings:ui.devices.pair.nameLabel")}
              </label>
              <input
                id="pair-ssh-name"
                maxLength={80}
                autoComplete="off"
                placeholder={t("settings:ui.devices.pair.namePlaceholder")}
                value={sshName}
                disabled={busy}
                onChange={(event) => setSshName(event.target.value)}
              />
              <span>{t("settings:ui.devices.pair.authKind")}</span>
              <div className="pair-device-auth-kind" role="radiogroup">
                <label>
                  <input
                    type="radio"
                    name="pair-auth-kind"
                    checked={authKind === "password"}
                    disabled={busy}
                    onChange={() => setAuthKind("password")}
                  />
                  {t("settings:ui.devices.pair.authPassword")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="pair-auth-kind"
                    checked={authKind === "privateKey"}
                    disabled={busy}
                    onChange={() => setAuthKind("privateKey")}
                  />
                  {t("settings:ui.devices.pair.authPrivateKey")}
                </label>
              </div>
              {authKind === "password" ? (
                <>
                  <label htmlFor="pair-ssh-password">
                    {t("settings:ui.devices.pair.password")}
                  </label>
                  <input
                    id="pair-ssh-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    disabled={busy}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </>
              ) : (
                <>
                  <label htmlFor="pair-ssh-pem" className="full-row">
                    {t("settings:ui.devices.pair.privateKey")}
                  </label>
                  <textarea
                    id="pair-ssh-pem"
                    className="full-row"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={pem}
                    disabled={busy}
                    onChange={(event) => setPem(event.target.value)}
                  />
                  <label htmlFor="pair-ssh-passphrase">
                    {t("settings:ui.devices.pair.passphrase")}
                  </label>
                  <input
                    id="pair-ssh-passphrase"
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    disabled={busy}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                </>
              )}
              <p className="form-hint full-row">
                {t("settings:ui.devices.pair.sshHint")}
              </p>
              <div className="pairing-buttons full-row">
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void submitSsh()}
                >
                  {t("settings:ui.devices.pair.addSsh")}
                </button>
                <button className="btn" disabled={busy} onClick={props.onClose}>
                  {t("common:actions.cancel")}
                </button>
              </div>
            </div>
          )}
          {busy ? (
            <div className="pair-device-progress" role="status">
              {t("settings:ui.devices.pair.working")}
            </div>
          ) : null}
          {error ? (
            <p className="pair-device-error" role="alert">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
