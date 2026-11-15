// In-app document viewer with VSCode-style tabs and up to two side-by-side
// editor groups (splits). Single clicks open italic preview tabs that the
// next preview open replaces; editing or double-clicking pins a tab. Per-tab
// state (draft, mode, load status) lives in the documents.ts runtime map so
// it survives tab switches and split moves; the shared toolbar acts on the
// active group's active tab. The raw view is an editor with a line-number
// gutter (⌘S saves back to disk); the preview view renders Markdown or
// wrapped prose read-only.

import {
  memo,
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
import { replaceSelectionUndoable, undoTextareaEdit } from "../textEdit";
import type { DocReadingTheme, OutlineItem } from "../markdownReader/types";
import { buildFindText, findMatchesIn, findTextOccurrences, rangeForMatch, rawMatchMetrics, rawMatchMetricsBatch, replaceAllOccurrences, type FindTextMap } from "../docFind";
import { getLastZoomArea } from "../fontZoom";
import DocFindBar from "./DocFindBar";
import DocToc from "./DocToc";
import ExternalLinkBubble from "./ExternalLinkBubble";
import { i18n } from "../i18n";
import { runtimeMessageEnvelope } from "../runtimeMessages";
import { insertTextIntoTerminal } from "../terminals";
import { activeSessionKey } from "../sessionIdentity";
import { computeLineRange, formatSelectionReference } from "../terminalDrop";
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
import type { SessionView } from "../types";
import DocumentTree from "./DocumentTree";

const MIN_DOC_PANEL_WIDTH = 320;
const MAX_DOC_PANEL_RATIO = 0.6;
const MIN_DOC_TREE_WIDTH = 160;
const MAX_DOC_TREE_WIDTH = 420;
/* In dual mode the editor column never gets squeezed below this by a wide
   tree. */
const MIN_DOC_EDITOR_WIDTH = 280;
/** Same overlay budget as the preview: scan up to 2000 matches but paint 500. */
const MAX_RAW_HITS = 500;

/** dataTransfer type for tab drags (reorder, cross-group move, split). */
const TAB_DND_TYPE = "application/x-agentport-doc-tab";

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

/* Drag-select auto-scroll constants: the pointer is treated as "pushing the
   edge" from EDGE px inside the editor (the panel sits flush with the
   window's right edge, so the pointer often cannot travel past it), and the
   scroll timer ticks at roughly display rate. */
const SELECT_DRAG_EDGE_PX = 24;
const SELECT_DRAG_TICK_MS = 16;

/** Scroll speed per tick grows with how far the pointer pushes past the
 * edge, clamped so a far-flung pointer does not teleport the view. */
function selectDragSpeed(overshoot: number): number {
  return Math.min(28, Math.max(3, overshoot * 0.5));
}

/* Monospace advance width via a shared canvas, measured once per font — the
   raw editor is monospace, so caret columns map linearly to pixels. */
let monoMeasureContext: CanvasRenderingContext2D | null | undefined;

function monoCharWidth(fontSize: string, fontFamily: string): number {
  if (monoMeasureContext === undefined) {
    monoMeasureContext = document.createElement("canvas").getContext("2d");
  }
  if (!monoMeasureContext) return 0;
  monoMeasureContext.font = `${fontSize} ${fontFamily}`;
  return monoMeasureContext.measureText("0").width;
}

/** Text offset of (row, col), walking newlines without allocating a
 * lines array — this runs on every auto-scroll tick on large files. */
function caretOffsetAt(text: string, row: number, col: number): number {
  let offset = 0;
  for (let line = 0; line < row; line += 1) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  const newline = text.indexOf("\n", offset);
  const lineEnd = newline === -1 ? text.length : newline;
  return Math.min(offset + col, lineEnd);
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
}: {
  code: string | null;
  detail: string;
  path: string;
}) {
  const { t } = useTranslation("shell");
  const osIntegration = useStore(canUseLocalOsIntegration);
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
  findRequest: 0,
  loadedPath: null,
  loadedToken: -1,
};

/** Saves the tab's draft back to disk, preserving the file's original
 * line-ending style. Shared by the toolbar button and the editor's ⌘S. */
async function saveDocumentTab(tabId: string): Promise<void> {
  const runtime = getDocumentTabRuntime(tabId);
  if (!runtime || !runtime.doc || runtime.saving || runtime.draft === runtime.doc.content) {
    return;
  }
  const savedDraft = runtime.draft;
  updateDocumentTabRuntime(tabId, { saving: true });
  try {
    const payload = runtime.doc.content.includes("\r\n")
      ? savedDraft.replace(/\n/g, "\r\n")
      : savedDraft;
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
  const osIntegration = useStore(canUseLocalOsIntegration);
  const tabId = tab?.id ?? null;
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
  const readingMode = useStore((state) => state.docReadingMode);
  const readingTheme = useStore((state) => state.docReadingTheme);

  if (!tab || !tabId) return null;
  const markdown = isMarkdownPath(tab.path);
  const showToc = markdown && mode === "preview" && (outline?.length ?? 0) > 0;
  const effectivePath = getDocumentTabRuntime(tabId)?.doc?.path ?? tab.path;
  const selectionLineCount = selection
    ? selection.startLine !== null && selection.endLine !== null
      ? selection.endLine - selection.startLine + 1
      : selection.text.split("\n").length
    : 0;

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
  setDragTabId,
  setDropTarget,
}: {
  tab: DocumentTab;
  groupIndex: number;
  active: boolean;
  dropBefore: boolean;
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
        if (!event.dataTransfer.types.includes(TAB_DND_TYPE)) return;
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
        if (event.dataTransfer.types.includes(TAB_DND_TYPE)) {
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
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const findLayerRef = useRef<HTMLDivElement>(null);
  const rawFindLayerRef = useRef<HTMLDivElement>(null);
  const rawFindHitsRef = useRef<HTMLDivElement>(null);
  const lastPreviewPointer = useRef({ x: 0, y: 0 });
  const replaceUndoSnapshot = useRef<string | null>(null);
  const applyingReplace = useRef(false);
  const [replaceUndoAvailable, setReplaceUndoAvailable] = useState(false);
  const [findMap, setFindMap] = useState<FindTextMap | null>(null);
  const [findMatches, setFindMatches] = useState<number[]>([]);
  const [externalLink, setExternalLink] = useState<{
    href: string;
    domain: string;
    x: number;
    y: number;
  } | null>(null);
  const readingMode = useStore((state) => state.docReadingMode);
  const readingTheme = useStore((state) => state.docReadingTheme);
  const docFontScale = useStore((state) => state.docFontScale);
  const activeFindIndex =
    findMatches.length > 0
      ? Math.min(Math.max(runtime.findIndex, 0), findMatches.length - 1)
      : 0;

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
    const element = runtime.mode === "preview" ? previewRef.current : editorRef.current;
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
  }, [runtime.doc, runtime.mode, visible]);

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
            draft: result.content,
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

  // Reveal a `path:line` target in the raw editor once the content is
  // visible: caret to the line start, scrolled into view, then the one-shot
  // request is consumed.
  useEffect(() => {
    if (!visible || runtime.mode !== "raw" || tab.pendingLine == null || !runtime.doc) {
      return;
    }
    const textarea = editorRef.current;
    if (!textarea) return;
    const targetLine = tab.pendingLine;
    clearDocumentPendingLine(tab.id);
    let offset = 0;
    let line = 1;
    while (line < targetLine) {
      const next = runtime.doc.content.indexOf("\n", offset);
      if (next === -1) return; // Line past EOF: consumed, nothing to reveal.
      offset = next + 1;
      line += 1;
    }
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(
      0,
      (targetLine - 1) * lineHeight - textarea.clientHeight / 2,
    );
  }, [visible, runtime.mode, runtime.doc, tab.pendingLine, tab.id]);

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
    if (runtime.mode === "preview" && tab.pendingLine != null) {
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
    t,
  ]);

  const syncEditorSelection = useCallback(
    (el: HTMLTextAreaElement) => {
      const text = el.value.slice(el.selectionStart, el.selectionEnd);
      updateDocumentTabRuntime(tab.id, {
        selection: text
          ? { text, ...computeLineRange(el.value, el.selectionStart, el.selectionEnd) }
          : null,
      });
    },
    [tab.id],
  );

  // Find: preview scans the rendered DOM, raw scans the draft. The preview
  // highlight overlay is painted imperatively so React never sees the marks.
  useEffect(() => {
    if (!runtime.findOpen || !runtime.findQuery || !runtime.doc) {
      setFindMap(null);
      setFindMatches([]);
      return;
    }
    if (runtime.mode === "raw") {
      setFindMap(null);
      setFindMatches(findTextOccurrences(runtime.draft, runtime.findQuery));
      return;
    }
    const host = previewRef.current;
    if (!host) return;
    const map = buildFindText(host);
    setFindMap(map);
    setFindMatches(findMatchesIn(map.text, runtime.findQuery));
  }, [runtime.findOpen, runtime.findQuery, runtime.mode, runtime.doc, runtime.draft]);

  useEffect(() => {
    const host = previewRef.current;
    const layer = findLayerRef.current;
    if (!host || !layer) return;
    layer.replaceChildren();
    if (
      runtime.mode !== "preview" ||
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
    const preview = host.querySelector(".md-preview");
    let observer: MutationObserver | null = null;
    if (preview && typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(schedule);
      observer.observe(preview, { childList: true, subtree: true, characterData: true });
    }
    let resize: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(schedule);
      resize.observe(host);
    }
    return () => {
      observer?.disconnect();
      resize?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      layer.replaceChildren();
    };
  }, [
    runtime.mode,
    runtime.findOpen,
    runtime.findQuery.length,
    findMap,
    findMatches,
    activeFindIndex,
  ]);

  useEffect(() => {
    if (
      runtime.mode !== "preview" ||
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
    runtime.findOpen,
    runtime.findQuery.length,
    findMap,
    findMatches,
    activeFindIndex,
  ]);

  useEffect(() => {
    if (runtime.mode !== "raw" || !runtime.findOpen || findMatches.length === 0) return;
    const textarea = editorRef.current;
    if (!textarea) return;
    const start = findMatches[activeFindIndex];
    if (start === undefined) return;
    // Do not focus the editor here: the find field must keep the caret while
    // the user types. Selection and scrolling still reveal the match.
    textarea.setSelectionRange(start, start + runtime.findQuery.length);
    const metrics = rawMatchMetrics(
      textarea,
      runtime.draft,
      start,
      runtime.findQuery.length,
    );
    if (metrics) {
      const margin = 24;
      const viewLeft = textarea.scrollLeft;
      const viewRight = viewLeft + textarea.clientWidth;
      if (metrics.left < viewLeft + margin) {
        textarea.scrollLeft = Math.max(0, metrics.left - margin);
      } else if (metrics.left + metrics.width > viewRight - margin) {
        textarea.scrollLeft = Math.max(
          0,
          metrics.left + metrics.width - textarea.clientWidth + margin,
        );
      }
    }
    const line = runtime.draft.slice(0, start).split("\n").length;
    const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, (line - 1) * lineHeight - textarea.clientHeight / 2);
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
    syncEditorSelection(textarea);
  }, [
    runtime.mode,
    runtime.findOpen,
    runtime.findQuery,
    runtime.draft,
    findMatches,
    activeFindIndex,
    syncEditorSelection,
  ]);

  // The textarea is not focused while searching, so an inactive selection is
  // invisible in WKWebView. Paint the active match in a read-only overlay
  // aligned with the textarea's monospace content box.
  useEffect(() => {
    const layer = rawFindLayerRef.current;
    const hits = rawFindHitsRef.current;
    const textarea = editorRef.current;
    if (!layer || !hits || !textarea) return;
    if (
      runtime.mode !== "raw" ||
      !runtime.findOpen ||
      findMatches.length === 0 ||
      !visible
    ) {
      layer.style.display = "none";
      hits.replaceChildren();
      return;
    }
    const activeStart = findMatches[activeFindIndex];
    let starts = findMatches;
    if (findMatches.length > MAX_RAW_HITS) {
      starts = Array.from(
        new Set([...findMatches.slice(0, MAX_RAW_HITS - 1), activeStart]),
      ).sort((a, b) => a - b);
    }
    const positions = rawMatchMetricsBatch(
      textarea,
      runtime.draft,
      starts,
      runtime.findQuery.length,
    );
    if (positions.length === 0) {
      layer.style.display = "none";
      hits.replaceChildren();
      return;
    }
    layer.style.display = "block";
    layer.style.left = `${textarea.offsetLeft}px`;
    layer.style.top = `${textarea.offsetTop}px`;
    layer.style.width = `${textarea.clientWidth}px`;
    layer.style.height = `${textarea.clientHeight}px`;
    hits.replaceChildren();
    for (const position of positions) {
      const hit = document.createElement("span");
      hit.className =
        position.start === activeStart
          ? "md-find-hit active md-find-raw-hit"
          : "md-find-hit md-find-raw-hit";
      hit.style.left = `${position.left}px`;
      hit.style.top = `${position.top}px`;
      hit.style.width = `${position.width}px`;
      hit.style.height = `${position.height}px`;
      hits.append(hit);
    }
    hits.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }, [
    runtime.mode,
    runtime.findOpen,
    findMatches,
    activeFindIndex,
    runtime.findQuery.length,
    runtime.draft,
    docFontScale,
    visible,
  ]);

  useEffect(() => {
    const textarea = editorRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const layer = rawFindLayerRef.current;
      const hits = rawFindHitsRef.current;
      if (!layer || !hits || layer.style.display === "none") return;
      layer.style.left = `${textarea.offsetLeft}px`;
      layer.style.top = `${textarea.offsetTop}px`;
      layer.style.width = `${textarea.clientWidth}px`;
      layer.style.height = `${textarea.clientHeight}px`;
      hits.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [runtime.mode]);

  const clearReplaceUndo = useCallback(() => {
    replaceUndoSnapshot.current = null;
    setReplaceUndoAvailable(false);
  }, []);

  const replaceCurrentMatch = useCallback(() => {
    if (runtime.mode !== "raw" || !runtime.doc || runtime.doc.truncated) return;
    if (findMatches.length === 0) return;
    const start = findMatches[activeFindIndex];
    if (start === undefined) return;
    if (!tab.pinned) pinDocumentTab(tab.id);
    const focusBefore = document.activeElement as HTMLElement | null;
    replaceUndoSnapshot.current = runtime.draft;
    const textarea = editorRef.current;
    let applied = false;
    if (textarea) {
      applyingReplace.current = true;
      try {
        applied = replaceSelectionUndoable(
          textarea,
          start,
          start + runtime.findQuery.length,
          runtime.findReplacement,
        );
      } finally {
        applyingReplace.current = false;
      }
    }
    if (applied && textarea) {
      updateDocumentTabRuntime(tab.id, { draft: textarea.value });
    } else {
      const nextDraft =
        runtime.draft.slice(0, start) +
        runtime.findReplacement +
        runtime.draft.slice(start + runtime.findQuery.length);
      updateDocumentTabRuntime(tab.id, { draft: nextDraft });
    }
    if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
    setReplaceUndoAvailable(true);
  }, [
    activeFindIndex,
    findMatches,
    runtime.doc,
    runtime.draft,
    runtime.findQuery.length,
    runtime.findReplacement,
    runtime.mode,
    tab.id,
    tab.pinned,
  ]);

  const replaceAllMatches = useCallback(() => {
    if (runtime.mode !== "raw" || !runtime.doc || runtime.doc.truncated) return;
    const result = replaceAllOccurrences(
      runtime.draft,
      runtime.findQuery,
      runtime.findReplacement,
    );
    if (result.count === 0) return;
    if (!tab.pinned) pinDocumentTab(tab.id);
    const focusBefore = document.activeElement as HTMLElement | null;
    replaceUndoSnapshot.current = runtime.draft;
    const textarea = editorRef.current;
    let applied = false;
    if (textarea) {
      applyingReplace.current = true;
      try {
        applied = replaceSelectionUndoable(
          textarea,
          0,
          textarea.value.length,
          result.text,
        );
      } finally {
        applyingReplace.current = false;
      }
    }
    if (applied && textarea) {
      textarea.setSelectionRange(0, 0);
      textarea.scrollTop = 0;
      if (gutterRef.current) gutterRef.current.scrollTop = 0;
      updateDocumentTabRuntime(tab.id, { draft: textarea.value, findIndex: 0 });
    } else {
      updateDocumentTabRuntime(tab.id, { draft: result.text, findIndex: 0 });
    }
    if (focusBefore?.isConnected) focusBefore.focus({ preventScroll: true });
    setReplaceUndoAvailable(true);
    toast(t("ui.document.replacedCount", { count: result.count }), "success");
  }, [
    runtime.doc,
    runtime.draft,
    runtime.findQuery,
    runtime.findReplacement,
    runtime.mode,
    tab.id,
    tab.pinned,
    t,
  ]);

  const undoReplace = useCallback(() => {
    const textarea = editorRef.current;
    const snapshot = replaceUndoSnapshot.current;
    const active = document.activeElement as HTMLElement | null;
    let value: string | null = null;
    if (textarea) {
      // Suppress the resulting input event from clearing the replace undo
      // state, then fall back to the snapshot when the WebView has no native
      // undo available.
      const before = textarea.value;
      applyingReplace.current = true;
      try {
        undoTextareaEdit(textarea);
      } finally {
        applyingReplace.current = false;
      }
      value = textarea.value !== before ? textarea.value : snapshot;
    }
    if (value !== null) updateDocumentTabRuntime(tab.id, { draft: value });
    active?.focus?.({ preventScroll: true });
  }, [tab.id]);

  useEffect(() => {
    if (runtime.mode !== "raw") clearReplaceUndo();
  }, [runtime.mode, clearReplaceUndo]);

  useEffect(() => {
    clearReplaceUndo();
  }, [runtime.doc?.path, runtime.doc?.content, clearReplaceUndo]);

  /* Drag-select auto-scroll. WKWebView never autoscrolls the raw editor
     while a selection drag leaves its bounds — and the panel sits flush
     with the window's right edge, so the pointer often cannot even travel
     past it. While the pointer pushes an edge we scroll on a timer and
     extend the selection to the caret under the pointer, like a native
     editor. Listeners attach on editor mousedown and detach on mouseup, so
     idle cost is zero; style metrics and the drag anchor are cached once
     per drag, and each tick is allocation-free. */
  const selectDragCleanupRef = useRef<(() => void) | null>(null);

  const armSelectDrag = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      if (event.button !== 0) return;
      selectDragCleanupRef.current?.();
      const el = event.currentTarget;
      const drag = {
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        anchor: 0,
        timer: null as number | null,
        metrics: null as {
          charWidth: number;
          lineHeight: number;
          padLeft: number;
          padTop: number;
        } | null,
      };

      const measure = () => {
        const style = getComputedStyle(el);
        drag.metrics = {
          charWidth: monoCharWidth(style.fontSize, style.fontFamily),
          lineHeight: Number.parseFloat(style.lineHeight),
          padLeft: Number.parseFloat(style.paddingLeft) || 0,
          padTop: Number.parseFloat(style.paddingTop) || 0,
        };
        // The fixed end of the in-progress selection drag.
        drag.anchor =
          el.selectionDirection === "backward" ? el.selectionEnd : el.selectionStart;
      };

      const extendSelection = () => {
        const m = drag.metrics;
        if (!m || !(m.charWidth > 0) || !(m.lineHeight > 0)) return;
        const rect = el.getBoundingClientRect();
        const col = Math.max(
          0,
          Math.round((drag.x - rect.left - m.padLeft + el.scrollLeft) / m.charWidth),
        );
        const row = Math.max(
          0,
          Math.floor((drag.y - rect.top - m.padTop + el.scrollTop) / m.lineHeight),
        );
        const offset = caretOffsetAt(el.value, row, col);
        if (offset < drag.anchor) {
          el.setSelectionRange(offset, drag.anchor, "backward");
        } else {
          el.setSelectionRange(drag.anchor, offset, "forward");
        }
        // Programmatic selection changes fire no `select` event; keep the
        // quote-selection state in sync ourselves.
        syncEditorSelection(el);
      };

      const tick = () => {
        if (drag.dx === 0 && drag.dy === 0) return;
        el.scrollLeft += drag.dx;
        el.scrollTop += drag.dy;
        extendSelection();
      };

      const cleanup = () => {
        if (drag.timer != null) window.clearInterval(drag.timer);
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", cleanup);
        window.removeEventListener("blur", cleanup);
        if (selectDragCleanupRef.current === cleanup) {
          selectDragCleanupRef.current = null;
        }
      };

      const onMove = (move: MouseEvent) => {
        if (!(move.buttons & 1)) {
          cleanup();
          return;
        }
        const rect = el.getBoundingClientRect();
        const overRight = move.clientX - (rect.right - SELECT_DRAG_EDGE_PX);
        const overLeft = rect.left + SELECT_DRAG_EDGE_PX - move.clientX;
        const overBottom = move.clientY - (rect.bottom - SELECT_DRAG_EDGE_PX);
        const overTop = rect.top + SELECT_DRAG_EDGE_PX - move.clientY;
        drag.dx =
          overRight > 0
            ? selectDragSpeed(overRight)
            : overLeft > 0
              ? -selectDragSpeed(overLeft)
              : 0;
        drag.dy =
          overBottom > 0
            ? selectDragSpeed(overBottom)
            : overTop > 0
              ? -selectDragSpeed(overTop)
              : 0;
        drag.x = move.clientX;
        drag.y = move.clientY;
        if (drag.dx === 0 && drag.dy === 0) return;
        if (drag.metrics == null) measure();
        if (drag.timer == null) {
          drag.timer = window.setInterval(tick, SELECT_DRAG_TICK_MS);
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", cleanup);
      window.addEventListener("blur", cleanup);
      selectDragCleanupRef.current = cleanup;
    },
    [syncEditorSelection],
  );

  // Switching modes or closing the tab unmounts the textarea mid-drag; drop
  // the tracking listeners with it.
  useEffect(() => () => selectDragCleanupRef.current?.(), [runtime.mode, tab.id]);

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

  const gutterLines = useMemo(
    () => (runtime.doc ? runtime.draft.split("\n").length : 0),
    [runtime.doc, runtime.draft],
  );

  // Prefer the backend-canonical path (also reflects a fallback hit).
  const effectivePath = runtime.doc?.path ?? tab.path;
  const markdown = isMarkdownPath(tab.path);

  return (
    <div className="doc-tab-body" hidden={!visible}>
      {runtime.doc ? <div className="doc-progress" ref={progressRef} aria-hidden="true" /> : null}
      {runtime.findOpen && runtime.doc ? (
        <DocFindBar
          query={runtime.findQuery}
          count={findMatches.length}
          index={activeFindIndex}
          focusRequest={runtime.findRequest}
          canReplace={runtime.mode === "raw" && !runtime.doc.truncated}
          canUndoReplace={replaceUndoAvailable}
          replacement={runtime.findReplacement}
          onReplacementChange={(findReplacement) => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, { findReplacement });
          }}
          onReplace={replaceCurrentMatch}
          onReplaceAll={replaceAllMatches}
          onUndoReplace={undoReplace}
          onChange={(query) => {
            clearReplaceUndo();
            updateDocumentTabRuntime(tab.id, { findQuery: query, findIndex: 0 });
          }}
          onPrev={() => {
            if (!findMatches.length) return;
            updateDocumentTabRuntime(tab.id, {
              findIndex: (activeFindIndex - 1 + findMatches.length) % findMatches.length,
            });
          }}
          onNext={() => {
            if (!findMatches.length) return;
            updateDocumentTabRuntime(tab.id, {
              findIndex: (activeFindIndex + 1) % findMatches.length,
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
          />
        ) : runtime.doc ? (
          runtime.mode === "preview" ? (
            <div className={`doc-reading-layout${readingMode ? " reading" : ""}`}>
              {markdown && runtime.tocOpen && (runtime.outline?.length ?? 0) > 0 ? (
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
                {markdown ? (
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
                ) : (
                  <div className="doc-prose">{runtime.doc.content}</div>
                )}
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
                value={runtime.draft}
                readOnly={runtime.doc.truncated}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={t("ui.document.editorLabel")}
                onChange={(event) => {
                  // Editing a preview tab pins it (VSCode semantics), so a
                  // dirty tab is never silently replaced by the next click.
                  if (!applyingReplace.current) clearReplaceUndo();
                  if (!tab.pinned) pinDocumentTab(tab.id);
                  updateDocumentTabRuntime(tab.id, { draft: event.target.value });
                }}
                onMouseDown={armSelectDrag}
                onSelect={(event) => syncEditorSelection(event.currentTarget)}
                onScroll={(event) => {
                  if (gutterRef.current) {
                    gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                  }
                  if (rawFindHitsRef.current) {
                    rawFindHitsRef.current.style.transform = `translate(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px)`;
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void saveDocumentTab(tab.id);
                    return;
                  }
                  // Keep Tab inside the editor instead of moving focus.
                  if (event.key === "Tab" && !runtime.doc?.truncated) {
                    event.preventDefault();
                    const el = event.currentTarget;
                    el.setRangeText("\t", el.selectionStart, el.selectionEnd, "end");
                    if (!tab.pinned) pinDocumentTab(tab.id);
                    updateDocumentTabRuntime(tab.id, { draft: el.value });
                  }
                }}
              />
              <div ref={rawFindLayerRef} className="doc-find-raw-layer" aria-hidden="true">
                <div ref={rawFindHitsRef} className="doc-find-raw-hits" />
              </div>
            </div>
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
      <div className="doc-group-body">
        {group.tabs.map((tab) => (
          <MemoDocTabEditor key={tab.id} tab={tab} visible={tab.id === group.activeTabId} />
        ))}
      </div>
      {single && dragTabId ? (
        <div
          className={`doc-split-hint${splitHot ? " hot" : ""}`}
          aria-hidden="true"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(TAB_DND_TYPE)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setSplitHot(true);
            }
          }}
          onDragLeave={() => setSplitHot(false)}
          onDrop={(event) => {
            event.preventDefault();
            const tabId = event.dataTransfer.getData(TAB_DND_TYPE) || dragTabId;
            setSplitHot(false);
            setDragTabId(null);
            setDropTarget(null);
            if (tabId) moveDocumentTab(tabId, 1);
          }}
        />
      ) : null}
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

  // Cmd/Ctrl+F opens the active document's find bar. The terminal keeps the
  // key (Ctrl+F is a normal PTY control), so only the document context
  // consumes it — last-focus tracking covers the non-focusable preview.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "f") return;
      if (getState().dialog) return;
      const target = event.target as Element | null;
      const inPanel = !!target?.closest?.(".doc-panel");
      const state = getState();
      if (!inPanel && !state.docReadingMode && getLastZoomArea() !== "doc") return;
      if (!hasOpenDocuments(state)) return;
      const tab = getActiveDocumentTab(state);
      if (!tab) return;
      event.preventDefault();
      event.stopPropagation();
      const runtime = getDocumentTabRuntime(tab.id);
      updateDocumentTabRuntime(tab.id, {
        findOpen: true,
        findRequest: (runtime?.findRequest ?? 0) + 1,
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const hasDocs = groups.length > 0;
  if (!hasDocs && !explorerOpen) return null;

  // Tree-only mode (explorer open, no file picked yet): show just the tree
  // column — the editor area appears once a file opens.
  const treeOnly = !hasDocs;
  // Tree column width: user-draggable via the sash; in docked dual mode the
  // editor keeps at least MIN_DOC_EDITOR_WIDTH regardless of the stored tree
  // width. The expanded panel is window-wide, so the stored (docked) panel
  // width must not cap the tree there.
  const effectivePanelWidth = widthAuto && panelWidth ? panelWidth : width;
  const treeBasis =
    treeOnly || expanded
      ? treeWidth
      : Math.min(
          treeWidth,
          Math.max(MIN_DOC_TREE_WIDTH, effectivePanelWidth - MIN_DOC_EDITOR_WIDTH),
        );
  const panelStyle = {
    "--doc-tree-width": `${treeBasis}px`,
    ...(treeOnly ? { width: treeBasis + 1 } : expanded || widthAuto ? {} : { width }),
  } as CSSProperties;

  return (
    <aside
      ref={attachPanel}
      className={`doc-panel${expanded ? " expanded" : ""}${treeOnly ? " tree-only" : ""}${readingMode ? " reading" : ""}${!treeOnly && !expanded && widthAuto ? " auto-width" : ""}`}
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
