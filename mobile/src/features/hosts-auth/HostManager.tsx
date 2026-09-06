import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ConnectionState, HostProfileSummary, RemoteClient } from "../../protocol/remoteClient";
import type { HostAuthClient, HostProfileDraft } from "./types";

import { PairDevice } from "./PairDevice";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; hosts: HostProfileSummary[] }
  | { kind: "failed"; message: string };

interface HostManagerProps {
  remoteClient: RemoteClient;
  authClient: HostAuthClient;
}

interface TrustPrompt {
  connectProfileId: string;
  trustProfileId: string;
  hostName: string;
  fingerprint: string;
  hop: "direct" | "jump" | "target";
}

interface NativeConnectError {
  code?: string;
  message?: string;
  fingerprint?: string;
  hostKeyHop?: "direct" | "jump" | "target";
}

const blankProfile = (sortOrder: number): HostProfileDraft => ({
  name: "",
  hostname: "",
  port: 22,
  username: "",
  preferredTransport: "ssh",
  authentication: "password",
  credentialId: "",
  enabled: true,
  sortOrder,
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function HostManager({ remoteClient, authClient }: HostManagerProps) {
  const { t } = useTranslation();
  const [pairing, setPairing] = useState(false);
  const [paired, setPaired] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editing, setEditing] = useState<HostProfileDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HostProfileSummary | null>(null);
  const [deleteCredential, setDeleteCredential] = useState(false);
  const [deleteTrust, setDeleteTrust] = useState(true);
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [connectionStates, setConnectionStates] = useState<Map<string, ConnectionState>>(new Map());
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", hosts: await remoteClient.listHostProfiles() });
    } catch (error) {
      setState({ kind: "failed", message: errorMessage(error) });
    }
  }, [remoteClient]);

  useEffect(() => void load(), [load]);
  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => Promise<void>) | undefined;
    void remoteClient.onConnectionState((event) => {
      setConnectionStates((current) => new Map(current).set(event.profileId, event.state));
    }).then((value) => {
      if (disposed) void value();
      else unsubscribe = value;
    });
    return () => {
      disposed = true;
      if (unsubscribe) void unsubscribe();
    };
  }, [remoteClient]);

  const closeEditor = () => {
    setEditing(null);
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setFormError("");
  };

  const openNew = () => {
    const nextOrder = state.kind === "ready" ? state.hosts.length : 0;
    setEditing(blankProfile(nextOrder));
    setFormError("");
  };

  const openEdit = async (profileId: string) => {
    setBusy(true);
    setFormError("");
    try {
      setEditing(await authClient.getProfile(profileId));
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const patch = <K extends keyof HostProfileDraft>(key: K, value: HostProfileDraft[K]) => {
    setEditing((current) => current ? { ...current, [key]: value } : current);
  };

  const createCredential = async (kind: "password" | "import") => {
    setBusy(true);
    setFormError("");
    try {
      const result = kind === "password"
        ? await authClient.storePassword(password)
        : await authClient.importPrivateKey(privateKey, passphrase || undefined);
      patch("credentialId", result.credentialId);
      setPassword("");
      setPrivateKey("");
      setPassphrase("");
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing?.credentialId) {
      setFormError(t("hosts.form.credentialRequired"));
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await authClient.saveProfile(editing);
      closeEditor();
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (profileId: string) => {
    setBusy(true);
    setConnectingId(profileId);
    setFormError("");
    try {
      await remoteClient.connect(profileId);
      setConnectionStates((current) => new Map(current).set(profileId, "connected"));
    } catch (error) {
      const detail = error as NativeConnectError;
      if ((detail.code === "host_key_confirmation_required" || detail.code === "jump_host_key_confirmation_required") && detail.fingerprint) {
        const profile = await authClient.getProfile(profileId);
        const trustProfileId = detail.hostKeyHop === "jump" && profile.jump ? profile.jump.hostProfileId : profileId;
        setTrustPrompt({
          connectProfileId: profileId,
          trustProfileId,
          hostName: detail.hostKeyHop === "jump" ? t("hosts.jumpHost") : profile.name,
          fingerprint: detail.fingerprint,
          hop: detail.hostKeyHop ?? "direct",
        });
      } else {
        await remoteClient.disconnect(profileId).catch(() => undefined);
        setFormError(detail.message || errorMessage(error));
      }
    } finally {
      setConnectingId(null);
      setBusy(false);
    }
  };

  const cancelTrust = async () => {
    if (!trustPrompt) return;
    const profileId = trustPrompt.connectProfileId;
    setTrustPrompt(null);
    await remoteClient.disconnect(profileId).catch(() => undefined);
  };

  const confirmTrust = async () => {
    if (!trustPrompt) return;
    setBusy(true);
    try {
      await authClient.trustHostKey(trustPrompt.trustProfileId, trustPrompt.fingerprint);
      const profileId = trustPrompt.connectProfileId;
      setTrustPrompt(null);
      await connect(profileId);
    } catch (error) {
      setFormError(errorMessage(error));
      setBusy(false);
    }
  };

  const disconnect = async (profileId: string) => {
    setBusy(true);
    setConnectingId(null);
    try {
      await remoteClient.disconnect(profileId);
      setConnectionStates((current) => new Map(current).set(profileId, "disconnected"));
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const reconcileRelay = async () => {
    if (!editing?.id) return;
    setBusy(true); setFormError("");
    try { const verified = await authClient.reconcileRelayProfile(editing.id); setEditing(verified); setPaired(true); await load(); }
    catch (error) { setFormError(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setFormError("");
    try {
      await remoteClient.disconnect(deleteTarget.id);
      await authClient.deleteProfile(deleteTarget.id, deleteCredential, deleteTrust);
      setDeleteTarget(null);
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return <>
    {pairing ? <PairDevice onClose={() => { setPairing(false); void load(); }} onPaired={profileId => { setPairing(false); setPaired(true); void load(); void connect(profileId); }} /> : null}
    <section className="section-heading" aria-labelledby="hosts-title">
      <div>
        <h1 id="hosts-title">{t("hosts.title")}</h1>
        <p>{t("hosts.subtitle")}</p>
      </div>
      <div className="heading-actions">
        <button type="button" onClick={() => setPairing(true)}>{t("pairing.scan")}</button>
        <button className="primary-button" type="button" onClick={openNew}><span aria-hidden="true">＋</span>{t("hosts.add")}</button>
      </div>
    </section>

    {paired ? <p role="status">{t("pairing.paired")}</p> : null}
    {formError && !editing ? <div className="inline-error" role="alert">{formError}</div> : null}
    {state.kind === "loading" ? <div className="state-card" role="status">{t("hosts.loading")}</div> : null}
    {state.kind === "failed" ? <div className="state-card" role="alert">
      <span><strong>{t("hosts.failed")}</strong><small>{state.message}</small></span>
      <button type="button" onClick={() => void load()}>{t("common.retry")}</button>
    </div> : null}
    {state.kind === "ready" && state.hosts.length === 0 ? <div className="empty-card">
      <div className="empty-orbit" aria-hidden="true"><span /></div>
      <h2>{t("hosts.emptyTitle")}</h2><p>{t("hosts.emptyBody")}</p>
      <button className="primary-button wide" type="button" onClick={openNew}>{t("hosts.add")}</button>
    </div> : null}

    {state.kind === "ready" && state.hosts.length > 0 ? <ul className="host-list" aria-label={t("hosts.title")}>
      {state.hosts.map((host) => {
        const displayedState = connectionStates.get(host.id) ?? host.connectionState;
        const isConnected = displayedState === "connected";
        return <li key={host.id} className="host-row">
        <button type="button" className="host-card" disabled={isConnected || connectingId === host.id} onClick={() => void openEdit(host.id)}>
          <span className={`status-dot ${displayedState}`} aria-hidden="true" />
          <span className="host-copy"><strong>{host.name}</strong><span>{host.preferredTransport === "relay" ? host.hostname : `${host.username}@${host.hostname}:${host.port}`}</span></span>
          <span className="visually-hidden">{t(`status.${displayedState}`)}</span>
        </button>
        <div className="host-actions" aria-label={t("hosts.actions", { name: host.name })}>
          <button type="button" className="host-connection-action" data-connected={isConnected} disabled={busy && connectingId !== host.id}
            aria-label={connectingId === host.id ? t("hosts.cancelConnect") : isConnected ? t("hosts.disconnect") : t("hosts.connect")}
            title={connectingId === host.id ? t("hosts.cancelConnect") : isConnected ? t("hosts.disconnect") : t("hosts.connect")}
            onClick={() => isConnected || connectingId === host.id ? void disconnect(host.id) : void connect(host.id)}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{connectingId === host.id ? <path d="m7 7 10 10M17 7 7 17" /> : <><path d="M12 3v9" /><path d="M7 5.8a8 8 0 1 0 10 0" /></>}</svg>
          </button>
          <button className="danger-text" type="button" disabled={busy} aria-label={t("common.delete")} title={t("common.delete")} onClick={() => setDeleteTarget(host)}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></svg></button>
        </div>
      </li>;
      })}
    </ul> : null}

    {editing ? <div className="modal-backdrop">
      <section className="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="host-form-title">
        <form onSubmit={(event) => void save(event)}>
          <header><h2 id="host-form-title">{editing.id ? t("hosts.form.editTitle") : t("hosts.form.addTitle")}</h2><button type="button" onClick={closeEditor} aria-label={t("common.close")}>×</button></header>
          <div className="form-grid">
            <label>{t("hosts.form.name")}<input required maxLength={128} value={editing.name} onChange={(event) => patch("name", event.target.value)} /></label>
            {editing.relay ? <p className="fingerprint">{editing.relay.peer.relayUrl}<br />{editing.relay.peer.publicKey}</p> : <>
            <label>{t("hosts.form.hostname")}<input required maxLength={253} value={editing.hostname} onChange={(event) => patch("hostname", event.target.value)} /></label>
            <label>{t("hosts.form.port")}<input required type="number" min="1" max="65535" value={editing.port} onChange={(event) => patch("port", Number(event.target.value))} /></label>
            <label>{t("hosts.form.username")}<input required maxLength={128} value={editing.username} onChange={(event) => patch("username", event.target.value)} /></label>
            <label>{t("hosts.form.authentication")}<select value={editing.authentication} onChange={(event) => setEditing((current) => current ? { ...current, authentication: event.target.value as "password" | "private_key", credentialId: "" } : current)}><option value="password">{t("hosts.form.password")}</option><option value="private_key">{t("hosts.form.privateKey")}</option></select></label>
            </>}
          </div>
          {editing.relay ? <div><p>{t(editing.relay.approved ? "pairing.relayManaged" : "pairing.retained")}</p>
            {!editing.relay.approved && editing.credentialId ? <button type="button" disabled={busy} onClick={() => void reconcileRelay()}>{t("pairing.reconcile")}</button> : null}
          </div> : <fieldset className="credential-panel"><legend>{t("hosts.form.credential")}</legend>
            {editing.credentialId ? <p className="credential-ready">{t("hosts.form.credentialReady")}</p> : null}
            {editing.authentication === "password" ? <label>{t("hosts.form.password")}<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><button type="button" disabled={busy || !password} onClick={() => void createCredential("password")}>{t("hosts.form.storePassword")}</button></label> : <>
              <label>{t("hosts.form.privateKey")}<textarea rows={5} value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} /></label>
              <label>{t("hosts.form.passphrase")}<input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
              <div className="button-row"><button type="button" disabled={busy || !privateKey} onClick={() => void createCredential("import")}>{t("hosts.form.importKey")}</button></div>
            </>}
          </fieldset>}
          {formError ? <p className="inline-error" role="alert">{formError}</p> : null}
          <div className="modal-actions"><button type="button" onClick={closeEditor}>{t("common.cancel")}</button><button className="primary-button" type="submit" disabled={busy}>{busy ? t("common.saving") : t("common.save")}</button></div>
        </form>
      </section>
    </div> : null}

    {trustPrompt ? <div className="modal-backdrop"><section className="modal-sheet compact" role="alertdialog" aria-modal="true" aria-labelledby="trust-host-title">
      <h2 id="trust-host-title">{t("hosts.trustTitle", { name: trustPrompt.hostName })}</h2>
      <p>{t("hosts.trustBody", { hop: t(`hosts.hop.${trustPrompt.hop}`) })}</p>
      <code className="fingerprint">{trustPrompt.fingerprint}</code>
      <div className="modal-actions"><button type="button" onClick={() => void cancelTrust()}>{t("common.cancel")}</button><button className="primary-button" type="button" disabled={busy} onClick={() => void confirmTrust()}>{t("hosts.trustConfirm")}</button></div>
    </section></div> : null}

    {deleteTarget ? <div className="modal-backdrop"><section className="modal-sheet compact" role="dialog" aria-modal="true" aria-labelledby="delete-host-title">
      <h2 id="delete-host-title">{t("hosts.deleteTitle", { name: deleteTarget.name })}</h2>
      <p>{t(deleteTarget.preferredTransport === "relay" ? "pairing.deleteRelay" : "hosts.deleteBody")}</p>
      <label className="check-row"><input type="checkbox" checked={deleteCredential} onChange={(event) => setDeleteCredential(event.target.checked)} />{t("hosts.deleteCredential")}</label>
      {deleteTarget.preferredTransport !== "relay" ? <label className="check-row"><input type="checkbox" checked={deleteTrust} onChange={(event) => setDeleteTrust(event.target.checked)} />{t("hosts.deleteTrust")}</label> : null}
      {formError ? <p className="inline-error" role="alert">{formError}</p> : null}
      <div className="modal-actions"><button type="button" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</button><button className="danger-button" type="button" disabled={busy} onClick={() => void remove()}>{t("common.delete")}</button></div>
    </section></div> : null}
  </>;
}
