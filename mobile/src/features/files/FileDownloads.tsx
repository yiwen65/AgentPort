import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import type { FileDownloadClient, FileDownloadSnapshot, FileDownloadSource } from "../../protocol/fileDownloadClient";
import type { OpenSession } from "../sessions/types";
import "./file-downloads.css";

interface Source extends FileDownloadSource { hostName: string; sessionTitle: string }
interface Job { snapshot: FileDownloadSnapshot; source: Source }
interface Downloads {
  available: boolean;
  occupied: boolean;
  start(open: OpenSession, path: string): void;
}
const DownloadsContext = createContext<Downloads>({ available: false, occupied: false, start: () => {} });
export const useFileDownloads = () => useContext(DownloadsContext);
const active = (job?: Job) => !!job && ["downloading", "ready", "saving"].includes(job.snapshot.state);
const codeOf = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "request_failed";
const knownErrors = new Set(["upgrade_required", "unknown_method", "capability_disabled", "unsupported_platform", "file_too_large", "source_changed", "invalid_download", "invalid_offset", "incomplete_download", "too_many_downloads", "outside_root", "path_not_found", "permission_denied", "unsupported_file", "invalid_path", "session_not_found", "host_not_connected", "connection_changed", "connection_unknown", "request_timeout", "disk_full", "write_failed", "integrity_failed", "save_failed", "cleanup_failed", "partial_save", "download_busy", "request_failed", "disk_error", "integrity_error", "invalid_job", "not_ready", "save_in_progress", "save_failed_leftover", "saved_cleanup_failed", "cancelled"]);
const errorCode = (error: unknown) => knownErrors.has(codeOf(error)) ? codeOf(error) : "request_failed";
export const formatFileBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 * 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;

/** App lifetime, not SessionFiles lifetime: navigation never owns the transfer. */
export function FileDownloadProvider({ client, children }: { client: FileDownloadClient; children: ReactNode }) {
  const { t } = useTranslation();
  const [job, setJob] = useState<Job>();
  const current = useRef<Job>();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelPending = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const [details, setDetails] = useState(false);
  const [notice, setNotice] = useState<string>();
  const update = useCallback((value: Job | undefined) => { current.current = value; if (mounted.current) setJob(value); }, []);
  const setWorking = (value: boolean) => { busyRef.current = value; if (mounted.current) setBusy(value); };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      const id = current.current?.snapshot.jobId;
      if (id) void client.cancel(id).then(() => client.discard(id)).catch(() => {});
    };
  }, [client]);

  useEffect(() => {
    if (!job?.snapshot.jobId || !["downloading", "saving"].includes(job.snapshot.state) || busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const turn = epoch.current;
    const id = job.snapshot.jobId;
    const poll = async () => {
      try {
        const snapshot = await client.poll(id);
        if (stopped || !mounted.current || turn !== epoch.current || current.current?.snapshot.jobId !== id) return;
        update({ ...current.current, snapshot });
        if (snapshot.state !== "downloading") cancelPending.current = false;
        setNotice(cancelPending.current ? "cancelling" : undefined);
      } catch (error) {
        if (!stopped && mounted.current && turn === epoch.current) setNotice(errorCode(error));
      }
      if (!stopped) timer = setTimeout(poll, 500);
    };
    timer = setTimeout(poll, 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [client, job?.snapshot.jobId, job?.snapshot.state, busy, update]);

  const start = async (source: Source) => {
    if (!client.available() || busyRef.current || active(current.current)) return;
    const turn = ++epoch.current;
    setWorking(true); cancelPending.current = false; setNotice(undefined);
    try {
      if (current.current?.snapshot.jobId) {
        try { await client.discard(current.current.snapshot.jobId); }
        catch (error) { if (mounted.current && turn === epoch.current) setNotice(errorCode(error)); return; }
      }
      const starting: FileDownloadSnapshot = { ...source, jobId: "", name: source.path.split("/").pop() ?? source.path, state: "downloading", totalBytes: 0, receivedBytes: 0 };
      update({ source, snapshot: starting });
      const snapshot = await client.start({ profileId: source.profileId, sessionId: source.sessionId, path: source.path });
      if (!mounted.current || turn !== epoch.current) { void client.cancel(snapshot.jobId).then(() => client.discard(snapshot.jobId)).catch(() => {}); return; }
      update({ source, snapshot });
      if (cancelPending.current) {
        try { const cancelled = await client.cancel(snapshot.jobId); if (mounted.current && turn === epoch.current) { update({ source, snapshot: cancelled }); if (cancelled.state !== "downloading") cancelPending.current = false; setNotice(cancelPending.current ? "cancelling" : undefined); } }
        catch (error) { cancelPending.current = false; if (mounted.current && turn === epoch.current) setNotice(errorCode(error)); }
      }
    } catch (error) {
      if (mounted.current && turn === epoch.current) {
        const snapshot: FileDownloadSnapshot = { ...source, jobId: "", name: source.path.split("/").pop() ?? source.path, totalBytes: 0, receivedBytes: 0, state: cancelPending.current ? "cancelled" : "failed", error: { code: errorCode(error), message: "" } };
        update({ source, snapshot });
      }
    } finally { if (mounted.current && turn === epoch.current) setWorking(false); }
  };
  const cancel = async () => {
    if (!current.current) return;
    if (!current.current.snapshot.jobId) { cancelPending.current = true; setNotice("cancelling"); return; }
    if (busyRef.current && current.current.snapshot.state !== "saving") return;
    const value = current.current;
    const turn = ++epoch.current;
    setWorking(true); cancelPending.current = true; setNotice("cancelling");
    try { const snapshot = await client.cancel(value.snapshot.jobId); if (mounted.current && turn === epoch.current) { update({ ...value, snapshot }); if (snapshot.state !== "downloading") cancelPending.current = false; setNotice(cancelPending.current ? "cancelling" : undefined); } }
    catch (error) { cancelPending.current = false; if (mounted.current && turn === epoch.current) setNotice(errorCode(error)); }
    finally { if (mounted.current && turn === epoch.current) setWorking(false); }
  };
  const save = async () => {
    const value = current.current;
    if (!value || value.snapshot.state !== "ready" || busyRef.current) return;
    const turn = ++epoch.current;
    setWorking(true); setNotice(undefined); setDetails(false);
    update({ ...value, snapshot: { ...value.snapshot, state: "saving" } });
    try { const snapshot = await client.save(value.snapshot.jobId); if (mounted.current && turn === epoch.current) update({ ...value, snapshot }); }
    catch (error) {
      // A rejected native call is not evidence of a failed/finished save. Ask
      // native for the authoritative state before enabling replacement/retry.
      try { const snapshot = await client.poll(value.snapshot.jobId); if (mounted.current && turn === epoch.current) update({ ...value, snapshot }); }
      catch { /* retain saving until an explicit poll/cancel proves its state */ }
      if (mounted.current && turn === epoch.current) setNotice(errorCode(error));
    } finally { if (mounted.current && turn === epoch.current) setWorking(false); }
  };
  const dismiss = async () => {
    const value = current.current;
    if (!value || active(value) || busyRef.current) return;
    const turn = ++epoch.current;
    setWorking(true);
    try { if (value.snapshot.jobId) await client.discard(value.snapshot.jobId); if (mounted.current && turn === epoch.current) { update(undefined); setDetails(false); setNotice(undefined); } }
    catch (error) { if (mounted.current && turn === epoch.current) setNotice(errorCode(error)); }
    finally { if (mounted.current && turn === epoch.current) setWorking(false); }
  };
  const status = job ? t(`downloads.states.${job.snapshot.state}`) : "";
  // A cleanup/retry notice must never hide an incomplete external destination.
  const leftover = job?.snapshot.error?.code === "save_failed_leftover";
  const error = leftover ? "save_failed_leftover" : notice ?? job?.snapshot.error?.code;
  const errorText = error ? t(`downloads.errors.${knownErrors.has(error) || error === "cancelling" ? error : "request_failed"}`) : "";
  const secondaryErrorText = leftover && notice && notice !== error ? t(`downloads.errors.${knownErrors.has(notice) ? notice : "request_failed"}`) : "";
  const controls = job ? <>
    {job.snapshot.state === "ready" ? <button type="button" disabled={busy} onClick={() => void save()}>{t("downloads.saveAs")}</button> : null}
    {job.snapshot.state === "saving" ? <span className="file-download-save-note">{t("downloads.systemCancel")}</span> : ["downloading", "ready"].includes(job.snapshot.state) ? <button type="button" disabled={(busy && !!job.snapshot.jobId) || notice === "cancelling"} onClick={() => void cancel()}>{t("downloads.cancel")}</button> : <>
      {["failed", "cancelled"].includes(job.snapshot.state) ? <button type="button" disabled={busy} onClick={() => void start(job.source)}>{t("downloads.retry")}</button> : null}
      <button type="button" disabled={busy} onClick={() => void dismiss()}>{t("downloads.dismiss")}</button>
    </>}
  </> : null;
  return <DownloadsContext.Provider value={{ available: client.available(), occupied: busy || active(job), start: (open, path) => { void start({ profileId: open.hostProfileId, sessionId: open.session.id, path, hostName: open.hostName, sessionTitle: open.session.title }); } }}>
    {children}
    {job ? <aside className="file-download-banner" data-no-page-swipe="true" aria-label={t("downloads.title")}>
      <button className="file-download-details" type="button" onClick={() => setDetails(true)} aria-label={t("downloads.details", { name: job.snapshot.name })}>
        <strong>{job.snapshot.name}</strong><span role="status">{status}</span>
        <small>{formatFileBytes(job.snapshot.receivedBytes)} / {job.snapshot.totalBytes ? formatFileBytes(job.snapshot.totalBytes) : "—"}</small>
      </button>
      {job.snapshot.state === "downloading" && job.snapshot.totalBytes > 0 ? <progress max={job.snapshot.totalBytes} value={job.snapshot.receivedBytes} aria-label={t("downloads.progress")} /> : null}
      {errorText ? <p role={error === "cancelling" ? "status" : "alert"}>{errorText}</p> : null}
      {secondaryErrorText ? <p role="alert">{secondaryErrorText}</p> : null}
      <div className="file-download-controls">{controls}</div>
    </aside> : null}
    {details && job ? <Modal title={t("downloads.title")} onClose={() => setDetails(false)} className="file-download-dialog">
      <p className="download-source">{job.source.hostName} · {job.source.sessionTitle}<br />{job.source.path}</p>
      <p role="status">{status}</p><p>{formatFileBytes(job.snapshot.receivedBytes)} / {formatFileBytes(job.snapshot.totalBytes)}</p>
      <p>{t("downloads.foregroundHint")}</p><p>{t("downloads.saveHint")}</p>
      {errorText ? <p role={error === "cancelling" ? "status" : "alert"}>{errorText}</p> : null}
      {secondaryErrorText ? <p role="alert">{secondaryErrorText}</p> : null}
      <div className="file-download-controls">{controls}</div>
    </Modal> : null}
  </DownloadsContext.Provider>;
}
