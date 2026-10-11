import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import type { HostProfileSummary, RemoteClient, Unsubscribe } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import type { ProjectSummary } from "../sessions/types";
import {
  beginPendingProjectAdd, clearPendingProjectAdd, observePendingProjectAdd,
  readPendingProjectAdd, updatePendingProjectAdd,
  type AddedProjectResult, type PendingProjectAdd,
} from "./pendingProjectAdd";
import "./add-project-dialog.css";

export type { AddedProjectResult } from "./pendingProjectAdd";
export interface AddProjectDialogProps {
  client: RemoteClient;
  host: HostProfileSummary;
  onClose: () => void;
  onAdded: (result: AddedProjectResult) => Promise<void>;
}
interface DirectoryListing {
  path: string;
  homePath: string;
  parentPath: string | null;
  entries: { name: string; path: string }[];
  truncated: boolean;
}
type Phase = "idle" | "validating" | "submitting" | "checking" | "added" | "refreshFailed";
const pathErrors = new Set(["path_not_found", "not_directory", "permission_denied", "invalid_path", "directory_read_failed"]);
const codeOf = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const unsupported = (error: unknown) => ["unknown_method", "capability_disabled"].includes(codeOf(error));
const knownFailed = (error: unknown) => error && typeof error === "object" && "status" in error
  && (error.status === "failed" || error.status === "not_executed");
export function isAbsoluteProjectPath(path: string): boolean {
  return !/[\u0000-\u001f]/.test(path) && (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path));
}

/** A host change is a new lifetime; no old response can call the new host's callback. */
export function AddProjectDialog(props: AddProjectDialogProps) {
  return <HostAddProjectDialog key={props.host.id} {...props} />;
}

function HostAddProjectDialog({ client, host, onClose, onAdded }: AddProjectDialogProps) {
  const { t } = useTranslation();
  const id = useId();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<DirectoryListing>();
  const [showHidden, setShowHidden] = useState(false);
  const [manualOnly, setManualOnly] = useState(false);
  const [online, setOnline] = useState(host.connectionState === "connected");
  const [browsing, setBrowsing] = useState(false);
  const [candidate, setCandidate] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<PendingProjectAdd | null>(null);
  const [error, setError] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(false);
  const generation = useRef(0);
  const active = useRef(false);
  const checking = useRef(false);
  const refreshing = useRef(false);
  const delivered = useRef<string>();
  const pathRef = useRef(path);
  const hiddenRef = useRef(showHidden);
  const onlineRef = useRef(online);
  const manualRef = useRef(false);
  const resolveUnsupported = useRef(false);
  const callback = useRef(onAdded);
  const closeCallback = useRef(onClose);
  callback.current = onAdded;
  closeCallback.current = onClose;
  const errorText = (cause: unknown) => pathErrors.has(codeOf(cause))
    ? t(`project.errors.${codeOf(cause)}`) : t("project.requestFailed", { error: remoteErrorMessage(cause) });
  const manualFallback = () => { manualRef.current = true; setManualOnly(true); };
  const dismiss = () => {
    alive.current = false;
    generation.current++;
  };
  const close = () => {
    dismiss();
    closeCallback.current();
  };
  const setInputPath = (value: string) => {
    pathRef.current = value;
    setPath(value);
  };
  const loadPending = () => {
    try {
      const value = readPendingProjectAdd(host.id);
      if (alive.current) { setPending(value); setStorageFailed(false); }
      return value;
    } catch {
      if (alive.current) { setStorageFailed(true); setError(t("project.storageFailed")); }
      throw new Error("Pending project storage unavailable");
    }
  };

  const finishAdded = async (record: PendingProjectAdd, result: AddedProjectResult, retry = false) => {
    if (!alive.current || !onlineRef.current || refreshing.current || (delivered.current === record.id && !retry)) return;
    refreshing.current = true;
    delivered.current = record.id;
    setPhase("added"); setError("");
    try {
      await callback.current(result);
    } catch {
      if (alive.current) { setPhase("refreshFailed"); setError(t("project.refreshFailed")); }
      return; // The write succeeded. Never permit another add as a refresh retry.
    } finally { refreshing.current = false; }
    try { clearPendingProjectAdd(host.id, record.id); } catch { /* Retain the safe journal for next-open reconciliation. */ }
    if (alive.current) close();
  };
  const confirm = async (record: PendingProjectAdd, result: AddedProjectResult) => {
    try { if (readPendingProjectAdd(host.id)?.id !== record.id) return; }
    catch { /* A successful response is still authoritative; the pending journal remains fail-closed. */ }
    const confirmed: PendingProjectAdd = { ...record, state: "confirmed", result };
    try { updatePendingProjectAdd(host.id, confirmed); } catch { /* The original durable pending record still blocks duplicate writes. */ }
    if (alive.current) {
      setPending(confirmed);
      if (onlineRef.current) await finishAdded(confirmed, result);
      else setPhase("idle");
    }
  };

  const browse = async (target?: string) => {
    if (!alive.current || !onlineRef.current || active.current) return;
    const turn = ++generation.current;
    setDirectory(undefined); setCandidate(false); setError(""); setBrowsing(true);
    if (target !== undefined) setInputPath(target);
    try {
      if (target !== undefined && !isAbsoluteProjectPath(target)) throw { code: "invalid_path" };
      if (manualRef.current) {
        if (!target) throw { code: "invalid_path" };
        let canonical = target;
        if (!resolveUnsupported.current) {
          try { canonical = (await client.request<{ path: string }>(host.id, "project.directory.resolve", { path: target })).path; }
          catch (cause) { if (!unsupported(cause)) throw cause; resolveUnsupported.current = true; }
        }
        if (alive.current && turn === generation.current && onlineRef.current) { setInputPath(canonical); setCandidate(true); }
      } else {
        const result = await client.request<DirectoryListing>(host.id, "project.directory.list", { ...(target === undefined ? {} : { path: target }), showHidden: hiddenRef.current });
        if (!alive.current || turn !== generation.current || !onlineRef.current) return;
        setDirectory(result); setInputPath(result.path); setCandidate(true);
      }
    } catch (cause) {
      if (!alive.current || turn !== generation.current) return;
      if (unsupported(cause)) { manualFallback(); setCandidate(isAbsoluteProjectPath(pathRef.current)); }
      else setError(errorText(cause));
    } finally {
      if (alive.current && turn === generation.current) setBrowsing(false);
    }
  };

  const checkResult = async () => {
    if (!alive.current || !onlineRef.current || checking.current || active.current || refreshing.current) return;
    checking.current = true;
    const turn = generation.current;
    setPhase("checking"); setError(""); setUnconfirmed(false);
    try {
      let record = loadPending();
      if (!record) { setPhase("idle"); return; }
      if (record.state === "confirmed" && record.result) { await finishAdded(record, record.result, true); return; }
      let resolutionError: unknown;
      if (!record.canonicalPath && !resolveUnsupported.current) {
        try {
          const result = await client.request<{ path: string }>(host.id, "project.directory.resolve", { path: record.path });
          if (!alive.current || turn !== generation.current || !onlineRef.current) return;
          record = { ...record, canonicalPath: result.path };
          updatePendingProjectAdd(host.id, record);
        } catch (cause) {
          if (!alive.current || turn !== generation.current || !onlineRef.current) return;
          if (unsupported(cause)) { resolveUnsupported.current = true; manualFallback(); }
          else resolutionError = cause;
        }
      }
      if (!alive.current || turn !== generation.current || !onlineRef.current) return;
      const projects = await client.request<ProjectSummary[]>(host.id, "project.list", {});
      if (!alive.current || turn !== generation.current || !onlineRef.current) return;
      // Exact canonical match is positive evidence. Absence is never evidence that a write did not run.
      const match = projects.find(project => project.rootPath === (record.canonicalPath ?? record.path));
      if (match) await confirm(record, { project: match, focusedExisting: true });
      else { setPhase("idle"); setUnconfirmed(true); if (resolutionError) setError(errorText(resolutionError)); }
    } catch (cause) {
      if (alive.current && turn === generation.current) { setPhase("idle"); setError(errorText(cause)); }
    } finally {
      if (turn === generation.current) {
        checking.current = false;
        if (alive.current) setPhase(current => current === "checking" ? "idle" : current);
      }
    }
  };
  const browseRef = useRef(browse); browseRef.current = browse;
  const checkRef = useRef(checkResult); checkRef.current = checkResult;
  const finishRef = useRef(finishAdded); finishRef.current = finishAdded;

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let unsubscribe: Unsubscribe | undefined;
    const stopObserving = observePendingProjectAdd(host.id, () => {
      if (!alive.current) return;
      try {
        const record = loadPending();
        if (record) { setInputPath(record.path); setName(record.name ?? ""); }
        else setCandidate(isAbsoluteProjectPath(pathRef.current));
        if (record?.state === "confirmed" && record.result) void finishRef.current(record, record.result);
      } catch { /* Fail closed, with a visible storage explanation. */ }
    });
    try {
      const record = loadPending();
      if (record) {
        setInputPath(record.path); setName(record.name ?? "");
        if (onlineRef.current) void checkRef.current();
      } else if (onlineRef.current) void browseRef.current();
    } catch { /* No remote write without a readable journal. */ }
    void client.onConnectionState(event => {
      if (disposed || !alive.current || event.profileId !== host.id) return;
      const connected = event.state === "connected";
      const reconnected = connected && !onlineRef.current;
      onlineRef.current = connected; setOnline(connected);
      if (!connected) {
        generation.current++; checking.current = false; setBrowsing(false);
        setPhase(current => current === "checking" ? "idle" : current);
      }
      if (reconnected) {
        try {
          if (loadPending()) void checkRef.current();
          else void browseRef.current(pathRef.current || undefined);
        } catch { /* Storage failure blocks writes. */ }
      }
    }).then(stop => { if (!disposed) unsubscribe = stop; else void stop(); }).catch(() => undefined);
    return () => {
      disposed = true; alive.current = false; generation.current++; checking.current = false;
      stopObserving(); void unsubscribe?.();
    };
    // This lifetime is keyed by host; function refs keep callbacks and translations current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, host.id]);
  useEffect(() => {
    const connected = host.connectionState === "connected";
    if (onlineRef.current === connected) return;
    onlineRef.current = connected; setOnline(connected);
    if (!connected) {
      generation.current++; checking.current = false; setBrowsing(false);
      setPhase(current => current === "checking" ? "idle" : current);
    }
    else {
      try { if (loadPending()) void checkRef.current(); else void browseRef.current(pathRef.current || undefined); }
      catch { /* Storage failure blocks writes. */ }
    }
    // Native connection events can arrive before the parent's host snapshot updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.connectionState]);

  const submit = async () => {
    if (active.current || checking.current || !alive.current || !onlineRef.current || !candidate || browsing || pending || storageFailed) return;
    active.current = true; // Before the first await: React's disabled state alone cannot guard a double tap.
    const submittedPath = pathRef.current;
    const submittedName = name.trim() || null;
    setError(""); setPhase("validating");
    let record: PendingProjectAdd | undefined;
    let writeInvoked = false;
    try {
      if (!isAbsoluteProjectPath(submittedPath)) throw { code: "invalid_path" };
      if (submittedName && [...submittedName].length > 80) throw { code: "invalid_name" };
      if (loadPending()) { setPhase("idle"); return; }
      let canonicalPath: string | undefined;
      if (!resolveUnsupported.current) {
        try { canonicalPath = (await client.request<{ path: string }>(host.id, "project.directory.resolve", { path: submittedPath })).path; }
        catch (cause) {
          if (!unsupported(cause)) throw cause;
          resolveUnsupported.current = true;
          if (alive.current) manualFallback();
        }
      }
      if (!alive.current || !onlineRef.current) return; // Closing a read/preflight still means no write.
      record = { id: crypto.randomUUID(), path: submittedPath, canonicalPath, name: submittedName, state: "pending" };
      let began: boolean;
      try { began = beginPendingProjectAdd(host.id, record); }
      catch {
        if (alive.current) { setStorageFailed(true); setError(t("project.storageFailed")); setPhase("idle"); }
        return;
      }
      if (!began) { loadPending(); setPhase("idle"); return; }
      setPending(record); setPhase("submitting");
      writeInvoked = true;
      // No AbortSignal: closing cancels presentation, not the mutation or its late durable receipt.
      const result = await client.request<AddedProjectResult>(host.id, "project.add", { path: canonicalPath ?? submittedPath, name: submittedName });
      await confirm(record, result);
    } catch (cause) {
      if (writeInvoked && record) {
        if (knownFailed(cause) || unsupported(cause)) {
          try { clearPendingProjectAdd(host.id, record.id); } catch { /* Keep blocking if the durable record cannot be cleared. */ }
          if (alive.current) {
            try { loadPending(); } catch { /* Fail closed. */ }
            setPhase("idle"); setError(unsupported(cause) ? t("project.upgradeRequired") : errorText(cause));
          }
        } else if (alive.current) { setPhase("idle"); setUnconfirmed(true); setError(errorText(cause)); }
      } else if (alive.current) {
        setPhase("idle"); setError(codeOf(cause) === "invalid_name" ? t("project.invalidName") : errorText(cause));
        // A storage failure occurs before invocation; keep the form, but block all writes.
        try { readPendingProjectAdd(host.id); } catch { setStorageFailed(true); setError(t("project.storageFailed")); }
      }
    } finally {
      active.current = false;
      if (alive.current) setPhase(current => current === "validating" ? "idle" : current);
    }
  };

  const locked = Boolean(pending) || phase === "validating" || phase === "submitting" || phase === "added" || phase === "refreshFailed";
  const busy = phase === "validating" || phase === "submitting" || phase === "checking";
  return <Modal title={t("project.add")} onDismiss={dismiss} onClose={close} className="add-project-dialog">
    <p className="add-project-host">{t("project.target", { name: host.name })}</p>
    <p className="add-project-hint">{t("project.hint")}</p>
    {!online ? <p role="status" className="add-project-notice">{t("project.offline")}</p> : null}
    {manualOnly ? <p role="status" className="add-project-notice">{t("project.manualFallback")}</p> : null}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor={`${id}-path`}>{t("project.path")}</label>
      <div className="add-project-path-row">
        <input id={`${id}-path`} value={path} readOnly={locked} spellCheck={false} autoCapitalize="none" autoCorrect="off" autoComplete="off" placeholder={t("project.pathPlaceholder")} onChange={event => {
          generation.current++; setBrowsing(false); setDirectory(undefined); setInputPath(event.target.value);
          setCandidate(isAbsoluteProjectPath(event.target.value)); setError("");
        }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (online && !locked) void browse(pathRef.current); } }} />
        <button type="button" disabled={!online || locked || !path} onClick={() => void browse(pathRef.current)}>{t("project.go")}</button>
      </div>
      {!manualOnly ? <>
        <div className="add-project-navigation">
          <button type="button" disabled={!online || locked || !directory?.parentPath} onClick={() => void browse(directory?.parentPath ?? undefined)}>{t("project.up")}</button>
          <button type="button" disabled={!online || locked} onClick={() => void browse()}>{t("project.home")}</button>
          <label className="add-project-hidden"><input type="checkbox" checked={showHidden} disabled={!online || locked} onChange={event => {
            hiddenRef.current = event.target.checked; setShowHidden(event.target.checked);
            void browse(directory?.path ?? (pathRef.current || undefined));
          }} />{t("project.showHidden")}</label>
        </div>
        {browsing ? <p role="status">{t("project.browsing")}</p> : null}
        {directory ? <div className="add-project-browser">
          <p className="add-project-current" aria-label={t("project.currentDirectory")}>{directory.path}</p>
          <ul aria-label={t("project.directories")}>
            {directory.entries.map(entry => <li key={entry.path}><button type="button" disabled={!online || locked} aria-label={t("project.openDirectory", { name: entry.name })} onClick={() => void browse(entry.path)}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 7h7l2 2h9v11H3zM3 7V4h7l2 3" /></svg><span>{entry.name}</span><span aria-hidden="true">›</span>
            </button></li>)}
          </ul>
          {!directory.entries.length ? <p className="add-project-hint">{t("project.emptyDirectory")}</p> : null}
          {directory.truncated ? <p className="add-project-notice">{t("project.truncated")}</p> : null}
        </div> : null}
      </> : null}
      <label htmlFor={`${id}-name`}>{t("project.name")}</label>
      <input id={`${id}-name`} value={name} maxLength={80} readOnly={locked} onChange={event => setName(event.target.value)} />
      <p className="add-project-hint">{t("project.nameHint")}</p>
      {busy ? <p role="status">{t(`project.${phase}`)}</p> : null}
      {pending && phase !== "added" && phase !== "refreshFailed" ? <div className="add-project-notice" role="status">
        <p>{t(pending.state === "confirmed" ? "project.confirmedPending" : unconfirmed ? "project.stillUnknown" : "project.pending")}</p>
        <button type="button" disabled={!online || busy} onClick={() => void checkResult()}>{t("project.checkResult")}</button>
      </div> : null}
      {phase === "added" ? <p role="status">{t("project.added")}</p> : null}
      {error ? <p role="alert" className="add-project-error">{error}</p> : null}
      {phase === "refreshFailed" && pending?.result ? <button type="button" disabled={!online} onClick={() => void checkResult()}>{t("project.retryRefresh")}</button> : null}
      <div className="add-project-actions">
        <button type="button" onClick={close}>{t(busy || pending ? "common.close" : "common.cancel")}</button>
        <button type="submit" className="primary-button" disabled={!online || locked || busy || browsing || !candidate || storageFailed || !isAbsoluteProjectPath(path)}>{t("project.add")}</button>
      </div>
    </form>
  </Modal>;
}
