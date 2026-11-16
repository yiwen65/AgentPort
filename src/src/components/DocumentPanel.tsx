// In-app document viewer with VSCode-style tabs and up to two side-by-side
// editor groups (splits). Single clicks open italic preview tabs that the
// next preview open replaces; editing or double-clicking pins a tab. Per-tab
// state (draft, mode, load status) lives in the documents.ts runtime map so
// it survives tab switches and split moves; the shared toolbar acts on the
// active group's active tab. The raw view is an editor with a line-number
// gutter (⌘S saves back to disk); the preview view renders Markdown or
// wrapped prose read-only.

import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { api, copyText, errorText, readDocumentForDevice, writeDocumentForDevice } from "../api";
import {
  clearDocumentPendingAnchor,
  clearDocumentPendingLine,
  closeDocumentTab,
  documentPathFallbacks,
  ensureDocumentTabRuntime,
  getDocumentTabRuntime,
  isDocumentTabDirty,
  isMarkdownPath,
  moveDocumentTab,
  normalizeDocumentEol,
  openDocumentTarget,
  pinDocumentTab,
  setActiveDocumentGroup,
  setActiveDocumentTab,
  subscribeDocumentRuntime,
  updateDocumentTabRuntime,
  type DocumentTabRuntime,
} from "../documents";
import { MarkdownView } from "../markdown";
import { setDocReadingTheme } from "../docReadingPrefs";
import { relativePathInRoot, scrollToAnchor } from "../markdownReader/links";
import { rememberExternalLinkChoice, shouldConfirmExternalLink } from "../docExternalLinks";
import type { DocReadingTheme, OutlineItem } from "../markdownReader/types";
import { buildFindText, findMatchesIn, rangeForMatch, type FindTextMap } from "../docFind";
import { getLastZoomArea } from "../fontZoom";
import DocFindBar from "./DocFindBar";
import DocToc from "./DocToc";
import ExternalLinkBubble from "./ExternalLinkBubble";
import { i18n } from "../i18n";
import { runtimeMessageEnvelope } from "../runtimeMessages";
import { insertTextIntoTerminal } from "../terminals";
import { activeSessionKey } from "../sessionIdentity";
import { formatSelectionReference } from "../terminalDrop";
import { previewSelectionLineRange } from "../documentSelection";
import {
  canUseLocalOsIntegration,
  confirmDialog,
  findSession,
  getActiveDocumentTab,
  getState,
  hasOpenDocuments,
  openContextMenu,
  setState,
  toast,
  useStore,
  type MenuItem,
} from "../store";
import type { DocumentGroup, DocumentTab } from "../store";
import type { DeviceContext } from "../deviceContext";
import type { SessionView } from "../types";
import type { CodeEditorHandle, CodeSelection } from "../codeEditor/CodeEditor";
import type { ReplaceAllResult } from "../codeEditor/findController";
import { detectLanguage } from "../codeEditor/languages";
import {
  effectiveIndent,
  setDocEditorIndent,
  setDocEditorIndentStyle,
  setDocEditorTheme,
  setDocEditorWhitespace,
  setDocEditorWrap,
  type EditorIndentStyle,
  type EditorIndentWidth,
} from "../codeEditor/editorPrefs";
import {
  EDITOR_THEME_OPTIONS,
  resolveEditorTheme,
  type EditorThemePref,
} from "../codeEditor/themePref";
import { fetchGitLineMarks } from "../codeEditor/gitGutterSource";
import type { EditorFindOptions } from "../codeEditor/findController";
import DocumentTree from "./DocumentTree";

const LazyCodeEditor = lazy(() => import("../codeEditor/CodeEditor"));
const CODE_EDITOR_LARGE_FILE_BYTES = 512 * 1024;
/* Above this many characters a Markdown preview starts as a virtualized
   read-only source view; the rich reader is one click away. */
const RICH_MARKDOWN_SOURCE_LIMIT = 256 * 1024;
/* A remark/React render at this size would stall the renderer for seconds,
   so beyond it the source view is the only preview. */
const RICH_MARKDOWN_RENDER_LIMIT = 2 * 1024 * 1024;

const EDITOR_THEME_LABEL_KEYS = {
  follow: "ui.document.editorThemeFollow",
  "github-light-default": "ui.document.editorThemeGithubLight",
  "github-dark-default": "ui.document.editorThemeGithubDark",
  "min-light": "ui.document.editorThemeMinLight",
  "vitesse-dark": "ui.document.editorThemeVitesseDark",
} as const satisfies Record<EditorThemePref, string>;

const MIN_DOC_PANEL_WIDTH = 320;
const MAX_DOC_PANEL_RATIO = 0.6;
const MIN_DOC_TREE_WIDTH = 160;
const MAX_DOC_TREE_WIDTH = 420;
/* In dual mode the editor column never gets squeezed below this by a wide
   tree. */
const MIN_DOC_EDITOR_WIDTH = 280;
const DOC_TREE_SASH_WIDTH = 5;

/** dataTransfer type for tab drags (reorder, cross-group move, split). */
const TAB_DND_TYPE = "application/x-agentport-doc-tab";
/* Rightmost share of a single group that turns a tab drop into a split;
   mirrors the .doc-split-hint width. */
const SPLIT_DROP_RATIO = 0.42;

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** Paint match rectangles into the read-only overlay. Positions are converted
 * to the host's scroll-content coordinates so scrolling needs no repaint. */
function paintFindLayer(
  layer: HTMLElement,
  host: HTMLElement,
  map: FindTextMap,
  matches: number[],
  active: number,
  queryLength: number,
): void {
  layer.replaceChildren();
  if (typeof Range === "undefined") return;
  const hostRect = host.getBoundingClientRect();
  const limit = Math.min(matches.length, 500);
  for (let index = 0; index < limit; index += 1) {
    const range = rangeForMatch(map, matches[index], queryLength);
    if (!range || typeof range.getClientRects !== "function") continue;
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 && rect.height <= 0) continue;
      const hit = document.createElement("span");
      hit.className = index === active ? "md-find-hit active" : "md-find-hit";
      hit.style.top = `${rect.top - hostRect.top + host.scrollTop}px`;
      hit.style.left = `${rect.left - hostRect.left + host.scrollLeft}px`;
      hit.style.width = `${rect.width}px`;
      hit.style.height = `${rect.height}px`;
      layer.append(hit);
    }
  }
}

/* Compact preview-mode glyph: the mode tab strip shares the toolbar with the
   action buttons, so the wide "Preview" label truncated on narrow panels.
   The eye reads as "rendered view" at any width. */
function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.7 8s1.9-3.9 6.3-3.9S14.3 8 14.3 8 12.4 11.9 8 11.9 1.7 8 1.7 8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconOutline() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3 4h4M6 8h4M3 12h6M11 4h2M11 8h2M11 12h2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.4c1.6-.5 3.1-.3 4.4.6v8.6c-1.3-.9-2.8-1.1-4.4-.6V3.4Zm11 0c-1.6-.5-3.1-.3-4.4.6v8.6c1.3-.9 2.8-1.1 4.4-.6V3.4Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Friendly empty state for files the viewer cannot display. Binary files
 * (PDF, images, archives, …) get an explanation plus actions to open the
 * file with the system default app or reveal it in the file manager. */
function UnsupportedFileNotice({
  code,
  detail,
  path,
  device,
}: {
  code: string | null;
  detail: string;
  path: string;
  device?: DeviceContext;
}) {
  const { t } = useTranslation("shell");
  const activeOsIntegration = useStore(canUseLocalOsIntegration);
  // The notice belongs to the document, so its device decides whether a path
  // can be revealed here — not whichever device is active now.
  const osIntegration = device ? device.kind === "local" : activeOsIntegration;
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
            disabled={!osIntegration}
            title={osIntegration ? undefined : t("ui.document.remoteOsIntegration")}
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
            disabled={!osIntegration}
            title={osIntegration ? undefined : t("ui.document.remoteOsIntegration")}
            onClick={() => void api.revealInFileManager(path).catch(() => {})}
          >
            {t("ui.document.unsupported.reveal")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Snapshot returned when a tab's runtime is already dropped (the tab is
 * being closed and this render is the last one before unmount). */
const EMPTY_RUNTIME: DocumentTabRuntime = {
  doc: null,
  draft: "",
  eol: "lf",
  loading: false,
  error: null,
  errorCode: null,
  mode: "raw",
  reloadToken: 0,
  saving: false,
  selection: null,
  outline: null,
  tocOpen: false,
  findOpen: false,
  findQuery: "",
  findReplacement: "",
  findIndex: 0,
  findCaseSensitive: false,
  findRegex: false,
  findWholeWord: false,
  findRequest: 0,
  findReplaceRequest: 0,
  gotoOpen: false,
  gotoRequest: null,
  loadedPath: null,
  loadedToken: -1,
};

/** Saves the tab's draft back to disk, preserving the file's original
 * line-ending style. Shared by the toolbar button and the editor's ⌘S. */
async function saveDocumentTab(tabId: string): Promise<void> {
  const runtime = getDocumentTabRuntime(tabId);
  if (
    !runtime ||
    !runtime.doc ||
    runtime.saving ||
    normalizeDocumentEol(runtime.draft) === normalizeDocumentEol(runtime.doc.content)
  ) {
    return;
  }
  const savedDraft = runtime.draft;
  updateDocumentTabRuntime(tabId, { saving: true });
  try {
    const payload =
      runtime.eol === "crlf" ? savedDraft.replace(/\n/g, "\r\n") : savedDraft;
    const result = await writeDocumentForDevice(runtime.doc.path, payload, runtime.imageContext?.device);
    const current = getDocumentTabRuntime(tabId);
    if (current?.doc) {
      // Mark the saved draft as clean; keystrokes that landed during the
      // write keep the tab dirty, so a racing edit is never silently lost.
      updateDocumentTabRuntime(tabId, {
        doc: { ...current.doc, content: savedDraft, sizeBytes: result.sizeBytes },
        saving: false,
      });
    }
    toast(i18n.t("shell:ui.document.saved"), "success");
  } catch (e) {
    updateDocumentTabRuntime(tabId, { saving: false });
    toast(i18n.t("shell:ui.document.saveFailed", { detail: errorText(e) }), "error");
  }
}

/** Confirms discarding unsaved edits of the tab (reload / external flows). */
function confirmDiscardTab(tabId: string): Promise<boolean> {
  if (!isDocumentTabDirty(tabId)) return Promise.resolve(true);
  return confirmDialog({
    title: i18n.t("shell:ui.document.unsavedTitle"),
    body: i18n.t("shell:ui.document.unsavedBody"),
    confirmLabel: i18n.t("shell:ui.document.unsavedDiscard"),
    danger: true,
  });
}

/** Shared toolbar: bound to the active group's active tab. The file name
 * lives on the tab itself, so this row keeps only the view-mode switch and
 * the per-tab actions. */
function DocToolbar({
  tab,
  expanded,
  activeSession,
}: {
  tab: DocumentTab | null;
  expanded: boolean;
  activeSession: SessionView | null;
}) {
  const { t } = useTranslation("shell");
  const tabId = tab?.id ?? null;
  const activeOsIntegration = useStore(canUseLocalOsIntegration);
  // A document keeps the origin it was opened from; revealing/opening it
  // natively is only meaningful when that origin is this computer.
  const osIntegration = tab?.imageContext
    ? tab.imageContext.device.kind === "local"
    : activeOsIntegration;
  const mode = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.mode ?? "raw") : "raw",
  );
  const dirty = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? isDocumentTabDirty(tabId) : false,
  );
  const saving = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.saving ?? false) : false,
  );
  const selection = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.selection ?? null) : null,
  );
  const outline = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.outline ?? null) : null,
  );
  const tocOpen = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.tocOpen ?? false) : false,
  );
  const findOpen = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.findOpen ?? false) : false,
  );
  const findRequest = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.findRequest ?? 0) : 0,
  );
  const gotoOpen = useSyncExternalStore(subscribeDocumentRuntime, () =>
    tabId ? (getDocumentTabRuntime(tabId)?.gotoOpen ?? false) : false,
  );
  const readingMode = useStore((state) => state.docReadingMode);
  const readingTheme = useStore((state) => state.docReadingTheme);
  const editorTheme = useStore((state) => state.docEditorTheme);
  const editorIndent = useStore((state) => state.docEditorIndent);
  const editorIndentStyle = useStore((state) => state.docEditorIndentStyle);
  const editorWrap = useStore((state) => state.docEditorWrap);
  const editorWhitespace = useStore((state) => state.docEditorWhitespace);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [gotoValue, setGotoValue] = useState("");
  const settingsRef = useRef<HTMLDivElement>(null);
  const gotoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settingsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [settingsOpen]);

  useEffect(() => {
    if (!gotoOpen) {
      setGotoValue("");
      return;
    }
    gotoInputRef.current?.focus();
    gotoInputRef.current?.select();
  }, [gotoOpen]);

  if (!tab || !tabId) return null;
  const markdown = isMarkdownPath(tab.path);
  const codeSurface = mode === "raw" || (mode === "preview" && !markdown);
  const showToc = markdown && mode === "preview" && (outline?.length ?? 0) > 0;
  const effectivePath = getDocumentTabRuntime(tabId)?.doc?.path ?? tab.path;
  const selectionLineCount = selection
    ? selection.startLine !== null && selection.endLine !== null
      ? selection.endLine - selection.startLine + 1
      : selection.text.split("\n").length
    : 0;

  const submitGoto = () => {
    const line = Number(gotoValue);
    if (!Number.isFinite(line) || line < 1) {
      updateDocumentTabRuntime(tabId, { gotoOpen: false });
      return;
    }
    updateDocumentTabRuntime(tabId, {
      gotoOpen: false,
      gotoRequest: { line: Math.round(line), token: Date.now() },
    });
    setGotoValue("");
  };

  return (
    <div className="doc-panel-header">
      <div className="doc-panel-modes" role="tablist" aria-label={t("ui.document.modeLabel")}>
        <button
          role="tab"
          aria-selected={mode === "raw"}
          className={`doc-mode ${mode === "raw" ? "active" : ""}`}
          onClick={() => updateDocumentTabRuntime(tabId, { mode: "raw" })}
        >
          {t("ui.document.raw")}
        </button>
        <button
          role="tab"
          aria-selected={mode === "preview"}
          className={`doc-mode doc-mode-icon ${mode === "preview" ? "active" : ""}`}
          data-tip={t("ui.document.preview")}
          aria-label={t("ui.document.preview")}
          onClick={() => updateDocumentTabRuntime(tabId, { mode: "preview" })}
        >
          <IconEye />
        </button>
      </div>
      {mode === "preview" ? (
        <select
          className="doc-theme-select"
          value={readingTheme}
          aria-label={t("ui.document.readingTheme")}
          data-tip={t("ui.document.readingTheme")}
          onChange={(event) => setDocReadingTheme(event.target.value as DocReadingTheme)}
        >
          <option value="terminal">{t("ui.document.readingThemeTerminal")}</option>
          <option value="paper">{t("ui.document.readingThemePaper")}</option>
          <option value="night">{t("ui.document.readingThemeNight")}</option>
        </select>
      ) : null}
      {codeSurface ? (
        <div className="doc-editor-tools" ref={settingsRef}>
          <button
            className="btn small ghost"
            data-tip={t("ui.document.editorSettings")}
            aria-label={t("ui.document.editorSettings")}
            aria-pressed={settingsOpen}
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            Aa
          </button>
          {settingsOpen ? (
            <div
              className="doc-editor-settings-panel"
              role="dialog"
              aria-label={t("ui.document.editorSettings")}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSettingsOpen(false);
              }}
            >
              <label className="doc-editor-settings-row">
                <span>{t("ui.document.editorTheme")}</span>
                <select
                  value={editorTheme}
                  onChange={(event) =>
                    setDocEditorTheme(event.target.value as EditorThemePref)
                  }
                >
                  {EDITOR_THEME_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {t(EDITOR_THEME_LABEL_KEYS[option])}
                    </option>
                  ))}
                </select>
              </label>
              <label className="doc-editor-settings-row">
                <span>{t("ui.document.editorIndent")}</span>
                <select
                  value={String(editorIndent)}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDocEditorIndent(
                      value === "auto" ? "auto" : (Number(value) as EditorIndentWidth),
                    );
                  }}
                >
                  <option value="auto">{t("ui.document.editorIndentAuto")}</option>
                  <option value="2">2</option>
                  <option value="4">4</option>
                  <option value="8">8</option>
                </select>
              </label>
              <label className="doc-editor-settings-row">
                <span>{t("ui.document.editorIndentStyle")}</span>
                <select
                  value={editorIndentStyle}
                  onChange={(event) =>
                    setDocEditorIndentStyle(event.target.value as EditorIndentStyle)
                  }
                >
                  <option value="auto">{t("ui.document.editorIndentStyleAuto")}</option>
                  <option value="spaces">{t("ui.document.editorIndentSpaces")}</option>
                  <option value="tabs">{t("ui.document.editorIndentTabs")}</option>
                </select>
              </label>
              <label className="doc-editor-settings-check">
                <input
                  type="checkbox"
                  checked={editorWrap}
                  onChange={(event) => setDocEditorWrap(event.target.checked)}
                />
                <span>{t("ui.document.wordWrap")}</span>
              </label>
              <label className="doc-editor-settings-check">
                <input
                  type="checkbox"
                  checked={editorWhitespace}
                  onChange={(event) => setDocEditorWhitespace(event.target.checked)}
                />
                <span>{t("ui.document.showWhitespace")}</span>
              </label>
            </div>
          ) : null}
          <div className="doc-goto-wrap">
            <button
              className="btn small ghost"
              data-tip={t("ui.document.goToLine")}
              aria-label={t("ui.document.goToLine")}
              aria-pressed={gotoOpen}
              onClick={() =>
                updateDocumentTabRuntime(tabId, { gotoOpen: !gotoOpen })
              }
            >
              ↦
            </button>
            {gotoOpen ? (
              <div className="doc-goto-line">
                <input
                  ref={gotoInputRef}
                  className="doc-goto-input"
                  type="number"
                  min={1}
                  value={gotoValue}
                  placeholder={t("ui.document.goToLinePlaceholder")}
                  aria-label={t("ui.document.goToLinePlaceholder")}
                  onChange={(event) => setGotoValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      submitGoto();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      updateDocumentTabRuntime(tabId, { gotoOpen: false });
                    }
                  }}
                />
                <button
                  type="button"
                  className="doc-find-text-btn"
                  onClick={submitGoto}
                >
                  ↵
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <span className="spacer" />
      {selection && activeSession?.transport === "pty" ? (
        <button
          className="btn small primary doc-quote"
          data-tip={t("ui.document.quoteSelectionTip")}
          onClick={() => {
            const text = formatSelectionReference({
              path: effectivePath,
              startLine: selection.startLine,
              endLine: selection.endLine,
            });
            if (
              !insertTextIntoTerminal(
                activeSessionKey(getState()) ?? activeSession.id,
                text,
              )
            ) {
              toast(t("ui.document.dropFailed"), "error");
            }
          }}
        >
          {t("ui.document.quoteSelection", { count: selectionLineCount })}
        </button>
      ) : null}
      {dirty ? (
        <button
          className="btn small primary doc-save"
          data-tip={t("ui.document.saveTip")}
          onClick={() => void saveDocumentTab(tabId)}
          disabled={saving}
        >
          {t("ui.document.save")}
        </button>
      ) : null}
      <button
        className="btn small ghost"
        data-tip={t("ui.document.find")}
        aria-label={t("ui.document.find")}
        aria-pressed={findOpen}
        onClick={() =>
          updateDocumentTabRuntime(tabId, {
            findOpen: !findOpen,
            findRequest: findRequest + 1,
          })
        }
      >
        <IconSearch />
      </button>
      {showToc ? (
        <button
          className="btn small ghost"
          data-tip={t("ui.document.outline")}
          aria-label={t("ui.document.outline")}
          aria-pressed={tocOpen}
          onClick={() => updateDocumentTabRuntime(tabId, { tocOpen: !tocOpen })}
        >
          <IconOutline />
        </button>
      ) : null}
      <button
        className="btn small ghost"
        data-tip={t("ui.document.readingModeTip")}
        aria-label={t("ui.document.readingMode")}
        aria-pressed={readingMode}
        onClick={() => {
          if (readingMode) {
            updateDocumentTabRuntime(tabId, { tocOpen: false });
            setState({ docReadingMode: false, docPanelExpanded: false });
            return;
          }
          updateDocumentTabRuntime(tabId, {
            tocOpen: true,
            ...(markdown ? { mode: "preview" as const } : {}),
          });
          setState({ docReadingMode: true, docPanelExpanded: true });
        }}
      >
        <IconBook />
      </button>
      <button
        className="btn small ghost"
        data-tip={expanded ? t("ui.document.collapseTip") : t("ui.document.expandTip")}
        aria-label={expanded ? t("ui.document.collapse") : t("ui.document.expand")}
        onClick={() =>
          setState(
            expanded
              ? { docPanelExpanded: false, docReadingMode: false }
              : { docPanelExpanded: true },
          )
        }
      >
        {expanded ? "⤡" : "⤢"}
      </button>
      <button
        className="btn small ghost"
        data-tip={t("ui.document.reloadTip")}
        aria-label={t("ui.document.reload")}
        onClick={() =>
          void confirmDiscardTab(tabId).then((ok) => {
            if (!ok) return;
            const runtime = getDocumentTabRuntime(tabId);
            if (runtime) {
              updateDocumentTabRuntime(tabId, { reloadToken: runtime.reloadToken + 1 });
            }
          })
        }
      >
        ⟳
      </button>
      <button
        className="btn small ghost"
        data-tip={osIntegration ? t("ui.document.revealTip") : t("ui.document.remoteOsIntegration")}
        aria-label={t("ui.document.reveal")}
        disabled={!osIntegration}
        onClick={() => void api.revealInFileManager(effectivePath).catch(() => {})}
      >
        ⌂
      </button>
      <button
        className="btn small ghost"
        data-tip={t("ui.document.closeActiveTab")}
        aria-label={t("ui.document.closeActiveTab")}
        onClick={() => closeDocumentTab(tabId)}
      >
        ✕
      </button>
    </div>
  );
}

/** One tab in a group's strip. Preview tabs render italic; a dirty tab shows
 * the dot in place of the close button (VSCode style). */
function DocTab({
  tab,
  groupIndex,
  active,
  dropBefore,
  dragActive,
  setDragTabId,
  setDropTarget,
}: {
  tab: DocumentTab;
  groupIndex: number;
  active: boolean;
  dropBefore: boolean;
  dragActive: boolean;
  setDragTabId: (tabId: string | null) => void;
  setDropTarget: (
    target: { groupIndex: number; beforeTabId: string | null } | null,
  ) => void;
}) {
  const { t } = useTranslation("shell");
  const dirty = useSyncExternalStore(subscribeDocumentRuntime, () =>
    isDocumentTabDirty(tab.id),
  );
  const groupCount = useStore((state) => state.docGroups.length);

  const openTabMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const items: MenuItem[] = [];
    if (!tab.pinned) {
      items.push({ label: t("ui.document.pin"), action: () => pinDocumentTab(tab.id) });
    }
    items.push({
      label:
        groupCount > 1
          ? t("ui.document.moveToOtherGroup")
          : t("ui.document.openToSide"),
      action: () => moveDocumentTab(tab.id, groupIndex === 0 ? 1 : 0),
    });
    items.push({ label: "", separator: true });
    items.push({
      label: t("ui.document.closeTab"),
      action: () => closeDocumentTab(tab.id),
    });
    openContextMenu(event.clientX, event.clientY, items);
  };

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={fileName(tab.path)}
      tabIndex={0}
      className={`doc-tab${active ? " active" : ""}${dirty ? " dirty" : ""}${tab.pinned ? "" : " preview"}${
        dropBefore ? " drop-before" : ""
      }`}
      data-tip={tab.path}
      draggable
      onClick={() => setActiveDocumentTab(tab.id)}
      onDoubleClick={() => pinDocumentTab(tab.id)}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeDocumentTab(tab.id);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setActiveDocumentTab(tab.id);
        }
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_DND_TYPE, tab.id);
        event.dataTransfer.effectAllowed = "move";
        setDragTabId(tab.id);
      }}
      onDragEnd={() => {
        setDragTabId(null);
        setDropTarget(null);
      }}
      onDragOver={(event) => {
        // `dragTabId` is our own drag source; WKWebView's DataTransfer.types
        // hides custom MIME types (and lacks `.includes` on some builds).
        if (!dragActive) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        // Left half inserts before this tab; right half appends after it
        // (the strip maps null to the end position).
        const beforeTabId = event.clientX < rect.left + rect.width / 2 ? tab.id : null;
        setDropTarget({ groupIndex, beforeTabId });
      }}
      onContextMenu={openTabMenu}
    >
      <span className="doc-tab-name">{fileName(tab.path)}</span>
      <span className="doc-tab-status">
        {dirty ? (
          <span className="doc-dirty-dot" aria-label={t("ui.document.unsaved")} />
        ) : null}
        <button
          className="doc-tab-close"
          data-tip={t("ui.document.closeTab")}
          aria-label={t("ui.document.closeTab")}
          onClick={(event) => {
            event.stopPropagation();
            closeDocumentTab(tab.id);
          }}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/** A group's tab strip: also the drop target for reordering and for moves
 * arriving from the other group. */
const MemoDocTab = memo(DocTab);

function DocTabStrip({
  group,
  groupIndex,
  dragTabId,
  setDragTabId,
  dropTarget,
  setDropTarget,
}: {
  group: DocumentGroup;
  groupIndex: number;
  dragTabId: string | null;
  setDragTabId: (tabId: string | null) => void;
  dropTarget: { groupIndex: number; beforeTabId: string | null } | null;
  setDropTarget: (
    target: { groupIndex: number; beforeTabId: string | null } | null,
  ) => void;
}) {
  const { t } = useTranslation("shell");
  return (
    <div
      className="doc-tabs"
      role="tablist"
      aria-label={t("ui.document.tabs")}
      onDragOver={(event) => {
        if (dragTabId) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        const tabId = event.dataTransfer.getData(TAB_DND_TYPE) || dragTabId;
        const target = dropTarget?.groupIndex === groupIndex ? dropTarget : null;
        setDragTabId(null);
        setDropTarget(null);
        if (tabId) moveDocumentTab(tabId, groupIndex, target?.beforeTabId ?? null);
      }}
    >
      {group.tabs.map((tab) => (
        <MemoDocTab
          key={tab.id}
          tab={tab}
          groupIndex={groupIndex}
          active={tab.id === group.activeTabId}
          dropBefore={dropTarget?.groupIndex === groupIndex && dropTarget.beforeTabId === tab.id}
          dragActive={dragTabId !== null}
          setDragTabId={setDragTabId}
          setDropTarget={setDropTarget}
        />
      ))}
    </div>
  );
}

/** The raw editor / rendered preview for one tab. Every tab of a group stays
 * mounted (inactive ones are hidden) so DOM scroll and caret survive tab
 * switches; everything else lives in the runtime map. */
function DocTabEditor({ tab, visible }: { tab: DocumentTab; visible: boolean }) {
  const { t } = useTranslation("shell");
  useMemo(() => ensureDocumentTabRuntime(tab), [tab.id]);
  const runtime = useSyncExternalStore(
    subscribeDocumentRuntime,
    () => getDocumentTabRuntime(tab.id) ?? EMPTY_RUNTIME,
  );
  const rawEditorRef = useRef<CodeEditorHandle>(null);
  const previewEditorRef = useRef<CodeEditorHandle>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const findLayerRef = useRef<HTMLDivElement>(null);
  const lastPreviewPointer = useRef({ x: 0, y: 0 });
  const replaceActionRef = useRef(false);
  const lastCodeFindRef = useRef<{ signature: string; draft: string } | null>(null);
  const gitRequestRef = useRef(0);
  const richPreviewTimer = useRef<number | null>(null);
  const [replaceUndoAvailable, setReplaceUndoAvailable] = useState(false);
  const [findMap, setFindMap] = useState<FindTextMap | null>(null);
  const [findMatches, setFindMatches] = useState<number[]>([]);
  const [codeFind, setCodeFind] = useState({ count: 0, index: 0, invalid: false });
  const [readySurface, setReadySurface] = useState<string | null>(null);
  const [gitRefreshToken, setGitRefreshToken] = useState(0);
  const [richPreviewApproved, setRichPreviewApproved] = useState(false);
  const [richPreviewRendering, setRichPreviewRendering] = useState(false);
  const [externalLink, setExternalLink] = useState<{
    href: string;
    domain: string;
    x: number;
    y: number;
  } | null>(null);
  const readingMode = useStore((state) => state.docReadingMode);
  const readingTheme = useStore((state) => state.docReadingTheme);
  const docFontScale = useStore((state) => state.docFontScale);
  const themeEffective = useStore((state) => state.themeEffective);
  const editorThemePref = useStore((state) => state.docEditorTheme);
  const editorIndentPref = useStore((state) => state.docEditorIndent);
  const editorIndentStyle = useStore((state) => state.docEditorIndentStyle);
  const editorWrap = useStore((state) => state.docEditorWrap);
  const editorWhitespace = useStore((state) => state.docEditorWhitespace);
  const activeOsIntegration = useStore(canUseLocalOsIntegration);
  // Opening natively is only possible when the document's origin is this
  // computer; remote documents keep the action disabled.
  const osIntegration = runtime.imageContext
    ? runtime.imageContext.device.kind === "local"
    : activeOsIntegration;
  const activeFindIndex =
    findMatches.length > 0
      ? Math.min(Math.max(runtime.findIndex, 0), findMatches.length - 1)
      : 0;

  const markdown = isMarkdownPath(tab.path);
  const effectivePath = runtime.doc?.path ?? tab.path;
  const markdownText = useMemo(
    () => normalizeDocumentEol(runtime.doc?.content ?? ""),
    [runtime.doc?.content],
  );
  // Large Markdown previews start in the virtualized source view: one DOM
  // node per line would lock the renderer long before the read cap is hit.
  const largeMarkdownSource =
    markdown &&
    runtime.mode === "preview" &&
    (markdownText.length > RICH_MARKDOWN_RENDER_LIMIT ||
      (markdownText.length > RICH_MARKDOWN_SOURCE_LIMIT && !richPreviewApproved));
  const richMarkdownAvailable = markdownText.length <= RICH_MARKDOWN_RENDER_LIMIT;
  const codePreview = runtime.mode === "preview" && (!markdown || largeMarkdownSource);
  const codeSurface = runtime.mode === "raw" || codePreview;
  const activeEditorRef = runtime.mode === "raw" ? rawEditorRef : previewEditorRef;
  const surfaceKey = `${runtime.mode}:${effectivePath}`;
  const activeReady = readySurface === surfaceKey;
  const tabDirty = isDocumentTabDirty(tab.id);
  const codeLanguage = useMemo(() => {
    const firstLine = (runtime.doc?.content ?? "").split("\n", 1)[0]?.replace(/\r$/, "");
    return detectLanguage(tab.path, firstLine);
  }, [runtime.doc?.content, tab.path]);
  const largeFile =
    (runtime.doc?.sizeBytes ?? 0) > CODE_EDITOR_LARGE_FILE_BYTES ||
    (runtime.doc?.content.length ?? 0) > CODE_EDITOR_LARGE_FILE_BYTES;
  const codeThemeName = resolveEditorTheme(editorThemePref, readingTheme, themeEffective);
  const codeIndent = effectiveIndent(
    { indent: editorIndentPref, indentStyle: editorIndentStyle },
    codeLanguage,
  );
  const codeText = runtime.mode === "raw" ? runtime.draft : markdownText;
  const codeFindActive = codeSurface;
  const displayFindCount = codeFindActive ? codeFind.count : findMatches.length;
  const displayFindIndex = codeFindActive ? codeFind.index : activeFindIndex;

  const handleOutlineChange = useCallback(
    (items: OutlineItem[]) => {
      const current = getDocumentTabRuntime(tab.id);
      if (!current) return;
      const previous = current.outline;
      if (
        previous &&
        previous.length === items.length &&
        previous.every(
          (item, index) =>
            item.id === items[index].id &&
            item.level === items[index].level &&
            item.text === items[index].text &&
            item.line === items[index].line,
        )
      ) {
        return;
      }
      updateDocumentTabRuntime(tab.id, { outline: items });
    },
    [tab.id],
  );

  const handleCopyHeadingLink = useCallback(
    (text: string, id: string) => {
      const path = runtime.doc?.path ?? tab.path;
      const context = runtime.imageContext;
      const relative = context ? relativePathInRoot(path, context.rootPath) : null;
      const target = `${relative ?? path}#${id}`;
      const destination = /[\s()<>]/.test(target) ? `<${target}>` : target;
      void copyText(`[${text}](${destination})`).then((ok) => {
        if (ok) toast(t("ui.document.linkCopied"), "success");
      });
    },
    [runtime.doc?.path, runtime.imageContext, tab.path, t],
  );

  const handleOpenDocument = useCallback(
    (target: { path: string; line: number | null; anchor: string | null }) => {
      openDocumentTarget(target, { imageContext: runtime.imageContext });
    },
    [runtime.imageContext],
  );

  const handleCopyText = useCallback((text: string) => copyText(text), []);
  const handleNotice = useCallback((message: string) => toast(message, "error"), []);

  const openExternal = useCallback(
    (href: string) => {
      void api.openExternalUrl(href).catch((e) => {
        toast(t("ui.sidebar.openFailed", { detail: errorText(e) }), "error");
      });
    },
    [t],
  );

  const handleExternalLink = useCallback(
    (href: string) => {
      if (!shouldConfirmExternalLink()) {
        openExternal(href);
        return;
      }
      let domain = href;
      try {
        domain = new URL(href).hostname || href;
      } catch {
        // Keep the raw href as the label.
      }
      const point = lastPreviewPointer.current;
      setExternalLink({
        href,
        domain,
        x: point.x || window.innerWidth / 2,
        y: point.y || 120,
      });
    },
    [openExternal],
  );

  const linkContext = useMemo(
    () =>
      runtime.imageContext
        ? { path: runtime.doc?.path ?? tab.path, rootPath: runtime.imageContext.rootPath }
        : undefined,
    [runtime.doc?.path, runtime.imageContext, tab.path],
  );

  // Reading progress: write a CSS transform directly on the 2px bar so scroll
  // events never re-render the preview.
  useEffect(() => {
    if (runtime.mode !== "preview" || !markdown || largeMarkdownSource) return;
    const element = previewRef.current;
    const bar = progressRef.current;
    if (!element || !bar || !runtime.doc) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      const max = element.scrollHeight - element.clientHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, Math.max(0, element.scrollTop / max)) : 0})`;
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    update();
    element.addEventListener("scroll", schedule, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule);
      observer.observe(element);
    }
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [runtime.doc, runtime.mode, visible, markdown, largeMarkdownSource]);

  // Load the file (with punctuation-trimmed fallbacks for link targets
  // printed inside prose). Loads are guarded by (path, reloadToken) recorded
  // in the runtime, so a remount after a split move neither refetches nor
  // loses an in-flight load.
  useEffect(() => {
    const current = getDocumentTabRuntime(tab.id);
    if (!current) return;
    if (
      current.loadedPath === tab.path &&
      current.loadedToken === current.reloadToken
    ) {
      return;
    }
    const token = current.reloadToken;
    const isCurrent = () => {
      const latest = getDocumentTabRuntime(tab.id);
      return (
        latest !== null && latest.loadedToken === token && latest.loadedPath === tab.path
      );
    };
    updateDocumentTabRuntime(tab.id, {
      loading: true,
      error: null,
      errorCode: null,
      loadedPath: tab.path,
      loadedToken: token,
    });
    void (async () => {
      let lastError: unknown = null;
      for (const candidate of [tab.path, ...documentPathFallbacks(tab.path)]) {
        try {
          const result = await readDocumentForDevice(candidate, current.imageContext?.device);
          if (!isCurrent()) return;
          updateDocumentTabRuntime(tab.id, {
            doc: result,
            draft: normalizeDocumentEol(result.content),
            eol: result.content.includes("\r\n") ? "crlf" : "lf",
            loading: false,
            error: null,
            errorCode: null,
          });
          return;
        } catch (e) {
          lastError = e;
          // Only "not found" justifies trying the next candidate; problems
          // like binary content apply to the real file too.
          if (runtimeMessageEnvelope(e)?.code !== "document_not_found") break;
        }
      }
      if (!isCurrent()) return;
      updateDocumentTabRuntime(tab.id, {
        doc: null,
        loading: false,
        error: errorText(lastError),
        errorCode: runtimeMessageEnvelope(lastError)?.code ?? null,
      });
    })();
  }, [tab.id, tab.path, runtime.reloadToken]);

  // Reveal `path:line` targets in the code editor (raw or code preview).
  useEffect(() => {
    if (
      !visible ||
      !codeSurface ||
      !activeReady ||
      tab.pendingLine == null ||
      !runtime.doc
    ) {
      return;
    }
    const editor = activeEditorRef.current;
    if (!editor) return;
    const line = tab.pendingLine;
    clearDocumentPendingLine(tab.id);
    editor.revealLine(line);
  }, [
    visible,
    codeSurface,
    activeReady,
    runtime.mode,
    runtime.doc,
    tab.pendingLine,
    tab.id,
  ]);

  // Consume the toolbar / ⌘G go-to-line request.
  useEffect(() => {
    if (!codeSurface || !activeReady || !runtime.gotoRequest) return;
    const request = runtime.gotoRequest;
    updateDocumentTabRuntime(tab.id, { gotoRequest: null });
    activeEditorRef.current?.revealLine(request.line);
  }, [codeSurface, activeReady, runtime.gotoRequest, runtime.mode, tab.id]);

  // Heading anchors and `path:line` targets from Markdown links reveal in the
  // preview; a heading link switches a markdown tab back from raw first.
  useEffect(() => {
    if (!visible || !runtime.doc) return;
    if (tab.pendingAnchor) {
      if (!isMarkdownPath(tab.path)) {
        clearDocumentPendingAnchor(tab.id);
        return;
      }
      if (runtime.mode !== "preview") {
        updateDocumentTabRuntime(tab.id, { mode: "preview" });
        return;
      }
      const anchor = tab.pendingAnchor;
      clearDocumentPendingAnchor(tab.id);
      const host = previewRef.current;
      if (host && anchor && !scrollToAnchor(host, anchor, "auto")) {
        toast(t("ui.document.anchorMissing"), "error");
      }
      return;
    }
    if (
      runtime.mode === "preview" &&
      markdown &&
      !largeMarkdownSource &&
      tab.pendingLine != null
    ) {
      const line = tab.pendingLine;
      clearDocumentPendingLine(tab.id);
      const marker = previewRef.current?.querySelector<HTMLElement>(
        `[data-source-line="${line}"]`,
      );
      marker?.scrollIntoView?.({ block: "start", behavior: "auto" });
    }
  }, [
    visible,
    runtime.mode,
    runtime.doc,
    tab.pendingAnchor,
    tab.pendingLine,
    tab.id,
    tab.path,
    markdown,
    largeMarkdownSource,
    t,
  ]);

  const handleCodeSelection = useCallback(
    (selection: CodeSelection | null) => {
      updateDocumentTabRuntime(tab.id, { selection });
    },
    [tab.id],
  );

  const clearReplaceUndo = useCallback(() => {
    setReplaceUndoAvailable(false);
  }, []);

  const handleCodeChange = useCallback(
    (text: string) => {
      if (!replaceActionRef.current) clearReplaceUndo();
      if (!tab.pinned) pinDocumentTab(tab.id);
      updateDocumentTabRuntime(tab.id, { draft: text });
    },
    [clearReplaceUndo, tab.id, tab.pinned],
  );

  const handleCodeSave = useCallback(() => {
    void saveDocumentTab(tab.id);
  }, [tab.id]);

  const handleEditorReady = useCallback(() => {
    setReadySurface(surfaceKey);
  }, [surfaceKey]);

  // The rich-render opt-in belongs to the loaded document; a reload or a new
  // source starts back in the fast source view.
  useEffect(() => {
    setRichPreviewApproved(false);
    setRichPreviewRendering(false);
    if (richPreviewTimer.current !== null) {
      window.clearTimeout(richPreviewTimer.current);
      richPreviewTimer.current = null;
    }
  }, [runtime.doc?.content, tab.path]);

  useEffect(
    () => () => {
      if (richPreviewTimer.current !== null) window.clearTimeout(richPreviewTimer.current);
    },
    [],
  );

  // The outline belongs to the rich reader; the virtualized source view has no
  // rendered headings, so drop stale entries (and its toolbar toggle).
  useEffect(() => {
    if (!largeMarkdownSource) return;
    const current = getDocumentTabRuntime(tab.id);
    if (current?.outline && current.outline.length > 0) {
      updateDocumentTabRuntime(tab.id, { outline: [] });
    }
  }, [largeMarkdownSource, tab.id]);

  const requestRichPreview = useCallback(() => {
    if (!richMarkdownAvailable || richPreviewRendering) return;
    setRichPreviewRendering(true);
    if (richPreviewTimer.current !== null) window.clearTimeout(richPreviewTimer.current);
    // Paint the busy button state before the synchronous parse takes the thread.
    richPreviewTimer.current = window.setTimeout(() => {
      richPreviewTimer.current = null;
      setRichPreviewApproved(true);
      setRichPreviewRendering(false);
    }, 30);
  }, [richMarkdownAvailable, richPreviewRendering]);

  // Markdown preview find scans the rendered DOM; code surfaces drive the
  // CodeMirror controller through the editor handle. Lazy Shiki/Mermaid work,
  // theme switches and image swaps replace the preview's Text nodes, so the
  // map must be rebuilt from the live DOM instead of reused.
  useEffect(() => {
    if (!runtime.findOpen || !runtime.findQuery || !runtime.doc) {
      setFindMap(null);
      setFindMatches([]);
      return;
    }
    if (runtime.mode !== "preview" || !markdown || largeMarkdownSource) {
      setFindMap(null);
      setFindMatches([]);
      return;
    }
    const host = previewRef.current;
    if (!host) return;
    let frame: number | null = null;
    const rebuild = () => {
      frame = null;
      const map = buildFindText(host);
      setFindMap(map);
      setFindMatches(findMatchesIn(map.text, runtime.findQuery));
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(rebuild);
    };
    rebuild();
    const preview = host.querySelector(".md-preview");
    let observer: MutationObserver | null = null;
    if (preview && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(schedule);
      observer.observe(preview, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [
    runtime.findOpen,
    runtime.findQuery,
    runtime.mode,
    runtime.doc,
    markdown,
    largeMarkdownSource,
  ]);

  useEffect(() => {
    const host = previewRef.current;
    const layer = findLayerRef.current;
    if (!host || !layer) return;
    layer.replaceChildren();
    if (
      runtime.mode !== "preview" ||
      !markdown ||
      largeMarkdownSource ||
      !runtime.findOpen ||
      !findMap ||
      findMatches.length === 0
    ) {
      return;
    }
    let frame: number | null = null;
    const paint = () => {
      frame = null;
      paintFindLayer(
        layer,
        host,
        findMap,
        findMatches,
        activeFindIndex,
        runtime.findQuery.length,
      );
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(paint);
    };
    paint();
    let resize: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(schedule);
      resize.observe(host);
    }
    return () => {
      resize?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      layer.replaceChildren();
    };
  }, [
    runtime.mode,
    markdown,
    largeMarkdownSource,
    runtime.findOpen,
    runtime.findQuery.length,
    findMap,
    findMatches,
    activeFindIndex,
  ]);

  useEffect(() => {
    if (
      runtime.mode !== "preview" ||
      !markdown ||
      largeMarkdownSource ||
      !runtime.findOpen ||
      !findMap ||
      findMatches.length === 0
    ) {
      return;
    }
    const host = previewRef.current;
    if (!host) return;
    const range = rangeForMatch(
      findMap,
      findMatches[activeFindIndex],
      runtime.findQuery.length,
    );
    if (!range || typeof range.getBoundingClientRect !== "function") return;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const hostRect = host.getBoundingClientRect();
    host.scrollTop += rect.top - hostRect.top - host.clientHeight / 2 + rect.height / 2;
  }, [
    runtime.mode,
    markdown,
    largeMarkdownSource,
    runtime.findOpen,
    runtime.findQuery.length,
    findMap,
    findMatches,
    activeFindIndex,
  ]);

  // Code surfaces: debounce query/draft changes, then drive the CM search
  // controller. The editor handle owns highlighting and selection jumps.
  useEffect(() => {
    if (!codeSurface || !activeReady) return;
    const editor = activeEditorRef.current;
    if (!editor) return;
    if (!runtime.findOpen || !runtime.findQuery || (largeFile && runtime.findRegex)) {
      lastCodeFindRef.current = null;
      editor.clearFind();
      setCodeFind({ count: 0, index: 0, invalid: false });
      return;
    }
    const handle = window.setTimeout(() => {
      const signature = JSON.stringify([
        runtime.findQuery,
        runtime.findCaseSensitive,
        runtime.findRegex,
        runtime.findWholeWord,
        runtime.findIndex,
      ]);
      const previous = lastCodeFindRef.current;
      const queryChanged = previous === null || previous.signature !== signature;
      const draftChanged =
        previous !== null &&
        previous.signature === signature &&
        previous.draft !== runtime.draft;
      // Editing the document refreshes matches without pulling the caret to
      // the active match; the next keystroke would otherwise replace it.
      const moveSelection = queryChanged || !draftChanged;
      lastCodeFindRef.current = { signature, draft: runtime.draft };
      const result = editor.find({
        query: runtime.findQuery,
        caseSensitive: runtime.findCaseSensitive,
        regex: runtime.findRegex,
        wholeWord: runtime.findWholeWord,
        index: runtime.findIndex,
        moveSelection,
      });
      setCodeFind(result);
      if (
        moveSelection &&
        !result.invalid &&
        result.count > 0 &&
        result.index !== runtime.findIndex
      ) {
        updateDocumentTabRuntime(tab.id, { findIndex: result.index });
      }
    }, 120);
    return () => window.clearTimeout(handle);
  }, [
    codeSurface,
    activeReady,
    runtime.findOpen,
    runtime.findQuery,
    runtime.findCaseSensitive,
    runtime.findRegex,
    runtime.findWholeWord,
    runtime.findIndex,
    runtime.mode,
    runtime.draft,
    runtime.doc?.content,
    tab.id,
    largeFile,
  ]);

  useEffect(() => {
    if (!codeSurface) return;
    activeEditorRef.current?.requestMeasure();
  }, [docFontScale, codeSurface, runtime.mode]);

  useEffect(() => {
    if (!visible || !codeSurface) return;
    const onFocus = () => setGitRefreshToken((value) => value + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, codeSurface]);

  // Unstaged git marks for the active code surface. Marks are hidden while
  // the draft is dirty because they would point at stale line numbers.
  useEffect(() => {
    if (!visible || !codeSurface || !activeReady) return;
    const editor = activeEditorRef.current;
    if (!editor) return;
    if (tabDirty || largeFile || largeMarkdownSource || !runtime.doc) {
      editor.setGitMarks(null);
      return;
    }
    let cancelled = false;
    const token = ++gitRequestRef.current;
    void fetchGitLineMarks({
      path: runtime.doc.path,
      rootPath: runtime.imageContext?.rootPath,
      device: runtime.imageContext?.device,
    }).then((marks) => {
      if (cancelled || token !== gitRequestRef.current) return;
      editor.setGitMarks(marks.length > 0 ? marks : null);
    });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    codeSurface,
    activeReady,
    tabDirty,
    largeFile,
    largeMarkdownSource,
    runtime.doc?.path,
    runtime.doc?.content,
    runtime.imageContext,
    runtime.mode,
    gitRefreshToken,
    tab.id,
  ]);

  const applyCodeFindAfterReplace = useCallback(
    (count: number, index: number) => {
      setCodeFind({ count, index, invalid: false });
      updateDocumentTabRuntime(tab.id, { findIndex: index });
    },
    [tab.id],
  );

  const codeFindOptions = useCallback(
    (index: number): EditorFindOptions => ({
      query: runtime.findQuery,
      caseSensitive: runtime.findCaseSensitive,
      regex: runtime.findRegex,
      wholeWord: runtime.findWholeWord,
      index,
    }),
    [runtime.findCaseSensitive, runtime.findQuery, runtime.findRegex, runtime.findWholeWord],
  );

  const handleReplaceCurrent = useCallback(() => {
    if (runtime.mode !== "raw" || !runtime.doc || runtime.doc.truncated) return;
    const editor = rawEditorRef.current;
    if (!editor) return;
    if (!tab.pinned) pinDocumentTab(tab.id);
    replaceActionRef.current = true;
    try {
      const result = editor.replaceCurrent(
        codeFindOptions(runtime.findIndex),
        runtime.findReplacement,
      );
      applyCodeFindAfterReplace(result.count, result.index);
    } finally {
      replaceActionRef.current = false;
    }
    setReplaceUndoAvailable(true);
  }, [
    applyCodeFindAfterReplace,
    codeFindOptions,
    runtime.doc,
    runtime.findIndex,
    runtime.findReplacement,
    runtime.mode,
    tab.id,
    tab.pinned,
  ]);

  const handleReplaceAll = useCallback(() => {
    if (runtime.mode !== "raw" || !runtime.doc || runtime.doc.truncated) return;
    const editor = rawEditorRef.current;
    if (!editor) return;
    if (!tab.pinned) pinDocumentTab(tab.id);
    replaceActionRef.current = true;
    let result: ReplaceAllResult = { count: 0, truncated: false };
    try {
      result = editor.replaceAll(codeFindOptions(0), runtime.findReplacement);
      if (result.count > 0) applyCodeFindAfterReplace(0, 0);
    } finally {
      replaceActionRef.current = false;
    }
    if (result.count === 0) return;
    setReplaceUndoAvailable(true);
    toast(t("ui.document.replacedCount", { count: result.count }), "success");
    if (result.truncated) {
      toast(t("ui.document.replaceTruncated", { count: result.count }), "info");
    }
  }, [
    applyCodeFindAfterReplace,
    codeFindOptions,
    runtime.doc,
    runtime.findReplacement,
    runtime.mode,
    tab.id,
    tab.pinned,
    t,
  ]);

  const handleUndoReplace = useCallback(() => {
    const editor = rawEditorRef.current;
    if (!editor) return;
    replaceActionRef.current = true;
    try {
      editor.undoReplace();
    } finally {
      replaceActionRef.current = false;
    }
    setReplaceUndoAvailable(false);
  }, []);

  useEffect(() => {
    if (runtime.mode !== "raw") clearReplaceUndo();
  }, [runtime.mode, clearReplaceUndo]);

  useEffect(() => {
    clearReplaceUndo();
  }, [runtime.doc?.path, runtime.doc?.content, clearReplaceUndo]);

  const capturePreviewSelection = useCallback(() => {
    const sel = window.getSelection();
    const text = sel?.toString() ?? "";
    const preview = previewRef.current;
    const prose = preview?.querySelector(".doc-prose");
    const lines = text && sel?.rangeCount && preview
      ? previewSelectionLineRange(prose ?? preview, sel.getRangeAt(0), prose ? runtime.doc?.content : undefined)
      : null;
    updateDocumentTabRuntime(tab.id, {
      selection: text && lines ? { text, ...lines } : null,
    });
  }, [tab.id, runtime.doc]);

  const renderCodeSurface = (
    ref: typeof rawEditorRef,
    readOnly: boolean,
    sourcePreview: boolean,
  ) => (
    <div className="doc-editor doc-editor-code">
      <Suspense
        fallback={<div className="doc-panel-status">{t("ui.document.loading")}</div>}
      >
        <LazyCodeEditor
          key={surfaceKey}
          ref={ref}
          text={codeText}
          readOnly={readOnly}
          language={sourcePreview || largeFile ? null : codeLanguage}
          themeName={codeThemeName}
          wrap={editorWrap}
          whitespace={editorWhitespace}
          indentWidth={codeIndent.width}
          useSpaces={codeIndent.useSpaces}
          visible={visible}
          ariaLabel={t("ui.document.editorLabel")}
          enableFolding={!largeFile && !sourcePreview}
          enableGitGutter={!largeFile && !sourcePreview}
          enableIndentGuides={!largeFile && !sourcePreview}
          onDocChange={handleCodeChange}
          onSelectionChange={handleCodeSelection}
          onSave={handleCodeSave}
          onReady={handleEditorReady}
        />
      </Suspense>
    </div>
  );

  return (
    <div className="doc-tab-body" hidden={!visible}>
      {runtime.doc && runtime.mode === "preview" && markdown && !largeMarkdownSource ? (
        <div className="doc-progress" ref={progressRef} aria-hidden="true" />
      ) : null}
      {runtime.findOpen && runtime.doc ? (
        <DocFindBar
          query={runtime.findQuery}
          count={displayFindCount}
          index={displayFindIndex}
          focusRequest={runtime.findRequest}
          replaceFocusRequest={runtime.findReplaceRequest}
          showOptions={codeFindActive}
          caseSensitive={runtime.findCaseSensitive}
          wholeWord={runtime.findWholeWord}
          regex={runtime.findRegex}
          regexDisabled={largeFile}
          onToggleCaseSensitive={() => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, {
              findCaseSensitive: !runtime.findCaseSensitive,
              findIndex: 0,
            });
          }}
          onToggleWholeWord={() => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, {
              findWholeWord: !runtime.findWholeWord,
              findIndex: 0,
            });
          }}
          onToggleRegex={() => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, {
              findRegex: !runtime.findRegex,
              findIndex: 0,
            });
          }}
          canReplace={runtime.mode === "raw" && !runtime.doc.truncated}
          canUndoReplace={replaceUndoAvailable && codeFindActive}
          replacement={runtime.findReplacement}
          onReplacementChange={(findReplacement) => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, { findReplacement });
          }}
          onReplace={handleReplaceCurrent}
          onReplaceAll={handleReplaceAll}
          onUndoReplace={handleUndoReplace}
          onChange={(query) => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, { findQuery: query, findIndex: 0 });
          }}
          onPrev={() => {
            if (displayFindCount === 0) return;
            updateDocumentTabRuntime(tab.id, {
              findIndex:
                (displayFindIndex - 1 + displayFindCount) % displayFindCount,
            });
          }}
          onNext={() => {
            if (displayFindCount === 0) return;
            updateDocumentTabRuntime(tab.id, {
              findIndex: (displayFindIndex + 1) % displayFindCount,
            });
          }}
          onClose={() => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, { findOpen: false });
          }}
        />
      ) : null}
      {externalLink ? (
        <ExternalLinkBubble
          href={externalLink.href}
          domain={externalLink.domain}
          x={externalLink.x}
          y={externalLink.y}
          theme={readingTheme}
          onOpen={(remember) => {
            if (remember) rememberExternalLinkChoice();
            setExternalLink(null);
            openExternal(externalLink.href);
          }}
          onCopy={() => {
            void copyText(externalLink.href).then((ok) => {
              if (ok) toast(t("ui.document.linkCopied"), "success");
            });
            setExternalLink(null);
          }}
          onClose={() => setExternalLink(null)}
        />
      ) : null}
      {runtime.doc?.truncated ? (
        <div className="banner info" role="status">
          <span>{t("ui.document.truncated")}</span>
          <span className="spacer" />
          <button
            className="btn small primary"
            disabled={!osIntegration}
            title={osIntegration ? undefined : t("ui.document.remoteOsIntegration")}
            onClick={() =>
              void api.openWithDefaultApp(effectivePath).catch((e) => {
                toast(t("ui.sidebar.openFailed", { detail: errorText(e) }), "error");
              })
            }
          >
            {t("ui.document.unsupported.openDefault")}
          </button>
        </div>
      ) : null}
      <div className="doc-panel-body">
        {runtime.loading ? (
          <div className="doc-panel-status">{t("ui.document.loading")}</div>
        ) : runtime.error ? (
          <UnsupportedFileNotice
            code={runtime.errorCode}
            detail={runtime.error}
            path={effectivePath}
            device={runtime.imageContext?.device}
          />
        ) : runtime.doc ? (
          runtime.mode === "preview" ? (
            markdown ? (
              largeMarkdownSource ? (
                <div className="doc-large-preview">
                  <div className="md-large-banner" role="status" data-search-skip="true">
                    <span>{t("ui.document.largeDocumentNotice")}</span>
                    {richMarkdownAvailable ? (
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={richPreviewRendering}
                        onClick={requestRichPreview}
                      >
                        {richPreviewRendering
                          ? t("ui.document.largeDocumentRendering")
                          : t("ui.document.largeDocumentRender")}
                      </button>
                    ) : (
                      <span className="doc-large-preview-note">
                        {t("ui.document.largeDocumentSourceOnly")}
                      </span>
                    )}
                  </div>
                  {renderCodeSurface(previewEditorRef, true, true)}
                </div>
              ) : (
                <div className={`doc-reading-layout${readingMode ? " reading" : ""}`}>
                  {runtime.tocOpen && (runtime.outline?.length ?? 0) > 0 ? (
                    <DocToc
                      items={runtime.outline ?? []}
                      hostRef={previewRef}
                      variant={readingMode ? "rail" : "drawer"}
                      label={t("ui.document.outline")}
                      closeLabel={t("ui.document.closeOutline")}
                      onSelect={() => {
                        if (!readingMode) updateDocumentTabRuntime(tab.id, { tocOpen: false });
                      }}
                      onClose={
                        readingMode
                          ? undefined
                          : () => updateDocumentTabRuntime(tab.id, { tocOpen: false })
                      }
                    />
                  ) : null}
                  <div
                    ref={previewRef}
                    className="doc-preview-host"
                    onMouseUp={capturePreviewSelection}
                    onPointerDownCapture={(event) => {
                      lastPreviewPointer.current = { x: event.clientX, y: event.clientY };
                    }}
                  >
                    <MarkdownView
                      source={runtime.doc.content}
                      sourceLocations
                      imageSession={runtime.imageSession ?? undefined}
                      linkContext={linkContext}
                      readingTheme={readingTheme}
                      onOpenDocument={handleOpenDocument}
                      onOutlineChange={handleOutlineChange}
                      onCopyText={handleCopyText}
                      onCopyHeadingLink={handleCopyHeadingLink}
                      onNotice={handleNotice}
                      onLinkClick={handleExternalLink}
                    />
                    <div ref={findLayerRef} className="md-find-layer" aria-hidden="true" />
                  </div>
                  {!readingMode && runtime.tocOpen ? (
                    <button
                      type="button"
                      className="doc-toc-backdrop"
                      aria-label={t("ui.document.closeOutline")}
                      onClick={() => updateDocumentTabRuntime(tab.id, { tocOpen: false })}
                    />
                  ) : null}
                </div>
              )
            ) : (
              renderCodeSurface(previewEditorRef, true, false)
            )
          ) : (
            renderCodeSurface(rawEditorRef, runtime.doc.truncated, false)
          )
        ) : null}
      </div>
    </div>
  );
}

/** One editor group: tab strip + stacked tab bodies, plus the split drop
 * hint while a tab is dragged over the panel's right edge. */
const MemoDocTabEditor = memo(DocTabEditor);

function DocGroupView({
  group,
  groupIndex,
  isActive,
  single,
  dragTabId,
  setDragTabId,
  dropTarget,
  setDropTarget,
  splitHot,
  setSplitHot,
}: {
  group: DocumentGroup;
  groupIndex: number;
  isActive: boolean;
  single: boolean;
  dragTabId: string | null;
  setDragTabId: (tabId: string | null) => void;
  dropTarget: { groupIndex: number; beforeTabId: string | null } | null;
  setDropTarget: (
    target: { groupIndex: number; beforeTabId: string | null } | null,
  ) => void;
  splitHot: boolean;
  setSplitHot: (hot: boolean) => void;
}) {
  // The split hint is a passive overlay: mounting a fresh drop target under
  // the pointer mid-drag makes WebKit keep delivering drag events to the old
  // element, so the stable group body owns the drop and only a pointer inside
  // the hint's right-hand band splits.
  const inSplitZone = (event: React.DragEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX >= rect.left + rect.width * (1 - SPLIT_DROP_RATIO);
  };

  return (
    <section
      className={`doc-group${isActive ? " active" : ""}`}
      onPointerDown={() => setActiveDocumentGroup(groupIndex)}
    >
      <DocTabStrip
        group={group}
        groupIndex={groupIndex}
        dragTabId={dragTabId}
        setDragTabId={setDragTabId}
        dropTarget={dropTarget}
        setDropTarget={setDropTarget}
      />
      <div
        className="doc-group-body"
        onDragOver={(event) => {
          if (!single || !dragTabId) return;
          if (!inSplitZone(event)) {
            if (splitHot) setSplitHot(false);
            return;
          }
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          if (!splitHot) setSplitHot(true);
        }}
        onDragLeave={(event) => {
          if (!splitHot) return;
          const next = event.relatedTarget as Node | null;
          if (next && event.currentTarget.contains(next)) return;
          setSplitHot(false);
        }}
        onDrop={(event) => {
          if (!single || !dragTabId || !inSplitZone(event)) return;
          event.preventDefault();
          const tabId = event.dataTransfer.getData(TAB_DND_TYPE) || dragTabId;
          setSplitHot(false);
          setDragTabId(null);
          setDropTarget(null);
          if (tabId) moveDocumentTab(tabId, 1);
        }}
      >
        {group.tabs.map((tab) => (
          <MemoDocTabEditor key={tab.id} tab={tab} visible={tab.id === group.activeTabId} />
        ))}
        {single && dragTabId ? (
          <div
            className={`doc-split-hint${splitHot ? " hot" : ""}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </section>
  );
}

export default function DocumentPanel() {
  const { t } = useTranslation("shell");
  const groups = useStore((state) => state.docGroups);
  const activeGroupIndex = useStore((state) => state.activeDocGroupIndex);
  const width = useStore((state) => state.docPanelWidth);
  const widthAuto = useStore((state) => state.docPanelWidthAuto);
  const treeWidth = useStore((state) => state.docTreeWidth);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const panelObserver = useRef<ResizeObserver | null>(null);
  const widthAutoRef = useRef(widthAuto);
  widthAutoRef.current = widthAuto;
  const attachPanel = useCallback((node: HTMLElement | null) => {
    panelObserver.current?.disconnect();
    panelObserver.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (widthAutoRef.current && measured > 0) setPanelWidth(measured);
    });
    observer.observe(node);
    panelObserver.current = observer;
  }, []);
  const expanded = useStore((state) => state.docPanelExpanded);
  const readingMode = useStore((state) => state.docReadingMode);
  const readingTheme = useStore((state) => state.docReadingTheme);
  const explorerOpen = useStore((state) => state.explorerOpen);
  const activeTab = useStore((state) => getActiveDocumentTab(state));
  const activeSession = useStore((state) =>
    findSession(state.projects, state.activeSessionId),
  );
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    groupIndex: number;
    beforeTabId: string | null;
  } | null>(null);
  const [splitHot, setSplitHot] = useState(false);
  const dragStart = useRef<{ x: number; width: number; tree: boolean } | null>(null);
  // Which sash is being dragged (drives the accent line); the drag math
  // itself lives in the ref above so the window-level move handler never
  // goes stale.
  const [activeSash, setActiveSash] = useState<"panel" | "tree" | null>(null);

  useEffect(() => {
    let frame: number | null = null;
    let pendingWidth: number | null = null;
    const applyWidth = (next: number, tree: boolean) => {
      if (tree) {
        setState({
          docTreeWidth: Math.round(
            Math.min(MAX_DOC_TREE_WIDTH, Math.max(MIN_DOC_TREE_WIDTH, next)),
          ),
        });
        return;
      }
      const viewportMax = Math.floor(window.innerWidth * MAX_DOC_PANEL_RATIO);
      setState({
        docPanelWidth: Math.round(
          Math.min(viewportMax, Math.max(MIN_DOC_PANEL_WIDTH, next)),
        ),
        docPanelWidthAuto: false,
      });
    };
    const flush = () => {
      frame = null;
      const start = dragStart.current;
      if (!start || pendingWidth === null) return;
      const next = pendingWidth;
      pendingWidth = null;
      applyWidth(next, start.tree);
    };
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      pendingWidth = start.width + (start.x - event.clientX);
      if (frame === null) {
        // Apply the leading edge immediately for responsiveness, then coalesce
        // the rest of this frame's moves into one trailing write.
        const next = pendingWidth;
        pendingWidth = null;
        applyWidth(next, start.tree);
        frame = window.requestAnimationFrame(() => {
          frame = null;
          flush();
        });
      }
    };
    const onEnd = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      if (pendingWidth !== null && dragStart.current) {
        applyWidth(pendingWidth, dragStart.current.tree);
      }
      pendingWidth = null;
      dragStart.current = null;
      setActiveSash(null);
      document.body.classList.remove("is-resizing-split");
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
  }, []);

  // Document-context shortcuts: ⌘F find, ⌥⌘F (Ctrl+H elsewhere) replace,
  // ⌘G go to line. The terminal keeps Ctrl+F for the PTY; only document
  // focus (or reading mode / last zoom area) consumes these keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      const isSave = key === "s" && !event.altKey && !event.shiftKey;
      const isFind = key === "f" && !event.altKey && !event.shiftKey;
      const isReplace =
        (key === "f" && event.metaKey && event.altKey && !event.shiftKey) ||
        (key === "h" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey);
      const isGoto = key === "g" && !event.altKey && !event.shiftKey;
      if (!isSave && !isFind && !isReplace && !isGoto) return;
      if (getState().dialog) return;
      const target = event.target as Element | null;
      const inPanel = !!target?.closest?.(".doc-panel");
      const state = getState();
      if (!inPanel && !state.docReadingMode && getLastZoomArea() !== "doc") return;
      if (!hasOpenDocuments(state)) return;
      const tab = getActiveDocumentTab(state);
      if (!tab) return;
      const runtime = getDocumentTabRuntime(tab.id);
      if (!runtime) return;
      if (isGoto && runtime.mode !== "raw" && isMarkdownPath(tab.path)) return;
      event.preventDefault();
      event.stopPropagation();
      if (isSave) {
        void saveDocumentTab(tab.id);
      } else if (isFind) {
        updateDocumentTabRuntime(tab.id, {
          findOpen: true,
          findRequest: (runtime.findRequest ?? 0) + 1,
        });
      } else if (isReplace) {
        updateDocumentTabRuntime(tab.id, {
          findOpen: true,
          findReplaceRequest: (runtime.findReplaceRequest ?? 0) + 1,
        });
      } else {
        updateDocumentTabRuntime(tab.id, { gotoOpen: true, findOpen: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const hasDocs = groups.length > 0;
  // Tree-only mode (explorer open, no file picked yet): show just the tree
  // column — the editor area appears once a file opens.
  const treeOnly = !hasDocs;
  // Tree column width: user-draggable via the sash; in docked dual mode the
  // editor keeps at least MIN_DOC_EDITOR_WIDTH regardless of the stored tree
  // width. The expanded panel is window-wide, so the stored (docked) panel
  // width must not cap the tree there.
  const effectivePanelWidth = widthAuto && panelWidth ? panelWidth : width;
  const treeBasis =
    treeOnly || expanded || (widthAuto && panelWidth === null)
      ? treeWidth
      : Math.min(
          treeWidth,
          Math.max(
            MIN_DOC_TREE_WIDTH,
            effectivePanelWidth - MIN_DOC_EDITOR_WIDTH - DOC_TREE_SASH_WIDTH,
          ),
        );
  // Let the transparent title bar paint the same surface as the tree column
  // above it, ending at the tree's own edge. Tree-only mode includes the
  // panel's 1px separator; the dual-mode sash stays with the editor.
  const topbarTreeWidth = treeOnly ? treeBasis + 1 : treeBasis;
  useEffect(() => {
    const root = document.documentElement;
    if (!explorerOpen) {
      root.style.removeProperty("--doc-tree-topbar-width");
      return;
    }
    root.style.setProperty("--doc-tree-topbar-width", `${topbarTreeWidth}px`);
    return () => {
      root.style.removeProperty("--doc-tree-topbar-width");
    };
  }, [explorerOpen, topbarTreeWidth]);

  if (!hasDocs && !explorerOpen) return null;

  const panelStyle = {
    "--doc-tree-width": `${treeBasis}px`,
    ...(treeOnly ? { width: treeBasis + 1 } : expanded || widthAuto ? {} : { width }),
  } as CSSProperties;

  return (
    <aside
      ref={attachPanel}
      className={`doc-panel${expanded ? " expanded" : ""}${treeOnly ? " tree-only" : ""}${readingMode ? " reading" : ""}${!treeOnly && !expanded && widthAuto ? ` auto-width${explorerOpen ? " with-tree" : ""}` : ""}`}
      data-doc-theme={readingTheme}
      style={panelStyle}
      aria-label={t("ui.document.label")}
    >
      {expanded ? null : (
        <div
          className={`doc-panel-resize${activeSash === "panel" ? " active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ui.document.resize")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragStart.current = {
              x: event.clientX,
              width: treeOnly
                ? treeWidth
                : widthAuto
                  ? (panelWidth ?? width)
                  : width,
              tree: treeOnly,
            };
            setActiveSash("panel");
            document.body.classList.add("is-resizing-split");
          }}
          onDoubleClick={() => {
            if (!treeOnly) setState({ docPanelWidthAuto: true });
          }}
        />
      )}
      {hasDocs ? (
        <div className="doc-editor-column">
          <DocToolbar tab={activeTab} expanded={expanded} activeSession={activeSession} />
          <div className="doc-groups">
            {groups.map((group, index) => (
              <DocGroupView
                key={index}
                group={group}
                groupIndex={index}
                isActive={index === activeGroupIndex}
                single={groups.length === 1}
                dragTabId={dragTabId}
                setDragTabId={setDragTabId}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
                splitHot={splitHot}
                setSplitHot={setSplitHot}
              />
            ))}
          </div>
        </div>
      ) : null}
      {hasDocs && explorerOpen ? (
        <div
          className={`doc-tree-resize${activeSash === "tree" ? " active" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("ui.document.resizeTree")}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            // Dual mode: this inner sash drives the tree column directly.
            dragStart.current = { x: event.clientX, width: treeWidth, tree: true };
            setActiveSash("tree");
            document.body.classList.add("is-resizing-split");
          }}
        />
      ) : null}
      {explorerOpen ? <DocumentTree /> : null}
    </aside>
  );
}
