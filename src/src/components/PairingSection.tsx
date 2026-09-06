import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import "./pairing.css";

interface Invitation { id: string; expiresAt: number }
interface Peer { name: string; relayUrl: string; publicKey: string; hostId: string }
interface Candidate { requestId: string; name: string; publicKey: string; verificationCode: string }
interface PairStatus { invitationId: string; expiresAt: number; phase: "waiting" | "pending" | "approved" | "denied" | "expired"; candidate?: Candidate | null }
interface Device { name: string; publicKey: string }
interface Status { phase: "unconfigured" | "connecting" | "connected" | "reconnecting" | "authentication_failed" | "storage_failed" | "stopped"; peer?: Peer | null; pairing?: PairStatus | null; devices: Device[]; activeChannels: number }
type Reply = { kind: "ok" } | { kind: "invitation"; invitation: Invitation };
const control = (request: Record<string, unknown>) => invoke<Reply>("desktop_relay_control", { request });
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function PairingSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("AgentPort");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [image, setImage] = useState("");
  const [revoke, setRevoke] = useState<Device>();
  const [stopConfirm, setStopConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const current = useRef<Invitation>();
  const alive = useRef(false);
  const operating = useRef(false);
  const hydrated = useRef(false);
  const epoch = useRef(0);
  const refresh = async () => {
    const version = ++epoch.current;
    const value = await invoke<Status | null>("desktop_relay_status");
    if (!alive.current || epoch.current !== version) return;
    setStatus(value);
    if (!hydrated.current && value?.peer) { setUrl(value.peer.relayUrl); setName(value.peer.name); hydrated.current = true; }
    const pair = value?.pairing;
    const remaining = Math.max(0, Math.ceil((pair?.expiresAt ?? 0) - Date.now() / 1000));
    setSeconds(remaining);
    if (!pair || pair.invitationId !== current.current?.id || pair.phase !== "waiting" || remaining <= 0) setImage("");
  };
  const close = async () => {
    const previous = current.current; current.current = undefined;
    if (alive.current) setImage("");
    if (previous) await control({ kind: "close_invitation", invitation_id: previous.id });
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (cause) { if (!disposed) setError(message(cause)); }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => {
      disposed = true; alive.current = false; epoch.current++; clearTimeout(timer);
      const previous = current.current; current.current = undefined;
      // Closing settings cancels only its invitation, never the background process.
      if (previous) void control({ kind: "close_invitation", invitation_id: previous.id }).catch(() => undefined);
    };
  }, []);
  const run = async (work: () => Promise<void>) => {
    if (operating.current) return;
    operating.current = true; epoch.current++; setBusy(true); setError("");
    try { await work(); }
    catch (cause) { if (alive.current) setError(message(cause)); }
    finally {
      // Even unknown mutation outcomes are refreshed, never automatically replayed.
      try { await refresh(); } catch { /* keep original error */ }
      operating.current = false; if (alive.current) setBusy(false);
    }
  };
  const configure = () => run(async () => {
    await close();
    await invoke("desktop_relay_start");
    if (!alive.current) return;
    const secret = token; setToken(""); hydrated.current = true;
    await control({ kind: "configure", relay_url: url.trim(), name: name.trim(), token: secret });
  });
  const generate = () => run(async () => {
    await close();
    const reply = await control({ kind: "invite_automatic" });
    if (reply.kind !== "invitation") throw new Error(t("settings:ui.pairing.invalidReply"));
    const value = reply.invitation; // Contains ephemeral QR secret; never persist/log.
    if (!alive.current) { await control({ kind: "close_invitation", invitation_id: value.id }); return; }
    current.current = { id: value.id, expiresAt: value.expiresAt };
    try {
      const data = await QRCode.toDataURL(JSON.stringify(value), { errorCorrectionLevel: "M", width: 360, margin: 4 });
      if (alive.current && current.current?.id === value.id) setImage(data);
    } catch (cause) { await close(); throw cause; }
  });
  const pair = status?.pairing;
  return <section className="pairing-section">
    <p>{t("settings:ui.pairing.description")}</p>
    <p className="form-hint">{t("settings:ui.pairing.requirements")}</p>
    <p role="status">{t(`settings:ui.pairing.background.${status?.phase ?? "stopped"}`)}</p>
    <div className="form-grid">
      <label htmlFor="pairing-url">{t("settings:ui.pairing.relayUrl")}</label>
      <div className="control"><input id="pairing-url" type="url" autoComplete="off" spellCheck={false} value={url} disabled={busy} onChange={event => { hydrated.current = true; setUrl(event.target.value); }} /></div>
      <label htmlFor="pairing-name">{t("settings:ui.pairing.computerName")}</label>
      <div className="control"><input id="pairing-name" maxLength={80} value={name} disabled={busy} onChange={event => { hydrated.current = true; setName(event.target.value); }} /></div>
      <label htmlFor="pairing-token">{t("settings:ui.pairing.registrationToken")}</label>
      <div className="control"><input id="pairing-token" type="password" autoComplete="new-password" value={token} disabled={busy} onChange={event => setToken(event.target.value)} aria-describedby="pairing-token-hint" /></div>
    </div>
    <p id="pairing-token-hint" className="form-hint">{t("settings:ui.pairing.tokenHint")}</p>
    <div className="pairing-buttons">
      <button className="btn" disabled={busy || !url.trim() || !name.trim() || token.length < 16} onClick={() => void configure()}>{t("settings:ui.pairing.configure")}</button>
      {!status || status.phase === "stopped" ? <button className="btn" disabled={busy} onClick={() => void run(async () => { await invoke("desktop_relay_start"); })}>{t("settings:ui.pairing.startBackground")}</button> : <button className="btn" disabled={busy} onClick={() => setStopConfirm(true)}>{t("settings:ui.pairing.stopBackground")}</button>}
      <button className="btn btn-primary" disabled={busy || status?.phase !== "connected" || url.trim() !== status.peer?.relayUrl || name.trim() !== status.peer?.name} onClick={() => void generate()}>{t("settings:ui.pairing.generate")}</button>
      {current.current ? <button className="btn" disabled={busy} onClick={() => void run(close)}>{t("settings:ui.pairing.close")}</button> : null}
    </div>
    {stopConfirm ? <div role="alert"><p>{t("settings:ui.pairing.stopConfirm")}</p><div className="pairing-buttons">
      <button className="btn" onClick={() => setStopConfirm(false)} disabled={busy}>{t("common:actions.cancel")}</button>
      <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { await close(); await control({ kind: "stop" }); if (alive.current) setStopConfirm(false); })}>{t("settings:ui.pairing.confirmStop")}</button>
    </div></div> : null}
    {image && seconds > 0 ? <img className="pairing-qr" src={image} alt={t("settings:ui.pairing.qrAlt")} /> : null}
    {pair ? <p role="status">{t(`settings:ui.pairing.states.${pair.phase}`)} · {t("settings:ui.pairing.expires", { seconds })}</p> : null}
    {pair?.candidate ? <div className="pairing-candidate">
      <strong>{pair.candidate.name}</strong><code className="pairing-fingerprint">{pair.candidate.publicKey}</code>
    </div> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <h3>{t("settings:ui.pairing.devices")}</h3><p className="form-hint">{t("settings:ui.pairing.revokeHint")}</p>
    {!status?.devices.length ? <p>{t("settings:ui.pairing.empty")}</p> : <ul className="pairing-devices">{status.devices.map(device => <li key={device.publicKey}>
      <strong>{device.name}</strong><code className="pairing-fingerprint">{device.publicKey}</code>
      {revoke?.publicKey === device.publicKey ? <><p>{t("settings:ui.pairing.revokeConfirm", { name: device.name })}</p><div className="pairing-buttons">
        <button className="btn" disabled={busy} onClick={() => setRevoke(undefined)}>{t("common:actions.cancel")}</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => { await control({ kind: "revoke", public_key: device.publicKey }); if (alive.current) setRevoke(undefined); })}>{t("settings:ui.pairing.revoke")}</button>
      </div></> : <button className="btn" disabled={busy} onClick={() => setRevoke(device)}>{t("settings:ui.pairing.revoke")}</button>}
    </li>)}</ul>}
  </section>;
}
