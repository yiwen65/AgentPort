import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import "./pairing.css";

interface Invitation { id: string; expiresAt: number }
interface Candidate { requestId: string; deviceName: string; fingerprint: string; verificationCode: string }
interface Status { id: string; state: "waiting" | "pending" | "approved" | "denied" | "expired" | "closed"; candidate?: Candidate }
interface Device { id: string; name: string; fingerprint: string }

export function PairingSection() {
  const { t } = useTranslation(["settings", "common"]);
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [invitation, setInvitation] = useState<Invitation>();
  const [image, setImage] = useState("");
  const [status, setStatus] = useState<Status>();
  const [devices, setDevices] = useState<Device[]>([]);
  const [revoke, setRevoke] = useState<Device>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const current = useRef<Invitation>();
  const alive = useRef(false);
  const operating = useRef(false);
  const close = async () => {
    const previous = current.current; current.current = undefined;
    setInvitation(undefined); setImage(""); setStatus(undefined);
    if (previous) await invoke("desktop_pairing_close", { invitationId: previous.id });
  };
  useEffect(() => {
    alive.current = true;
    let disposed = false;
    void Promise.all([
      invoke<{ address: string; username: string }>("desktop_pairing_defaults"),
      invoke<Device[]>("desktop_pairing_devices"),
    ]).then(([defaults, values]) => {
      if (disposed) return;
      setAddress(defaults.address); setUsername(defaults.username); setDevices(values);
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => {
      disposed = true; alive.current = false;
      const previous = current.current; current.current = undefined;
      if (previous) void invoke("desktop_pairing_close", { invitationId: previous.id }).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (!invitation) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      setSeconds(Math.max(0, Math.ceil(invitation.expiresAt - Date.now() / 1000)));
      try {
        const value = await invoke<Status | null>("desktop_pairing_status");
        if (disposed) return;
        if (value?.id === invitation.id) {
          setStatus(value);
          if (value.state !== "waiting" && value.state !== "pending") setImage("");
          if (value.state === "approved") setDevices(await invoke<Device[]>("desktop_pairing_devices"));
        }
      } catch (cause) { if (!disposed) setError(String(cause)); }
      if (!disposed) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [invitation]);
  const run = async (work: () => Promise<void>) => {
    if (operating.current) return;
    operating.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) {
      if (alive.current) {
        setError(String(cause));
        // A filesystem durability failure can follow an authorization write.
        // Refresh marked keys so the user can see/revoke an uncertain result.
        try { const values = await invoke<Device[]>("desktop_pairing_devices"); if (alive.current) setDevices(values); } catch { /* retain original failure */ }
      }
    }
    finally { operating.current = false; if (alive.current) setBusy(false); }
  };
  const start = () => run(async () => {
    await close();
    const value = await invoke<Invitation>("desktop_pairing_start", { address: address.trim(), username });
    // The native value also includes the secret. Never persist or log it.
    if (!alive.current) { await invoke("desktop_pairing_close", { invitationId: value.id }); return; }
    const handle = { id: value.id, expiresAt: value.expiresAt };
    current.current = handle;
    try {
      const data = await QRCode.toDataURL(JSON.stringify(value), { errorCorrectionLevel: "M", width: 360, margin: 4 });
      if (!alive.current || current.current?.id !== value.id) return;
      setImage(data); setInvitation(handle);
    } catch (cause) { await close(); throw cause; }
  });
  const decide = (approve: boolean) => run(async () => {
    if (!invitation || !status?.candidate) return;
    await invoke("desktop_pairing_decide", { invitationId: invitation.id, requestId: status.candidate.requestId, approve });
    const value = await invoke<Status>("desktop_pairing_status");
    if (!alive.current) return;
    setStatus(value); setImage(""); setDevices(await invoke<Device[]>("desktop_pairing_devices"));
  });
  return <section className="pairing-section">
    <p>{t("settings:ui.pairing.description")}</p>
    <p className="form-hint">{t("settings:ui.pairing.requirements")}</p>
    <div className="form-grid">
      <label htmlFor="pairing-address">{t("settings:ui.pairing.address")}</label>
      <div className="control"><input id="pairing-address" value={address} disabled={Boolean(invitation) || busy} onChange={event => setAddress(event.target.value)} /></div>
      <label>{t("settings:ui.pairing.username")}</label><div className="control"><code>{username}</code></div>
    </div>
    <div className="pairing-buttons"><button className="btn btn-primary" disabled={busy || !address || !username} onClick={() => void start()}>{t("settings:ui.pairing.generate")}</button>
      {invitation ? <button className="btn" disabled={busy} onClick={() => void run(close)}>{t("settings:ui.pairing.close")}</button> : null}</div>
    {image && seconds > 0 ? <img className="pairing-qr" src={image} alt={t("settings:ui.pairing.qrAlt")} /> : null}
    {invitation ? <p role="status">{t(`settings:ui.pairing.states.${status?.state ?? "waiting"}`)} · {t("settings:ui.pairing.expires", { seconds })}</p> : null}
    {status?.candidate ? <div className="pairing-candidate">
      <strong>{status.candidate.deviceName}</strong>
      <code className="pairing-fingerprint">{status.candidate.fingerprint}</code>
      <strong className="pairing-verification">{status.candidate.verificationCode}</strong>
      {status.state === "pending" ? <><p>{t("settings:ui.pairing.compare")}</p><div className="pairing-buttons">
        <button className="btn" disabled={busy || seconds <= 0} onClick={() => void decide(false)}>{t("settings:ui.pairing.deny")}</button>
        <button className="btn btn-primary" disabled={busy || seconds <= 0} onClick={() => void decide(true)}>{t("settings:ui.pairing.approve")}</button>
      </div></> : null}
    </div> : null}
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    <h3>{t("settings:ui.pairing.devices")}</h3>
    <p className="form-hint">{t("settings:ui.pairing.revokeHint")}</p>
    {devices.length === 0 ? <p>{t("settings:ui.pairing.empty")}</p> : <ul className="pairing-devices">{devices.map(device => <li key={device.id}>
      <strong>{device.name}</strong><code className="pairing-fingerprint">{device.fingerprint}</code>
      {revoke?.id === device.id ? <><p>{t("settings:ui.pairing.revokeConfirm", { name: device.name })}</p><div className="pairing-buttons"><button className="btn" disabled={busy} onClick={() => setRevoke(undefined)}>{t("common:actions.cancel")}</button><button className="btn btn-danger" disabled={busy} onClick={() => void run(async () => {
        await invoke("desktop_pairing_revoke", { id: device.id, fingerprint: device.fingerprint });
        if (alive.current) { setRevoke(undefined); setDevices(await invoke<Device[]>("desktop_pairing_devices")); }
      })}>{t("settings:ui.pairing.revoke")}</button></div></> : <button className="btn" disabled={busy} onClick={() => setRevoke(device)}>{t("settings:ui.pairing.revoke")}</button>}
    </li>)}</ul>}
  </section>;
}
