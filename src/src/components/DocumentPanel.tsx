// In-app document viewer, opened from document links in terminal output.
// Sits beside the terminal like a VSCode editor split: the raw view is an
// editor with a line-number gutter (⌘S saves back to disk), while the
// preview view renders Markdown or wrapped prose read-only.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errorText } from "../api";
import {
  closeDocument,
  documentPathFallbacks,
  isMarkdownPath,
  registerDocumentDirtyChecker,
} from "../documents";
import { MarkdownView } from "../markdown";
import { runtimeMessageEnvelope } from "../runtimeMessages";
import { insertTextIntoTerminal } from "../terminals";
import { computeLineRange, formatSelectionReference } from "../terminalDrop";
import { confirmDialog, findSession, setState, toast, useStore } from "../store";
import type { SessionDocument } from "../types";
import DocumentTree from "./DocumentTree";

const MIN_DOC_PANEL_WIDTH = 320;
const MAX_DOC_PANEL_RATIO = 0.6;

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Friendly empty state for files the viewer cannot display. Binary files
 * (PDF, images, archives, …) get an explanation plus actions to open the
 * file with the system default app or reveal it in the file manager. */
function UnsupportedFileNotice({
  code,
  detail,
  path,
}: {
  code: string | null;
  detail: string;
  path: string;
}) {
  const { t } = useTranslation("shell");
  const binary = code === "document_binary";
  const title = binary
    ? t("ui.document.unsupported.binaryTitle")
    : code === "document_not_found"
      ? t("ui.document.unsupported.missingTitle")
      : code === "document_not_file"
        ? t("ui.document.unsupported.notFileTitle")
        : t("ui.document.unsupported.genericTitle");
  const body = binary
    ? t("ui.document.unsupported.binaryBody")
    : code === "document_not_found"
      ? t("ui.document.unsupported.missingBody")
      : detail;
  return (
    <div className="doc-unsupported" role="alert">
      <div className="doc-unsupported-icon" aria-hidden="true">
        {binary ? "🗎" : "⚠"}
      </div>
      <div className="doc-unsupported-title">{title}</div>
      <div className="doc-unsupported-body">{body}</div>
      <div className="doc-unsupported-path">{path}</div>
      {binary ? (
        <div className="doc-unsupported-actions">
          <button
            className="btn small primary"
            onClick={() =>
              void api.openWithDefaultApp(path).catch((e) => {
                toast(t("ui.sidebar.openFailed", { detail: errorText(e) }), "error");
              })
            }
          >
            {t("ui.document.unsupported.openDefault")}
          </button>
          <button
            className="btn small ghost"
            onClick={() => void api.revealInFileManager(path).catch(() => {})}
          >
            {t("ui.document.unsupported.reveal")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function DocumentPanel() {
  const { t } = useTranslation("shell");
  const target = useStore((state) => state.openDocument);
  const width = useStore((state) => state.docPanelWidth);
  const expanded = useStore((state) => state.docPanelExpanded);
  const explorerOpen = useStore((state) => state.explorerOpen);
  const [doc, setDoc] = useState<SessionDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    text: string;
    startLine: number | null;
    endLine: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [mode, setMode] = useState<"raw" | "preview">("raw");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const loadedRequestPathRef = useRef<string | null>(null);
  const revealedTargetRef = useRef<object | null>(null);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const markdown = target ? isMarkdownPath(target.path) : false;
  const targetPath = target?.path ?? null;
  const targetLine = target?.line ?? null;
  const activeSession = useStore((state) =>
    findSession(state.projects, state.activeSessionId),
  );

  // Selections belong to a specific file; drop them when switching documents.
  useEffect(() => {
    setSelection(null);
  }, [targetPath]);

  // Default to the rendered preview for Markdown documents and the raw view
  // for everything else, re-evaluated for each newly opened file.
  useEffect(() => {
    setMode(targetPath && isMarkdownPath(targetPath) ? "preview" : "raw");
  }, [targetPath]);

  useEffect(() => {
    if (!targetPath) {
      loadedRequestPathRef.current = null;
      revealedTargetRef.current = null;
      setDoc(null);
      setError(null);
      setErrorCode(null);
      return;
    }
    let stale = false;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    // Try the literal link target first, then punctuation-trimmed fallbacks:
    // agents print paths inside prose, so a link can carry trailing sentence
    // characters that are not part of the real file name.
    (async () => {
      let lastError: unknown = null;
      for (const candidate of [targetPath, ...documentPathFallbacks(targetPath)]) {
        try {
          const result = await api.readSessionDocument(candidate);
          if (!stale) {
            loadedRequestPathRef.current = targetPath;
            setDoc(result);
            setDraft(result.content);
          }
          return;
        } catch (e) {
          lastError = e;
          // Only "not found" justifies trying the next candidate; problems
          // like binary content apply to the real file too.
          if (runtimeMessageEnvelope(e)?.code !== "document_not_found") break;
        }
      }
      if (stale) return;
      setDoc(null);
      setError(errorText(lastError));
      setErrorCode(runtimeMessageEnvelope(lastError)?.code ?? null);
    })().finally(() => {
      if (!stale) setLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [targetPath, reloadToken]);

  // Reveal the `path:line` target in the raw editor once content is in:
  // place the caret at the line start and scroll it into view.
  useEffect(() => {
    if (
      mode !== "raw" ||
      !target ||
      !targetLine ||
      !doc ||
      loadedRequestPathRef.current !== targetPath ||
      revealedTargetRef.current === target
    )
      return;
    const textarea = editorRef.current;
    if (!textarea) return;
    let offset = 0;
    let line = 1;
    while (line < targetLine) {
      const next = doc.content.indexOf("\n", offset);
      if (next === -1) return;
      offset = next + 1;
      line += 1;
    }
    revealedTargetRef.current = target;
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(
      0,
      (targetLine - 1) * lineHeight - textarea.clientHeight / 2,
    );
  }, [mode, target, targetPath, targetLine, doc]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const viewportMax = Math.floor(window.innerWidth * MAX_DOC_PANEL_RATIO);
      const next = start.width + (start.x - event.clientX);
      setState({
        docPanelWidth: Math.round(
          Math.min(viewportMax, Math.max(MIN_DOC_PANEL_WIDTH, next)),
        ),
      });
    };
    const onEnd = () => {
      dragStart.current = null;
      document.body.classList.remove("is-resizing-split");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, []);

  const openMarkdownLink = useCallback(
    (href: string) => {
      void api.openExternalUrl(href).catch((e) => {
        toast(t("ui.sidebar.openFailed", { detail: errorText(e) }), "error");
      });
    },
    [t],
  );

  const dirty = doc !== null && draft !== doc.content;
  // Report unsaved edits so a document-link click can ask before replacing
  // this file (documents.ts owns the confirmation flow).
  useEffect(() => {
    registerDocumentDirtyChecker(() => dirty);
    return () => registerDocumentDirtyChecker(null);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!doc || saving || draft === doc.content) return;
    setSaving(true);
    try {
      // Preserve the file's original line-ending style.
      const payload = doc.content.includes("\r\n")
        ? draft.replace(/\n/g, "\r\n")
        : draft;
      const result = await api.writeSessionDocument(doc.path, payload);
      setDoc({ ...doc, content: draft, sizeBytes: result.sizeBytes });
      toast(t("ui.document.saved"), "success");
    } catch (e) {
      toast(t("ui.document.saveFailed", { detail: errorText(e) }), "error");
    } finally {
      setSaving(false);
    }
  }, [doc, draft, saving, t]);

  const confirmDiscard = useCallback(
    () =>
      dirty
        ? confirmDialog({
            title: t("ui.document.unsavedTitle"),
            body: t("ui.document.unsavedBody"),
            confirmLabel: t("ui.document.unsavedDiscard"),
            danger: true,
          })
        : Promise.resolve(true),
    [dirty, t],
  );

  const gutterLines = useMemo(() => (doc ? draft.split("\n").length : 0), [doc, draft]);

  const previewRef = useRef<HTMLDivElement>(null);

  const capturePreviewSelection = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    if (text && sel?.anchorNode && previewRef.current?.contains(sel.anchorNode)) {
      setSelection({ text, startLine: null, endLine: null });
    } else if (!text) {
      setSelection((current) => (current?.startLine === null ? null : current));
    }
  }, []);

  const insertSelection = useCallback(() => {
    if (!selection || !activeSession) return;
    const text = formatSelectionReference({
      path: doc?.path ?? target?.path ?? "",
      startLine: selection.startLine,
      endLine: selection.endLine,
      text: selection.text,
      adapter: activeSession.adapter,
    });
    if (!insertTextIntoTerminal(activeSession.id, text)) {
      toast(t("ui.document.dropFailed"), "error");
    }
  }, [selection, activeSession, doc, target, t]);

  const selectionLineCount = selection ? selection.text.split("\n").length : 0;

  if (!target && !explorerOpen) return null;

  // Prefer the backend-canonical path (also reflects a fallback hit).
  const effectivePath = doc?.path ?? target?.path ?? "";

  // Tree-only mode (explorer open, no file picked yet): show just the tree
  // column at its natural width — the editor area appears once a file opens.
  const treeOnly = !target;

  return (
    <aside
      className={`doc-panel${expanded ? " expanded" : ""}${treeOnly ? " tree-only" : ""}`}
      style={!treeOnly && !expanded ? { width } : undefined}
      aria-label={t("ui.document.label")}
    >
      {expanded || treeOnly ? null : (
        <div
          className="doc-panel-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ui.document.resize")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStart.current = { x: event.clientX, width };
            document.body.classList.add("is-resizing-split");
          }}
        />
      )}
      {target ? (
      <div className="doc-editor-column">
        <>
            <div className="doc-panel-header">
        <span className="doc-panel-name" data-tip={effectivePath}>
          {fileName(effectivePath)}
          {dirty ? <span className="doc-dirty-dot" aria-label={t("ui.document.unsaved")} /> : null}
        </span>
        <div className="doc-panel-modes" role="tablist" aria-label={t("ui.document.modeLabel")}>
          <button
            role="tab"
            aria-selected={mode === "raw"}
            className={`doc-mode ${mode === "raw" ? "active" : ""}`}
            onClick={() => setMode("raw")}
          >
            {t("ui.document.raw")}
          </button>
          <button
            role="tab"
            aria-selected={mode === "preview"}
            className={`doc-mode ${mode === "preview" ? "active" : ""}`}
            onClick={() => setMode("preview")}
          >
            {t("ui.document.preview")}
          </button>
        </div>
        <span className="spacer" />
        {selection && activeSession?.transport === "pty" ? (
          <button
            className="btn small primary doc-quote"
            data-tip={t("ui.document.quoteSelectionTip")}
            onClick={insertSelection}
          >
            {t("ui.document.quoteSelection", { count: selectionLineCount })}
          </button>
        ) : null}
        {dirty ? (
          <button
            className="btn small primary doc-save"
            data-tip={t("ui.document.saveTip")}
            onClick={() => void save()}
            disabled={saving}
          >
            {t("ui.document.save")}
          </button>
        ) : null}
        <button
          className="btn small ghost"
          data-tip={expanded ? t("ui.document.collapseTip") : t("ui.document.expandTip")}
          aria-label={expanded ? t("ui.document.collapse") : t("ui.document.expand")}
          onClick={() => setState({ docPanelExpanded: !expanded })}
        >
          {expanded ? "⤡" : "⤢"}
        </button>
        <button
          className="btn small ghost"
          data-tip={t("ui.document.reloadTip")}
          aria-label={t("ui.document.reload")}
          onClick={() =>
            void confirmDiscard().then((ok) => {
              if (ok) setReloadToken((token) => token + 1);
            })
          }
        >
          ⟳
        </button>
        <button
          className="btn small ghost"
          data-tip={t("ui.document.revealTip")}
          aria-label={t("ui.document.reveal")}
          onClick={() => void api.revealInFileManager(effectivePath).catch(() => {})}
        >
          ⌂
        </button>
        <button
          className="btn small ghost"
          data-tip={t("ui.document.closeTip")}
          aria-label={t("ui.document.close")}
          onClick={() =>
            void confirmDiscard().then((ok) => {
              if (ok) closeDocument();
            })
          }
        >
          ✕
        </button>
      </div>
      {doc?.truncated ? (
        <div className="banner info" role="status">
          <span>{t("ui.document.truncated")}</span>
        </div>
      ) : null}
          <div className="doc-panel-body">
            {loading ? (
              <div className="doc-panel-status">{t("ui.document.loading")}</div>
            ) : error ? (
              <UnsupportedFileNotice
                code={errorCode}
                detail={error}
                path={effectivePath}
              />
            ) : doc ? (
              mode === "preview" ? (
                <div
                  ref={previewRef}
                  className="doc-preview-host"
                  onMouseUp={capturePreviewSelection}
                >
                  {markdown ? (
                    <MarkdownView source={doc.content} onLinkClick={openMarkdownLink} />
                  ) : (
                    <div className="doc-prose">{doc.content}</div>
                  )}
                </div>
              ) : (
                <div className="doc-editor">
                  <div className="doc-editor-gutter" ref={gutterRef} aria-hidden="true">
                    {Array.from({ length: gutterLines }, (_, index) => (
                      <span key={index} className="doc-editor-gutter-line">
                        {index + 1}
                      </span>
                    ))}
                  </div>
                  <textarea
                    ref={editorRef}
                    className="doc-editor-textarea"
                    value={draft}
                    readOnly={doc.truncated}
                    wrap="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    aria-label={t("ui.document.editorLabel")}
                    onChange={(event) => setDraft(event.target.value)}
                    onSelect={(event) => {
                      const el = event.currentTarget;
                      const text = el.value.slice(el.selectionStart, el.selectionEnd);
                      setSelection(
                        text
                          ? {
                              text,
                              ...computeLineRange(el.value, el.selectionStart, el.selectionEnd),
                            }
                          : null,
                      );
                    }}
                    onScroll={(event) => {
                      if (gutterRef.current) {
                        gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                      }
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                        event.preventDefault();
                        void save();
                        return;
                      }
                      // Keep Tab inside the editor instead of moving focus.
                      if (event.key === "Tab" && !doc.truncated) {
                        event.preventDefault();
                        const el = event.currentTarget;
                        el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
                        setDraft(el.value);
                      }
                    }}
                  />
                </div>
              )
            ) : null}
          </div>
          </>
      </div>
      ) : null}
      {explorerOpen ? <DocumentTree /> : null}
    </aside>
  );
}
