// In-app document viewer with VSCode-style tabs and up to two side-by-side
// editor groups (splits). Single clicks open italic preview tabs that the
// next preview open replaces; editing or double-clicking pins a tab. Per-tab
// state (draft, mode, load status) lives in the documents.ts runtime map so
// it survives tab switches and split moves; the shared toolbar acts on the
// active group's active tab. The raw view is an editor with a line-number
// gutter (⌘S saves back to disk); the preview view renders Markdown or
// wrapped prose read-only.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { api, errorText } from "../api";
import {
  clearDocumentPendingLine,
  closeDocumentTab,
  documentPathFallbacks,
  ensureDocumentTabRuntime,
  getDocumentTabRuntime,
  isDocumentTabDirty,
  isMarkdownPath,
  moveDocumentTab,
  pinDocumentTab,
  setActiveDocumentGroup,
  setActiveDocumentTab,
  subscribeDocumentRuntime,
  updateDocumentTabRuntime,
  type DocumentTabRuntime,
} from "../documents";
import { MarkdownView } from "../markdown";
import { i18n } from "../i18n";
import { runtimeMessageEnvelope } from "../runtimeMessages";
import { insertTextIntoTerminal } from "../terminals";
import { computeLineRange, formatSelectionReference } from "../terminalDrop";
import {
  confirmDialog,
  findSession,
  getActiveDocumentTab,
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

/** dataTransfer type for tab drags (reorder, cross-group move, split). */
const TAB_DND_TYPE = "application/x-agentport-doc-tab";

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
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
    const result = await api.writeSessionDocument(runtime.doc.path, payload);
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

  if (!tab || !tabId) return null;
  const effectivePath = getDocumentTabRuntime(tabId)?.doc?.path ?? tab.path;
  const selectionLineCount = selection ? selection.text.split("\n").length : 0;

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
            if (!insertTextIntoTerminal(activeSession.id, text)) {
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
        data-tip={t("ui.document.revealTip")}
        aria-label={t("ui.document.reveal")}
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
        <DocTab
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
          const result = await api.readSessionDocument(candidate);
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
    if (text && sel?.anchorNode && previewRef.current?.contains(sel.anchorNode)) {
      updateDocumentTabRuntime(tab.id, {
        selection: { text, startLine: null, endLine: null },
      });
    } else if (!text) {
      const current = getDocumentTabRuntime(tab.id);
      if (current?.selection?.startLine === null) {
        updateDocumentTabRuntime(tab.id, { selection: null });
      }
    }
  }, [tab.id]);

  const gutterLines = useMemo(
    () => (runtime.doc ? runtime.draft.split("\n").length : 0),
    [runtime.doc, runtime.draft],
  );

  // Prefer the backend-canonical path (also reflects a fallback hit).
  const effectivePath = runtime.doc?.path ?? tab.path;
  const markdown = isMarkdownPath(tab.path);

  return (
    <div className="doc-tab-body" hidden={!visible}>
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
            <div
              ref={previewRef}
              className="doc-preview-host"
              onMouseUp={capturePreviewSelection}
            >
              {markdown ? (
                <MarkdownView
                  source={runtime.doc.content}
                  onLinkClick={(href) =>
                    void api.openExternalUrl(href).catch((e) => {
                      toast(t("ui.sidebar.openFailed", { detail: errorText(e) }), "error");
                    })
                  }
                />
              ) : (
                <div className="doc-prose">{runtime.doc.content}</div>
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
                  if (!tab.pinned) pinDocumentTab(tab.id);
                  updateDocumentTabRuntime(tab.id, { draft: event.target.value });
                }}
                onMouseDown={armSelectDrag}
                onSelect={(event) => syncEditorSelection(event.currentTarget)}
                onScroll={(event) => {
                  if (gutterRef.current) {
                    gutterRef.current.scrollTop = event.currentTarget.scrollTop;
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
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

/** One editor group: tab strip + stacked tab bodies, plus the split drop
 * hint while a tab is dragged over the panel's right edge. */
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
          <DocTabEditor key={tab.id} tab={tab} visible={tab.id === group.activeTabId} />
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
  const treeWidth = useStore((state) => state.docTreeWidth);
  const expanded = useStore((state) => state.docPanelExpanded);
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
    const onMove = (event: PointerEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const next = start.width + (start.x - event.clientX);
      if (start.tree) {
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
      });
    };
    const onEnd = () => {
      dragStart.current = null;
      setActiveSash(null);
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

  const hasDocs = groups.length > 0;
  if (!hasDocs && !explorerOpen) return null;

  // Tree-only mode (explorer open, no file picked yet): show just the tree
  // column — the editor area appears once a file opens.
  const treeOnly = !hasDocs;
  // Tree column width: user-draggable via the sash; in dual mode the editor
  // keeps at least MIN_DOC_EDITOR_WIDTH regardless of the stored tree width.
  const treeBasis = treeOnly
    ? treeWidth
    : Math.min(treeWidth, Math.max(MIN_DOC_TREE_WIDTH, width - MIN_DOC_EDITOR_WIDTH));
  const panelStyle = {
    "--doc-tree-width": `${treeBasis}px`,
    ...(treeOnly ? { width: treeBasis + 1 } : expanded ? {} : { width }),
  } as CSSProperties;

  return (
    <aside
      className={`doc-panel${expanded ? " expanded" : ""}${treeOnly ? " tree-only" : ""}`}
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
              width: treeOnly ? treeWidth : width,
              tree: treeOnly,
            };
            setActiveSash("panel");
            document.body.classList.add("is-resizing-split");
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
      {hasDocs && explorerOpen && !expanded ? (
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
