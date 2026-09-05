import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancel, checkPermissions, Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { Modal } from "../../components/Modal";
import { finishPairing, pairingClient, preparePairing, type PairingClient, type PairingPreview } from "./pairingClient";
import type { HostAuthClient } from "./types";

function pairingError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  return String(cause);
}

export function PairDevice({ auth, onClose, onPaired, client = pairingClient }: {
  auth: HostAuthClient; onClose: () => void; onPaired: (profileId: string) => void; client?: PairingClient;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<PairingPreview>();
  const [verification, setVerification] = useState("");
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const lifetime = useRef<AbortController>();
  const active = useRef(false);
  const scanning = useRef(false);
  const busy = phase === "scanning" || phase === "preparing" || phase === "pending" || phase === "finishing";
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); if (scanning.current) void cancel().catch(() => undefined); };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("pairing-camera-active", phase === "scanning");
    return () => document.documentElement.classList.remove("pairing-camera-active");
  }, [phase]);
  const readCode = async (value: string) => {
    const parsed = await client.preview(value);
    if (lifetime.current?.signal.aborted) return;
    setCode(value); setPreview(parsed); setPhase("ready");
  };
  const scanCode = async () => {
    if (active.current) return;
    active.current = true; setError(""); setPhase("scanning");
    try {
      let permission = await checkPermissions();
      if (permission === "prompt") permission = await requestPermissions();
      if (permission !== "granted") throw new Error(t("pairing.cameraDenied"));
      if (lifetime.current?.signal.aborted) return;
      scanning.current = true;
      const result = await scan({ cameraDirection: "back", formats: [Format.QRCode], windowed: true });
      if (!lifetime.current?.signal.aborted) await readCode(result.content);
    } catch (cause) {
      if (!lifetime.current?.signal.aborted) { setError(pairingError(cause)); setPhase("idle"); }
    } finally { scanning.current = false; active.current = false; }
  };
  const begin = async () => {
    if (active.current || !preview || !name.trim()) return;
    const signal = lifetime.current!.signal;
    active.current = true; setError(""); setPhase("preparing");
    try {
      const attempt = await preparePairing(code, name.trim(), auth, client, signal);
      setVerification(attempt.prepared.verificationCode); setPhase("pending");
      while (!signal.aborted && Date.now() < attempt.preview.expiresAt * 1000) {
        // The same request/key polls idempotently; no second credential on retry.
        let reply;
        try { reply = await client.exchange(code, attempt.prepared.request); }
        catch (cause) { if (!signal.aborted) setError(pairingError(cause)); }
        signal.throwIfAborted();
        if (reply?.state === "approved") {
          setPhase("finishing");
          const profile = await finishPairing(reply, attempt, auth, signal);
          setCode("");
          if (!signal.aborted) onPaired(profile.id);
          return;
        }
        if (reply?.state === "denied" || reply?.state === "busy") throw new Error(t(`pairing.${reply.state}`));
        if (reply) setError("");
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error(t("pairing.expired"));
    } catch (cause) {
      if (!signal.aborted) { setCode(""); setPhase("failed"); setError(pairingError(cause)); }
    } finally { active.current = false; }
  };
  return <Modal title={t("pairing.title")} onClose={onClose} className="pair-device-modal">
    {phase !== "scanning" ? <><p>{t("pairing.instructions")}</p>
    <p className="form-hint">{t("pairing.requirements")}</p></> : null}
    {phase === "idle" || phase === "ready" ? <>
      <button type="button" className="primary-button wide" onClick={() => void scanCode()}>{t("pairing.scan")}</button>
      <details><summary>{t("pairing.manual")}</summary>
        <label>{t("pairing.code")}<textarea rows={3} autoComplete="off" spellCheck={false} value={code} onChange={event => { setCode(event.target.value); setPreview(undefined); setPhase("idle"); }} /></label>
        <button type="button" disabled={!code} onClick={() => { setError(""); void readCode(code).catch(cause => setError(pairingError(cause))); }}>{t("pairing.validate")}</button>
      </details>
      {preview ? <><p className="fingerprint">{preview.ssh.username}@{preview.ssh.hostname}:{preview.ssh.port}<br />{preview.ssh.fingerprint}</p>
        <label>{t("pairing.deviceName")}<input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <button type="button" className="primary-button wide" disabled={!name.trim()} onClick={() => void begin()}>{t("pairing.request")}</button></> : null}
    </> : null}
    {busy ? <p role="status">{t(`pairing.${phase}`)}</p> : null}
    {phase === "scanning" ? <button type="button" onClick={() => void cancel().catch(cause => setError(pairingError(cause)))}>{t("common.cancel")}</button> : null}
    {verification ? <><strong className="pairing-verification">{verification}</strong><p>{t("pairing.compare")}</p></> : null}
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {phase === "failed" || verification ? <p>{t("pairing.retained")}</p> : null}
  </Modal>;
}
