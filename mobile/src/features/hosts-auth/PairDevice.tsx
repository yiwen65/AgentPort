import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancel, checkPermissions, Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { Modal } from "../../components/Modal";
import { pairViaRelay, pairingClient, type PairingClient, type PairingPreview } from "./pairingClient";

function pairingError(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") return cause.message;
  return String(cause);
}

export function PairDevice({ onClose, onPaired, client = pairingClient }: {
  onClose: () => void; onPaired: (profileId: string) => void; client?: PairingClient;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<PairingPreview>();
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
      if (!lifetime.current?.signal.aborted) {
        const parsed = await client.preview(result.content);
        if (lifetime.current?.signal.aborted) return;
        setPreview(parsed);
        await completePairing(result.content, name.trim() || (/iPhone|iPad|iPod/.test(navigator.userAgent) ? "iPhone / iPad" : "Mobile device"));
      }
    } catch (cause) {
      if (!lifetime.current?.signal.aborted) { setError(pairingError(cause)); setPhase("idle"); }
    } finally { scanning.current = false; active.current = false; }
  };
  const completePairing = async (value: string, deviceName: string) => {
    const signal = lifetime.current!.signal;
    setError(""); setPhase("preparing");
    try {
      const profileId = await pairViaRelay(value, deviceName, client, signal, () => {
        setPhase("pending"); setCode("");
      });
      if (!signal.aborted) { setCode(""); onPaired(profileId); }

    } catch (cause) {
      if (!signal.aborted) { setCode(""); setPhase("failed"); setError(pairingError(cause)); }
    }
  };
  const begin = async () => {
    if (active.current || !preview || !name.trim()) return;
    active.current = true;
    try { await completePairing(code, name.trim()); }
    finally { active.current = false; }
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
      {preview ? <><p className="fingerprint">{preview.peer.name}<br />{preview.peer.relayUrl}<br />{preview.peer.publicKey}</p>
        <label>{t("pairing.deviceName")}<input maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label>
        <button type="button" className="primary-button wide" disabled={!name.trim()} onClick={() => void begin()}>{t("pairing.request")}</button></> : null}
    </> : null}
    {busy ? <p role="status">{t(`pairing.${phase}`)}</p> : null}
    {phase === "scanning" ? <button type="button" onClick={() => void cancel().catch(cause => setError(pairingError(cause)))}>{t("common.cancel")}</button> : null}
    {error ? <p role="alert" className="inline-error">{error}</p> : null}
    {phase === "failed" ? <p>{t("pairing.retained")}</p> : null}
    {phase === "failed" ? <button type="button" onClick={() => { setPreview(undefined); setError(""); setPhase("idle"); }}>{t("pairing.scanAgain")}</button> : null}
  </Modal>;
}
