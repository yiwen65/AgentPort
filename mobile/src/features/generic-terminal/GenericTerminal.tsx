import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import type { HostAuthClient } from "../hosts-auth/types";
import type { HostProfileSummary } from "../../protocol/remoteClient";
import type { GenericTerminalClient, GenericTerminalError, TerminalRecord, TerminalTransport } from "../../protocol/genericTerminalClient";
import { MobileTerminal, type MobileTerminalHandle } from "../../terminal/MobileTerminal";
import { useMobileTerminalAppearance } from "../../terminal/terminalAppearance";
import { getMobileTerminalFontFamily, getMobileTerminalPalette, getMobileTerminalWorkspaceVariables } from "../../terminal/terminalThemes";
import { Modal } from "../../components/Modal";
import "./generic-terminal.css";

type Props = { host: HostProfileSummary; client: GenericTerminalClient; authClient: HostAuthClient; onBack: () => void };
type Trust = { profileId: string; fingerprint: string; hop: string; retry: () => void };
type Failure = { detail: GenericTerminalError };
function detailOf(error: unknown): GenericTerminalError {
  return error && typeof error === "object" ? error as GenericTerminalError : { message: String(error) };
}

export function GenericTerminal({ host, client, authClient, onBack }: Props) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<TerminalRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const listEpoch = useRef(0);
  const reportEpoch = useRef(0);
  const connectionGate = useRef<Promise<void>>(Promise.resolve());
  const pageRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const fitViewport = () => {
      pageRef.current?.style.setProperty("height", `${Math.round(viewport?.height ?? window.innerHeight)}px`);
      pageRef.current?.style.setProperty("top", `${Math.round(viewport?.offsetTop ?? 0)}px`);
    };
    fitViewport();
    viewport?.addEventListener("resize", fitViewport);
    viewport?.addEventListener("scroll", fitViewport);
    window.addEventListener("resize", fitViewport);
    return () => { viewport?.removeEventListener("resize", fitViewport); viewport?.removeEventListener("scroll", fitViewport); window.removeEventListener("resize", fitViewport); };
  }, []);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<TerminalTransport>("ssh");
  const [selected, setSelected] = useState<TerminalRecord>();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure>();
  const [trust, setTrust] = useState<Trust>();
  const [endTarget, setEndTarget] = useState<TerminalRecord>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; listEpoch.current++; }; }, []);
  const report = useCallback(async (error: unknown, retry: () => void) => {
    const epoch = ++reportEpoch.current;
    const detail = detailOf(error);
    if (!alive.current) return;
    setFailure({ detail });
    if ((detail.code === "host_key_confirmation_required" || detail.code === "jump_host_key_confirmation_required") && detail.fingerprint) {
      try {
        const profile = await authClient.getProfile(host.id);
        if (!alive.current || epoch !== reportEpoch.current) return;
        const profileId = detail.hostKeyHop === "jump" ? profile.jump?.hostProfileId : host.id;
        if (profileId) setTrust({ profileId, fingerprint: detail.fingerprint, hop: detail.hostKeyHop ?? "direct", retry });
      } catch (error) { if (alive.current) setFailure({ detail: detailOf(error) }); }
    }
  }, [authClient, host.id]);
  const load = useCallback(async () => {
    const epoch = ++listEpoch.current;
    try {
      const next = await client.list(host.id);
      if (alive.current && epoch === listEpoch.current) { setRecords(next); setLoaded(true); }
    } catch (error) { if (alive.current && epoch === listEpoch.current) { setLoaded(false); setFailure({ detail: detailOf(error) }); } }
  }, [client, host.id]);
  useEffect(() => { void load(); }, [load]);
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setFailure(undefined);
    try { await operation(); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const create = () => void run(async () => {
    try {
      const record = await client.create({ profileId: host.id, name: name.trim() });
      if (!alive.current) return;
      setRecords(previous => [...previous.filter(item => item.id !== record.id), record]);
      setName(""); setSelected(record); setAttempt(value => value + 1);
    } catch (error) {
      await report(error, create);
      // Native persists creation intent before remote launch. Recover the record,
      // not a second create, after an ambiguous timeout or lost acknowledgement.
      await load();
    }
  });
  const end = () => void run(async () => {
    if (!endTarget) return;
    try {
      await client.end(endTarget.id);
      if (!alive.current) return;
      setRecords(previous => previous.filter(item => item.id !== endTarget.id)); setEndTarget(undefined);
    } catch (error) { await report(error, end); }
  });
  const confirmTrust = () => {
    let retry: (() => void) | undefined;
    void run(async () => {
      if (!trust) return;
      const epoch = reportEpoch.current;
      try {
        await authClient.trustHostKey(trust.profileId, trust.fingerprint);
        if (!alive.current || epoch !== reportEpoch.current) return;
        setTrust(undefined); setFailure(undefined); retry = trust.retry;
      } catch (error) { if (alive.current) setFailure({ detail: detailOf(error) }); }
    }).then(() => retry?.());
  };
  const errorText = failure ? t(`genericTerminal.errors.${failure.detail.code}`, { defaultValue: failure.detail.message || t("genericTerminal.failed") }) : "";
  return <section ref={pageRef} className={`generic-terminal-page${selected ? " is-attached" : ""}`} aria-label={t("genericTerminal.title")}>
    <header className="generic-terminal-header">
      <button className={selected ? "generic-terminal-close" : "generic-terminal-back"} type="button" onClick={() => selected ? (reportEpoch.current++, setSelected(undefined), setFailure(undefined), setTrust(undefined), void load()) : onBack()}>{t(selected ? "genericTerminal.detach" : "genericTerminal.back")}</button>
      <div><h1>{selected?.name || t("genericTerminal.title")}</h1><small>{host.name} · {selected ? transport.toUpperCase() : "SSH / Mosh · tmux"}</small></div>
      {selected && transport === "mosh" ? <button className="generic-terminal-switch-ssh generic-terminal-fallback" type="button" onClick={() => { reportEpoch.current++; setFailure(undefined); setTrust(undefined); setTransport("ssh"); setAttempt(value => value + 1); }}>{t("genericTerminal.useSsh")}</button> : null}
    </header>
    {!selected ? <div className="generic-terminal-content">
      <p>{t("genericTerminal.explanation")}</p>
      <label>{t("genericTerminal.transport")}<select className="generic-terminal-transport" value={transport} disabled={busy} onChange={event => setTransport(event.target.value as TerminalTransport)}><option value="ssh">SSH</option><option value="mosh">Mosh</option></select></label>
      {!loaded && !failure ? <p role="status">{t("genericTerminal.loading")}</p> : null}
      {loaded && records.length === 0 ? <p role="status">{t("genericTerminal.empty")}</p> : null}
      <ul className="generic-terminal-records generic-terminal-list" aria-label={t("genericTerminal.records")}>
        {records.map(record => <li key={record.id} data-terminal-id={record.id}><div><strong>{record.name}</strong><small>{record.tmuxSession}</small></div><button type="button" disabled={busy} onClick={() => { reportEpoch.current++; setFailure(undefined); setSelected(record); setAttempt(value => value + 1); }}>{t("genericTerminal.attach")}</button><button type="button" disabled={busy} className="danger-text generic-terminal-end" onClick={() => setEndTarget(record)}>{t("genericTerminal.end")}</button></li>)}
      </ul>
      <form className="generic-terminal-create" onSubmit={(event: FormEvent) => { event.preventDefault(); create(); }}>
        <label>{t("genericTerminal.name")}<input required maxLength={128} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <button className="primary-button" disabled={busy || !name.trim() || !loaded} type="submit">{t("genericTerminal.create")}</button>
      </form>
      <button type="button" disabled={busy} onClick={() => { setFailure(undefined); void load(); }}>{t("genericTerminal.refresh")}</button>
      {busy ? <p role="status">{t("genericTerminal.pending")}</p> : null}
    </div> : <TerminalConnection key={selected.id} record={selected} client={client} transport={transport} attempt={attempt} cleanupGate={connectionGate}
      onFailure={(error) => void report(error, () => setAttempt(value => value + 1))} />}
    {failure ? <div className="generic-terminal-error" role="alert"><p>{errorText}</p>{selected && !trust ? <button className="generic-terminal-reconnect" type="button" onClick={() => { reportEpoch.current++; setFailure(undefined); setAttempt(value => value + 1); }}>{t("genericTerminal.reconnect")}</button> : null}</div> : null}
    {trust ? <Modal className="generic-terminal-modal" title={t("hosts.trustTitle", { name: host.name })} onClose={() => { reportEpoch.current++; setTrust(undefined); }}>
      <p>{t("hosts.trustBody", { hop: t(`hosts.hop.${trust.hop}`) })}</p><code className="fingerprint">{trust.fingerprint}</code>
      <div className="modal-actions"><button type="button" disabled={busy} onClick={() => { reportEpoch.current++; setTrust(undefined); }}>{t("common.cancel")}</button><button type="button" disabled={busy} onClick={confirmTrust}>{t("hosts.trustConfirm")}</button></div>
    </Modal> : null}
    {endTarget && !trust ? <Modal className="generic-terminal-modal" title={t("genericTerminal.endTitle", { name: endTarget.name })} onClose={() => setEndTarget(undefined)}>
      <p>{t("genericTerminal.endBody")}</p>
      <div className="modal-actions"><button type="button" disabled={busy} onClick={() => setEndTarget(undefined)}>{t("common.cancel")}</button><button className="danger-button" type="button" disabled={busy} onClick={end}>{t("genericTerminal.endConfirm")}</button></div>
    </Modal> : null}
  </section>;
}

function TerminalConnection({ record, client, transport, attempt, onFailure, cleanupGate }: {
  record: TerminalRecord; client: GenericTerminalClient; transport: TerminalTransport; attempt: number; onFailure: (error: unknown) => void;
  cleanupGate: MutableRefObject<Promise<void>>;
}) {
  const { t } = useTranslation();
  const terminal = useRef<MobileTerminalHandle>(null);
  const geometry = useRef({ cols: 80, rows: 24 });
  const connection = useRef<{ id: string; active: boolean; writes: Promise<void>; detach: () => Promise<void> }>();
  const failureRef = useRef(onFailure); failureRef.current = onFailure;
  const [status, setStatus] = useState<"connecting" | "ready" | "offline">("connecting");
  const [appearance, , mode] = useMobileTerminalAppearance();
  useEffect(() => {
    let stopped = false;
    let attached: typeof connection.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setStatus("connecting"); terminal.current?.reset();
    let detached: Promise<void> | undefined;
    const disconnect = (id: string) => detached ??= client.disconnect(id).catch(() => undefined);
    const fail = (error: unknown) => {
      if (stopped) return;
      if (attached) { attached.active = false; connection.current = undefined; void attached.detach(); attached = undefined; }
      setStatus("offline"); failureRef.current(error);
    };
    const poll = async () => {
      if (stopped || !attached?.active) return;
      try {
        const frame = await client.poll(attached.id);
        if (stopped || !attached?.active) return;
        if (frame.data.length) terminal.current?.write(new Uint8Array(frame.data));
        if (!frame.running) { fail({ code: "connection_closed" }); return; }
        timer = setTimeout(() => { void poll(); }, frame.data.length ? 0 : 40);
      } catch (error) { fail(error); }
    };
    // Serialize detach and the next attach, including a connection that resolves
    // after its UI was closed. Never have two live native attachments for this view.
    const connecting = cleanupGate.current.then(() => stopped ? undefined : client.connect({ terminalId: record.id, transport, ...geometry.current }));
    void connecting.then(result => {
      if (stopped || !result) return;
      attached = { id: result.connectionId, active: true, writes: Promise.resolve(), detach: () => disconnect(result.connectionId) }; connection.current = attached;
      setStatus("ready");
      // Fit may have changed while native was connecting.
      attached.writes = client.resize({ connectionId: attached.id, ...geometry.current }).catch(fail);
      void poll();
    }).catch(fail);
    return () => {
      stopped = true; if (timer) clearTimeout(timer);
      if (attached) { attached.active = false; if (connection.current === attached) connection.current = undefined; }
      cleanupGate.current = connecting.then(result => result ? disconnect(result.connectionId) : undefined).catch(() => undefined);
    };
  }, [client, record.id, transport, attempt, cleanupGate]);
  const enqueue = (operation: (id: string) => Promise<void>) => {
    const current = connection.current;
    if (!current?.active) return;
    current.writes = current.writes.then(async () => {
      if (current.active) await operation(current.id);
    }).catch(error => {
      if (!current.active) return;
      current.active = false; connection.current = undefined; setStatus("offline"); failureRef.current(error);
      void current.detach();
    });
  };
  return <div className="generic-terminal-workspace" style={getMobileTerminalWorkspaceVariables(appearance.theme, mode)}>
    <p className="generic-terminal-status" role="status">{t(`genericTerminal.${status}`)}</p>
    <div className="generic-terminal-surface" aria-busy={status === "connecting"} {...(status !== "ready" ? { inert: "" } : {})}>
      <MobileTerminal ref={terminal} title={record.name} showHeading={false} showProbeOutput={false} theme={getMobileTerminalPalette(appearance.theme, mode).xterm}
        fontFamily={getMobileTerminalFontFamily(appearance.font)} fontSize={15} resizeEpoch={`${transport}:${attempt}:${status}`}
        onInput={data => enqueue(id => client.input({ connectionId: id, data }))}
        onResize={(cols, rows) => { geometry.current = { cols, rows }; enqueue(id => client.resize({ connectionId: id, cols, rows })); }} />
    </div>
  </div>;
}

/** Standalone entry for hosts without a running AgentPort Bridge. */
export function GenericTerminalWorkspace({ profileId, hostName, client, authClient, onClose }: {
  profileId: string; hostName: string; client: GenericTerminalClient; authClient: HostAuthClient; onClose: () => void;
}) {
  return <GenericTerminal host={{ id: profileId, name: hostName, hostname: "", username: "", port: 22,
    preferredTransport: "ssh", connectionState: "disconnected", lastConnectedAt: null, lastError: null }}
    client={client} authClient={authClient} onBack={onClose} />;
}
