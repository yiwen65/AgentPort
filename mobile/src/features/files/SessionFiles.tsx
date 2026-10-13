import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteClient, Unsubscribe } from "../../protocol/remoteClient";
import { remoteErrorMessage } from "../../protocol/remoteError";
import type { OpenSession } from "../sessions/types";
import { FileContent, isMarkdown } from "./FileContent";
import { Modal } from "../../components/Modal";
import { FileDownloadIndicator, useFileDownloads } from "./FileDownloads";
import { useFilePageSwipe } from "./useFilePageSwipe";
import { FileTreeIcon } from "./FileTreeIcon";
import "./session-files.css";

export interface FileEntry { name: string; path: string; isDir: boolean }
export interface FileListing { rootPath: string; path: string; entries: FileEntry[]; truncated: boolean }
export interface FileRead { rootPath: string; path: string; content: string; sizeBytes: number; truncated: boolean }
interface Resource<T> { data?: T; loading: boolean; stale: boolean; error?: unknown }
export interface SessionFilesProps { open: OpenSession; client: RemoteClient; active: boolean; onBack: () => void }
const codeOf = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "";
const unsupported = (error: unknown) => ["unknown_method", "method_not_found", "capability_disabled", "-32601"].includes(codeOf(error));
const knownErrors = new Set(["unsupported_platform", "path_not_found", "not_directory", "permission_denied", "invalid_path", "outside_root", "unsupported_file", "read_failed", "session_not_found"]);
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || "/";
function BackIcon() { return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m15 5-7 7 7 7" /></svg>; }

export function SessionFiles({ open, client, active, onBack }: SessionFilesProps) {
  const { t } = useTranslation();
  const downloads = useFileDownloads({ immersive: active });
  const [operations, setOperations] = useState<string>();
  const [menu, setMenu] = useState<"tree" | "preview">();
  const [information, setInformation] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(false);
  const treeReveal = useRef<HTMLButtonElement>(null);
  const previewReveal = useRef<HTMLButtonElement>(null);
  const [directories, setDirectories] = useState<Record<string, Resource<FileListing>>>({});
  const directoriesRef = useRef(directories);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Selection and visibility are separate: going back never destroys reading state.
  const [preview, setPreview] = useState<string>();
  const previewRef = useRef<string>();
  const [previewVisible, setPreviewVisible] = useState(false);
  const [file, setFile] = useState<Resource<FileRead>>({ loading: false, stale: false });
  const [rendered, setRendered] = useState(true);
  const [online, setOnline] = useState(true);
  const onlineRef = useRef(true);
  const activeRef = useRef(active); activeRef.current = active;
  const mounted = useRef(false);
  const requests = useRef(new Map<string, AbortController>());
  const [copyStatus, setCopyStatus] = useState("");
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const previewScroll = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const treeHeading = useRef<HTMLHeadingElement>(null);
  const returnRow = useRef<string>();
  const updateDirectories = useCallback((update: (old: typeof directories) => typeof directories) => {
    directoriesRef.current = update(directoriesRef.current); setDirectories(directoriesRef.current);
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
    const controller = new AbortController(); requests.current.set(key, controller);
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
    let disposed = false; let unsubscribe: Unsubscribe | undefined; let receivedEvent = false;
    const connection = (connected: boolean) => {
      const previous = onlineRef.current; onlineRef.current = connected; setOnline(connected);
      if (!connected) invalidate(); else if (!previous && activeRef.current) refresh();
    };
    void client.onConnectionState(event => {
      if (disposed || event.profileId !== open.hostProfileId) return;
      receivedEvent = true; connection(event.state === "connected");
    }).then(value => { if (disposed) void value(); else unsubscribe = value; }).catch(() => { if (!disposed) connection(false); });
    void client.listHostProfiles().then(hosts => {
      if (disposed || receivedEvent) return;
      const host = hosts.find(item => item.id === open.hostProfileId);
      if (host) connection(host.connectionState === "connected");
    }).catch(() => { if (!disposed && !receivedEvent) connection(false); });
    return () => {
      disposed = true; mounted.current = false;
      for (const controller of requests.current.values()) controller.abort();
      requests.current.clear(); if (unsubscribe) void unsubscribe();
    };
  }, [client, open.hostProfileId, invalidate, refresh]);
  useEffect(() => {
    if (active) refresh();
    else { invalidate(); setPreviewVisible(false); setOperations(undefined); setMenu(undefined); setCopyStatus(""); }
  }, [active, refresh, invalidate]);
  useLayoutEffect(() => { if (previewScroll.current) previewScroll.current.scrollTop = 0; }, [preview]);
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 3000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (previewVisible) previewScroll.current?.focus({ preventScroll: true });
      else (rows.current.get(returnRow.current ?? "") ?? treeReveal.current)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, preview, previewVisible]);

  useEffect(() => { setChromeVisible(false); }, [active, previewVisible]);
  const showPreview = () => { if (previewRef.current) setPreviewVisible(true); };
  const backToTree = () => { window.getSelection()?.removeAllRanges(); setPreviewVisible(false); setCopyStatus(""); };
  const { dragging } = useFilePageSwipe({ containerRef: pages, active, previewVisible, hasPreview: preview !== undefined, onShowTree: backToTree, onShowPreview: showPreview });
  const openFile = useCallback((path: string) => {
    returnRow.current = path;
    setChromeVisible(false);
    setPreviewVisible(true);
    if (previewRef.current === path) return;
    previewRef.current = path; setPreview(path); setFile({ loading: false, stale: false }); setRendered(true); setCopyStatus("");
    void load(path, "read");
  }, [load]);
  const copy = async (value: string) => {
    const path = previewRef.current;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (mounted.current && path === previewRef.current) setCopyStatus(t("files.copied"));
    } catch { if (mounted.current && path === previewRef.current) setCopyStatus(t("files.copyFailed")); }
  };
  const errorText = (error: unknown) => unsupported(error) ? t("files.upgradeRequired")
    : knownErrors.has(codeOf(error)) ? t(`files.errors.${codeOf(error)}`) : t("files.requestFailed", { error: remoteErrorMessage(error) });
  const resourceStatus = (resource: Resource<unknown> | undefined, retry: () => void, compact = false) => <>
    {resource?.loading && !resource.data ? <p className="files-note" role="status">{t("files.loading")}</p> : null}
    {!compact && resource?.stale && resource.data ? <p className="files-state-strip" role="status">{t("files.cachedShort")}</p> : null}
    {resource?.error ? <div className="files-error" role="alert"><p>{errorText(resource.error)}</p><button type="button" onClick={retry} disabled={!online}>{t("files.retry")}</button></div> : null}
  </>;
  const tree = (path: string, depth = 0): React.ReactNode => {
    const resource = Object.hasOwn(directories, path) ? directories[path] : undefined;
    const entries = [...(resource?.data?.entries ?? [])].filter(entry => entry.name !== ".git").sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return <div className="files-directory">
      {resourceStatus(resource, () => void load(path, "list"), path === ".")}
      {resource?.data && entries.length === 0 && !resource.loading ? <p className="files-note">{t("files.empty")}</p> : null}
      <ul className="files-list">{entries.map(entry => <li key={entry.path}>
        <div className="files-entry-row"><button type="button" className="files-row" data-page-swipe="true" aria-label={`${entry.name} ${t(entry.isDir ? "files.directory" : "files.file")}`} title={entry.name} aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
          ref={node => { if (node) rows.current.set(entry.path, node); else rows.current.delete(entry.path); }}
          style={{ paddingInlineStart: `${12 + Math.min(depth, 8) * 16}px` }}
          onClick={() => {
            if (!entry.isDir) { openFile(entry.path); return; }
            setExpanded(old => { const next = new Set(old); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
            if (!expanded.has(entry.path) && !Object.hasOwn(directoriesRef.current, entry.path)) void load(entry.path, "list");
          }}>
          <span className="files-entry-icon" aria-hidden="true"><FileTreeIcon name={entry.name} directory={entry.isDir} expanded={expanded.has(entry.path)} /></span>
          <span className="files-entry-name">{entry.name}</span>
        </button>
        {!entry.isDir ? <button type="button" className="files-entry-actions" aria-label={t("downloads.fileActions", { name: entry.name })} aria-haspopup="dialog" onClick={() => setOperations(entry.path)}>⋯</button> : null}</div>
        {entry.isDir && expanded.has(entry.path) ? tree(entry.path, depth + 1) : null}
      </li>)}</ul>
      {resource?.data?.truncated ? <p className="files-state-strip" role="status">{t("files.directoryTruncated")}</p> : null}
    </div>;
  };
  const root = directories["."]?.data?.rootPath ?? open.session.cwd;
  const menuTitle = menu === "preview" && preview ? baseName(preview) : baseName(root);
  const openMenu = (page: "tree" | "preview") => { setInformation(false); setMenu(page); };
  const closeMenu = () => setMenu(undefined);
  const downloadWarning = downloads.snapshot?.error ? t(`downloads.errors.${downloads.snapshot.error.code}`, { defaultValue: t("downloads.errors.request_failed") }) : undefined;
  const moreLabel = downloads.snapshot ? [t("files.more"), t(`downloads.states.${downloads.snapshot.state}`), downloadWarning].filter(Boolean).join(" · ") : t("files.more");
  const menuButton = (page: "tree" | "preview") => <button type="button" className="files-icon-button files-more-button" aria-label={moreLabel} aria-haspopup="dialog" onClick={() => openMenu(page)}><span aria-hidden="true">⋯</span><FileDownloadIndicator /></button>;
  const header = (page: "tree" | "preview", title: string, path: string) => <>
    <button ref={page === "tree" ? treeReveal : previewReveal} type="button" className="files-chrome-reveal" hidden={chromeVisible} aria-label={t("files.showControls")} aria-expanded={false}
      onClick={(event) => { setChromeVisible(true); if (event.detail === 0) requestAnimationFrame(() => (page === "tree" ? treeHeading : previewHeading).current?.focus({ preventScroll: true })); }}><span aria-hidden="true">⋯</span><FileDownloadIndicator /></button>
    <header className="files-header" hidden={!chromeVisible} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setChromeVisible(false); requestAnimationFrame(() => (page === "tree" ? treeReveal : previewReveal).current?.focus({ preventScroll: true })); } }}>
      <div className="files-heading"><button type="button" className="files-icon-button" aria-label={t(page === "tree" ? "files.backToTerminal" : "files.backToTree")} onClick={page === "tree" ? onBack : backToTree}><BackIcon /></button><h1 ref={page === "tree" ? treeHeading : previewHeading} tabIndex={-1} title={path}>{title}</h1></div>{menuButton(page)}
    </header>
  </>;
  const previewNotice = !online ? t("files.offlineShort") : file.data && file.loading ? t("files.loading") : file.data && file.stale ? t("files.cachedShort") : undefined;
  return <section className={`session-files${active ? "" : " is-inactive"}`} tabIndex={-1} aria-label={t("files.open")} aria-hidden={!active} data-chrome-visible={chromeVisible} onPointerDownCapture={(event) => { if (!(event.target as Element).closest(".files-header,.files-chrome-reveal,.modal-backdrop,.mobile-modal-portal")) setChromeVisible(false); }}>
    <div ref={pages} className="files-page-viewport" data-preview-visible={previewVisible} data-dragging={dragging}>
      <div className={`files-page-track${previewVisible ? " is-preview" : ""}`}>
        <section className="files-tree-page" aria-hidden={previewVisible} {...(previewVisible ? { inert: "" } : {})}>
          {header("tree", baseName(root), root)}
          {!online || directories["."]?.stale && directories["."]?.data ? <p className="files-state-strip" role="status">{t(!online ? "files.offlineShort" : "files.cachedShort")}</p> : null}
          <div className="files-tree-scroll" aria-label={t("files.open")}>{tree(".")}</div>
        </section>
        <section className="files-preview-page" data-no-page-swipe="true" aria-hidden={!previewVisible} {...(!previewVisible ? { inert: "" } : {})}>
          {preview !== undefined ? <>
            {header("preview", baseName(preview), preview)}
            {previewNotice ? <p className="files-state-strip" role="status">{previewNotice}</p> : null}
            {file.data?.truncated ? <button className="files-state-strip files-state-action" type="button" aria-label={t("files.fileTruncated", { size: file.data.sizeBytes.toLocaleString() })} onClick={() => { openMenu("preview"); setInformation(true); }}>{t("files.truncatedShort")}</button> : null}
            <div ref={previewScroll} className="files-preview-scroll" tabIndex={-1} aria-label={baseName(preview)}>
              {resourceStatus(file, () => void load(preview, "read"), true)}
              {file.data ? <FileContent path={preview} content={file.data.content} rendered={rendered} onOpen={openFile} /> : null}
            </div>
          </> : null}
        </section>
      </div>
    </div>
    {copyStatus ? <p className="files-toast" role="status">{copyStatus}</p> : null}
    {menu !== undefined ? <Modal title={information ? t("files.information") : menuTitle} onClose={closeMenu} className="files-menu">
      {information ? <div className="files-information">
        <p className="files-operation-path">{menu === "preview" && preview ? `${root.replace(/\/$/, "")}/${preview}` : root}</p>
        <p>{t("files.readOnly")}</p><p>{t("files.markdownSafety")}</p>
        {!online ? <p>{t("files.offline")}</p> : null}
        {menu === "preview" && file.stale && file.data ? <p>{t("files.cached")}</p> : null}
        {menu === "preview" && file.data?.truncated ? <p>{t("files.fileTruncated", { size: file.data.sizeBytes.toLocaleString() })}</p> : null}
        <button type="button" className="files-menu-action" onClick={() => setInformation(false)}>{t("files.backToActions")}</button>
      </div> : <div className="files-menu-actions">
        <button type="button" className="files-menu-action" disabled={!online} onClick={() => { closeMenu(); if (menu === "preview" && preview) void load(preview, "read"); else refresh(); }}>{t("files.refresh")}</button>
        {menu === "preview" && preview ? <>
          <button type="button" className="files-menu-action" disabled={!online || !downloads.available || downloads.occupied} onClick={() => { closeMenu(); downloads.start(open, preview); }}>{t("downloads.download")}</button>
          <button type="button" className="files-menu-action" onClick={() => { closeMenu(); void copy(preview); }}>{t("files.copyPath")}</button>
          <button type="button" className="files-menu-action" disabled={!file.data} onClick={() => { closeMenu(); void copy(file.data?.content ?? ""); }}>{t(file.data?.truncated ? "files.copyVisible" : "files.copyContent")}</button>
          {isMarkdown(preview) ? <button type="button" className="files-menu-action" aria-pressed={rendered} onClick={() => { closeMenu(); setRendered(value => !value); }}>{t(rendered ? "files.showSource" : "files.showRendered")}</button> : null}
        </> : preview ? <button type="button" className="files-menu-action" onClick={() => { closeMenu(); showPreview(); }}>{t("files.resumePreview", { name: baseName(preview) })}</button> : null}
        {downloads.snapshot ? <button type="button" className="files-menu-action" onClick={() => { closeMenu(); queueMicrotask(downloads.openDetails); }}>{t("downloads.title")} · {t(`downloads.states.${downloads.snapshot.state}`)}</button> : null}
        <button type="button" className="files-menu-action" onClick={() => setInformation(true)}>{t("files.information")}</button>
        {menu === "preview" && !downloads.available ? <p className="files-note">{t("downloads.nativeOnly")}</p> : null}
      </div>}
    </Modal> : null}
    {operations !== undefined ? <Modal title={t("downloads.fileActions", { name: baseName(operations) })} onClose={() => setOperations(undefined)} className="files-menu">
      <p className="files-operation-path">{operations}</p><p>{t("downloads.fileHint")}</p>
      {!downloads.available ? <p role="status">{t("downloads.nativeOnly")}</p> : downloads.occupied ? <p role="status">{t("downloads.busy")}</p> : !online ? <p role="status">{t("files.offline")}</p> : null}
      <button className="files-operation-button" type="button" disabled={!online || !downloads.available || downloads.occupied} onClick={() => { const path = operations; setOperations(undefined); downloads.start(open, path); }}>{t("downloads.download")}</button>
    </Modal> : null}
  </section>;
}
