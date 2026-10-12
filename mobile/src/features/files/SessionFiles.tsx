import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteClient, Unsubscribe } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import type { OpenSession } from "../sessions/types";
import { FileContent, isMarkdown } from "./FileContent";
import { Modal } from "../../components/Modal";
import { useFileDownloads } from "./FileDownloads";
import "./session-files.css";

export interface FileEntry { name: string; path: string; isDir: boolean }
export interface FileListing { rootPath: string; path: string; entries: FileEntry[]; truncated: boolean }
export interface FileRead { rootPath: string; path: string; content: string; sizeBytes: number; truncated: boolean }
interface Resource<T> { data?: T; loading: boolean; stale: boolean; error?: unknown }
export interface SessionFilesProps { open: OpenSession; client: RemoteClient; active: boolean; onBack: () => void }
const codeOf = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const unsupported = (error: unknown) => ["unknown_method", "method_not_found", "capability_disabled", "-32601"].includes(codeOf(error));
const knownErrors = new Set(["unsupported_platform", "path_not_found", "not_directory", "permission_denied", "invalid_path", "outside_root", "unsupported_file", "read_failed", "session_not_found"]);

export function SessionFiles({ open, client, active, onBack }: SessionFilesProps) {
  const { t } = useTranslation();
  const downloads = useFileDownloads();
  const [operations, setOperations] = useState<string>();
  const [directories, setDirectories] = useState<Record<string, Resource<FileListing>>>({});
  const directoriesRef = useRef(directories);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string>();
  const previewRef = useRef<string>();
  const [file, setFile] = useState<Resource<FileRead>>({ loading: false, stale: false });
  const [rendered, setRendered] = useState(true);
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const mounted = useRef(false);
  const requests = useRef(new Map<string, AbortController>());
  const [copyStatus, setCopyStatus] = useState("");
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const treeHeading = useRef<HTMLHeadingElement>(null);
  const returnRow = useRef<string>();
  const updateDirectories = useCallback((update: (old: typeof directories) => typeof directories) => {
    directoriesRef.current = update(directoriesRef.current);
    setDirectories(directoriesRef.current);
  }, []);
  const invalidate = useCallback(() => {
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
    updateDirectories(old => Object.fromEntries(Object.entries(old).map(([path, resource]) => [path, { ...resource, loading: false, stale: true }])));
    setFile(old => ({ ...old, loading: false, stale: true }));
  }, [updateDirectories]);

  const load = useCallback(async (path: string, kind: "list" | "read") => {
    if (!onlineRef.current || !activeRef.current || !mounted.current) return;
    const key = kind === "list" ? `list:${path}` : "read";
    requests.current.get(key)?.abort();
    const controller = new AbortController();
    requests.current.set(key, controller);
    if (kind === "list") updateDirectories(old => ({ ...old, [path]: { ...old[path], loading: true, stale: Boolean(old[path]?.data), error: undefined } }));
    else setFile(old => ({ ...old, loading: true, stale: Boolean(old.data), error: undefined }));
    const valid = () => mounted.current && !controller.signal.aborted && requests.current.get(key) === controller;
    try {
      const result = await client.request<FileListing | FileRead>(open.hostProfileId, `session.files.${kind}`, { sessionId: open.session.id, path }, { signal: controller.signal });
      if (!valid()) return;
      if (kind === "list") updateDirectories(old => ({ ...old, [path]: { data: result as FileListing, loading: false, stale: false } }));
      else setFile({ data: result as FileRead, loading: false, stale: false });
    } catch (error) {
      if (!valid()) return;
      if (kind === "list") updateDirectories(old => ({ ...old, [path]: { ...old[path], loading: false, stale: true, error } }));
      else setFile(old => ({ ...old, loading: false, stale: true, error }));
    } finally { if (requests.current.get(key) === controller) requests.current.delete(key); }
  }, [client, open.hostProfileId, open.session.id, updateDirectories]);
  const refresh = useCallback(() => {
    invalidate();
    for (const path of new Set([".", ...Object.keys(directoriesRef.current)])) void load(path, "list");
    if (previewRef.current) void load(previewRef.current, "read");
  }, [invalidate, load]);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let unsubscribe: Unsubscribe | undefined;
    let receivedEvent = false;
    const connection = (connected: boolean) => {
      const previous = onlineRef.current;
      onlineRef.current = connected;
      setOnline(connected);
      if (!connected) invalidate();
      else if (!previous && activeRef.current) refresh();
    };
    void client.onConnectionState(event => {
      if (disposed || event.profileId !== open.hostProfileId) return;
      receivedEvent = true;
      connection(event.state === "connected");
    }).then(value => { if (disposed) void value(); else unsubscribe = value; }).catch(() => { if (!disposed) connection(false); });
    void client.listHostProfiles().then(hosts => {
      if (disposed || receivedEvent) return;
      const host = hosts.find(item => item.id === open.hostProfileId);
      if (host) connection(host.connectionState === "connected");
    }).catch(() => { if (!disposed && !receivedEvent) connection(false); });
    return () => {
      disposed = true;
      mounted.current = false;
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear();
      if (unsubscribe) void unsubscribe();
    };
  }, [client, open.hostProfileId, invalidate, refresh]);

  useEffect(() => {
    if (active) refresh();
    else {
      invalidate();
      previewRef.current = undefined;
      setPreview(undefined);
      setOperations(undefined);
      setCopyStatus("");
    }
  }, [active, refresh, invalidate]);
  useEffect(() => { if (preview) previewHeading.current?.focus({ preventScroll: true }); }, [preview]);

  const openFile = (path: string) => {
    if (!previewRef.current) returnRow.current = path;
    previewRef.current = path;
    setPreview(path);
    setFile({ loading: false, stale: false });
    setRendered(true);
    setCopyStatus("");
    void load(path, "read");
  };
  const backToTree = () => {
    requests.current.get("read")?.abort();
    requests.current.delete("read");
    previewRef.current = undefined;
    setPreview(undefined);
    setCopyStatus("");
    // The tree stays mounted, so its scroll position and row focus can be restored.
    requestAnimationFrame(() => { if (mounted.current && activeRef.current) (rows.current.get(returnRow.current ?? "") ?? treeHeading.current)?.focus({ preventScroll: true }); });
  };
  const copy = async (value: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (mounted.current) setCopyStatus(t("files.copied"));
    } catch { if (mounted.current) setCopyStatus(t("files.copyFailed")); }
  };
  const errorText = (error: unknown) => unsupported(error) ? t("files.upgradeRequired")
    : knownErrors.has(codeOf(error)) ? t(`files.errors.${codeOf(error)}`) : t("files.requestFailed", { error: remoteErrorMessage(error) });
  const resourceStatus = (resource: Resource<unknown> | undefined, retry: () => void) => <>
    {resource?.loading ? <p className="files-note" role="status">{t("files.loading")}</p> : null}
    {resource?.stale && resource.data ? <p className="files-note" role="status">{t("files.cached")}</p> : null}
    {resource?.error ? <div className="files-error" role="alert"><p>{errorText(resource.error)}</p><button type="button" onClick={retry} disabled={!online}>{t("files.retry")}</button></div> : null}
  </>;
  const tree = (path: string, depth = 0): React.ReactNode => {
    const resource = Object.hasOwn(directories, path) ? directories[path] : undefined;
    const entries = [...(resource?.data?.entries ?? [])].filter(entry => entry.name !== ".git")
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return <div className="files-directory">
      {resourceStatus(resource, () => void load(path, "list"))}
      {resource?.data && entries.length === 0 && !resource.loading ? <p className="files-note">{t("files.empty")}</p> : null}
      <ul className="files-list">{entries.map(entry => <li key={entry.path}>
        <div className="files-entry-row"><button type="button" className="files-row" data-page-swipe="true" aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
          ref={node => { if (node) rows.current.set(entry.path, node); else rows.current.delete(entry.path); }}
          style={{ paddingInlineStart: `${12 + Math.min(depth, 8) * 16}px` }}
          onClick={() => {
            if (!entry.isDir) { openFile(entry.path); return; }
            setExpanded(old => { const next = new Set(old); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
            if (!expanded.has(entry.path) && !Object.hasOwn(directoriesRef.current, entry.path)) void load(entry.path, "list");
          }}>
          <span className="files-entry-icon" aria-hidden="true">{entry.isDir ? expanded.has(entry.path) ? "▾" : "▸" : "≡"}</span>
          <span>{entry.name}<small>{entry.isDir ? t("files.directory") : t("files.file")}</small></span>
        </button>
        {!entry.isDir ? <button type="button" className="files-entry-actions" aria-label={t("downloads.fileActions", { name: entry.name })} aria-haspopup="dialog" onClick={() => setOperations(entry.path)}>⋯</button> : null}</div>
        {entry.isDir && expanded.has(entry.path) ? tree(entry.path, depth + 1) : null}
      </li>)}</ul>
      {resource?.data?.truncated ? <p className="files-note" role="status">{t("files.directoryTruncated")}</p> : null}
    </div>;
  };
  return <section className={`session-files${active ? "" : " is-inactive"}`} tabIndex={-1} aria-label={t("files.open")} aria-hidden={!active}>
    <div className={`files-tree-page${preview !== undefined ? " is-obscured" : ""}`} aria-hidden={preview !== undefined}>
      <header className="files-header"><button type="button" onClick={onBack}>{t("files.backToTerminal")}</button><h1 ref={treeHeading} tabIndex={-1}>{t("files.open")}</h1><button type="button" disabled={!online} onClick={refresh}>{t("files.refresh")}</button></header>
      <p className="files-root">{directories["."]?.data?.rootPath ?? open.session.cwd}</p>
      <p className="files-caption">{t("files.readOnly")}</p>
      {!online ? <p className="files-offline" role="status">{t("files.offline")}</p> : null}
      <div className="files-tree-scroll" aria-label={t("files.open")}>{tree(".")}</div>
    </div>
    {preview !== undefined ? <div className="files-preview-page" data-no-page-swipe="true">
      <header className="files-header"><button type="button" onClick={backToTree}>{t("files.backToTree")}</button><h1 ref={previewHeading} tabIndex={-1}>{t("files.preview")}</h1><button type="button" disabled={!online} onClick={() => void load(preview, "read")}>{t("files.refresh")}</button></header>
      <p className="files-root">{preview}</p>
      <div className="files-actions"><button type="button" disabled={!online || !downloads.available || downloads.occupied} onClick={() => downloads.start(open, preview)}>{t("downloads.download")}</button><button type="button" onClick={() => void copy(preview)}>{t("files.copyPath")}</button><button type="button" disabled={!file.data} onClick={() => void copy(file.data?.content ?? "")}>{t(file.data?.truncated ? "files.copyVisible" : "files.copyContent")}</button>
        {isMarkdown(preview) ? <button type="button" aria-pressed={rendered} onClick={() => setRendered(value => !value)}>{t(rendered ? "files.showSource" : "files.showRendered")}</button> : null}</div>
      {copyStatus ? <p className="files-note" role="status">{copyStatus}</p> : null}
      {!online ? <p className="files-offline" role="status">{t("files.offline")}</p> : null}
      <div className="files-preview-scroll">
        {resourceStatus(file, () => void load(preview, "read"))}
        {file.data?.truncated ? <p className="files-note" role="status">{t("files.fileTruncated", { size: file.data.sizeBytes.toLocaleString() })}</p> : null}
        {file.data ? <FileContent path={preview} content={file.data.content} rendered={rendered} onOpen={openFile} /> : null}
      </div>
    </div> : null}
    {operations !== undefined ? <Modal title={t("downloads.fileActions", { name: operations.split("/").pop() })} onClose={() => setOperations(undefined)}>
      <p className="files-operation-path">{operations}</p>
      <p>{t("downloads.fileHint")}</p>
      {!downloads.available ? <p role="status">{t("downloads.nativeOnly")}</p> : downloads.occupied ? <p role="status">{t("downloads.busy")}</p> : !online ? <p role="status">{t("files.offline")}</p> : null}
      <button className="files-operation-button" type="button" disabled={!online || !downloads.available || downloads.occupied} onClick={() => { const path = operations; setOperations(undefined); downloads.start(open, path); }}>{t("downloads.download")}</button>
    </Modal> : null}
  </section>;
}
