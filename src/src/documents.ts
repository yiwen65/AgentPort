// Document links in terminal output (OSC 8 `file://` hyperlinks and plain
// absolute or session-relative paths) open in the in-app viewer instead of an
// external app, like clicking a file link in VSCode's terminal.

import { confirmDialog, findSession, getState, setState } from "./store";
import type { DocumentGroup, DocumentTab } from "./store";
import type { SessionDocument } from "./types";
import { i18n } from "./i18n";
import { MarkdownImageSession, type MarkdownImageContext } from "./markdownImages";
import type { OutlineItem } from "./markdownReader/types";
import { sameDeviceContext, type DeviceContext } from "./deviceContext";
import { deviceKeyForContext, LOCAL_DEVICE_KEY } from "./sessionIdentity";

export interface DocumentLinkTarget {
  path: string;
  /** One-based line from a trailing `:line[:column]` suffix. */
  line: number | null;
  /** Heading anchor from a `#fragment` suffix. */
  anchor?: string | null;
}

/**
 * Parses a link target into an absolute path plus an optional line number.
 * Accepts `file://` URIs, plain POSIX absolute paths, and relative paths when
 * an absolute session cwd is supplied. Returns null for web URLs, unresolved
 * relative paths, and non-local file hosts.
 */
export function parseDocumentLinkTarget(
  raw: string,
  sessionCwd?: string,
): DocumentLinkTarget | null {
  let text = raw.trim();
  if (!text) return null;

  if (/^file:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    // Only local files; a remote host would not resolve in this app.
    if (url.hostname && url.hostname !== "localhost") return null;
    try {
      text = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) {
    // Some other scheme (http:, vscode:, …) — not a local document.
    return null;
  }

  const relative = !text.startsWith("/");

  // Strip a trailing `:line` or `:line:column` suffix. Only digit groups are
  // treated as positions, so paths containing real colons survive.
  let line: number | null = null;
  const position = /:(\d+)(?::(\d+))?$/.exec(text);
  if (position) {
    const parsed = Number.parseInt(position[1], 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      line = parsed;
      text = text.slice(0, position.index);
    }
  }
  if (relative) {
    if (!sessionCwd?.startsWith("/")) return null;
    const segments = `${sessionCwd}/${text}`.split("/");
    const normalized: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") continue;
      if (segment === "..") normalized.pop();
      else normalized.push(segment);
    }
    text = `/${normalized.join("/")}`;
  }

  if (text.length < 2) return null;
  return { path: text, line };
}

/* ------------------------------------------------------------------ *
 * Tab/split model.
 *
 * The viewer holds up to two side-by-side groups, each with its own tab
 * strip. Terminal document links open a VSCode-style preview tab —
 * italic, replaced by the next preview open in the same group — while
 * editing pins it, and file-tree opens always pin (a click must never
 * evict another open file). Preview tabs are therefore always clean, so
 * replacing one never needs a confirmation; only closing a pinned tab
 * with unsaved edits asks.
 * ------------------------------------------------------------------ */

export const MAX_DOCUMENT_GROUPS = 2;

/** Per-tab runtime state owned by the panel, keyed by tab id. Drafts and
 * view modes live here (not in component state) so they survive tab
 * switches, split moves and group remounts. Objects are replaced (never
 * mutated) so `useSyncExternalStore` snapshots stay referentially stable
 * between updates. */
export interface DocumentTabRuntime {
  imageContext?: MarkdownImageContext;
  imageSession?: MarkdownImageSession | null;
  doc: SessionDocument | null;
  /** Draft is always LF-normalized; `eol` restores the file style on save. */
  draft: string;
  eol: "lf" | "crlf";
  loading: boolean;
  error: string | null;
  errorCode: string | null;
  mode: "raw" | "preview";
  reloadToken: number;
  saving: boolean;
  selection: {
    text: string;
    startLine: number | null;
    endLine: number | null;
  } | null;
  /** Heading outline reported by the Markdown preview (null until parsed). */
  outline: OutlineItem[] | null;
  /** Outline rail/drawer visibility for this tab. */
  tocOpen: boolean;
  /** In-document find state, kept per tab like the draft and mode. */
  findOpen: boolean;
  findQuery: string;
  findReplacement: string;
  findIndex: number;
  /** Code-editor find options; Markdown preview ignores them. */
  findCaseSensitive: boolean;
  findRegex: boolean;
  findWholeWord: boolean;
  /** Monotonic focus request so repeated Cmd/Ctrl+F refocuses the field. */
  findRequest: number;
  /** Monotonic focus request for the replace input (Cmd/Ctrl+H). */
  findReplaceRequest: number;
  /** One-shot go-to-line popover state for the active code surface. */
  gotoOpen: boolean;
  gotoRequest: { line: number; token: number } | null;
  /** Load guard: the (path, token) a fetch was started for, so a remount
   * after a split move neither refetches nor double-fetches. */
  loadedPath: string | null;
  loadedToken: number;
}

const tabRuntime = new Map<string, DocumentTabRuntime>();
const runtimeListeners = new Set<() => void>();

function emitRuntimeChange(): void {
  for (const listener of runtimeListeners) listener();
}

export function subscribeDocumentRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener);
  return () => {
    runtimeListeners.delete(listener);
  };
}

export function captureDocumentImageContext(
  path: string,
  options: { device?: DeviceContext; cwd?: string | null } = {},
): MarkdownImageContext {
  const state = getState();
  const device = options.device ?? state.activeDevice;
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const contains = (root: string | null | undefined) => !!root && (root === "/" || path.startsWith(`${root.replace(/\/$/, "")}/`));
  // The explorer root belongs to the active device; a document opened from a
  // background pane must not inherit the other device's browsing root.
  const explorerRoot = sameDeviceContext(device, state.activeDevice)
    ? state.explorerRoot
    : null;
  const sessionRoot =
    options.cwd ?? findSession(state.projects, state.activeSessionId)?.cwd;
  const rootPath = contains(explorerRoot) ? explorerRoot! : contains(sessionRoot) ? sessionRoot! : parent;
  return { path, rootPath, device };
}

/** Device-scoped tab identity: local tabs keep the historical plain path,
 * remote tabs are namespaced so the same path on two devices stays two
 * independent documents instead of reusing the other device's load/draft. */
export function documentTabId(path: string, device: DeviceContext): string {
  const key = deviceKeyForContext(device);
  return key === LOCAL_DEVICE_KEY ? path : `remote:${key}:${path}`;
}

function defaultRuntime(tab: DocumentTab): DocumentTabRuntime {
  return {
    imageContext: tab.imageContext ?? captureDocumentImageContext(tab.path),
    imageSession: null,
    doc: null,
    draft: "",
    eol: "lf",
    loading: false,
    error: null,
    errorCode: null,
    // Markdown defaults to the rendered preview, everything else to raw.
    mode: isMarkdownPath(tab.path) ? "preview" : "raw",
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
}

/** Returns the tab's runtime, creating the default on first use. */
export function ensureDocumentTabRuntime(tab: DocumentTab): DocumentTabRuntime {
  const existing = tabRuntime.get(tab.id);
  if (existing) return existing;
  const created = defaultRuntime(tab);
  tabRuntime.set(tab.id, created);
  return created;
}

export function getDocumentTabRuntime(tabId: string): DocumentTabRuntime | null {
  return tabRuntime.get(tabId) ?? null;
}

/** Applies a patch and notifies subscribers; no-op for closed tabs. */
export function updateDocumentTabRuntime(
  tabId: string,
  patch: Partial<DocumentTabRuntime>,
): void {
  const current = tabRuntime.get(tabId);
  if (!current) return;
  if (patch.doc !== undefined && (patch.doc?.path !== current.doc?.path || patch.doc?.content !== current.doc?.content)) {
    current.imageSession?.dispose();
    const context = current.imageContext;
    patch = {
      ...patch,
      imageSession: patch.doc && context ? new MarkdownImageSession({ ...context, path: patch.doc.path }) : null,
      ...(patch.outline === undefined ? { outline: null } : {}),
      ...(patch.findIndex === undefined ? { findIndex: 0 } : {}),
    };
  }
  tabRuntime.set(tabId, { ...current, ...patch });
  emitRuntimeChange();
}

export function dropDocumentTabRuntime(tabId: string): void {
  tabRuntime.get(tabId)?.imageSession?.dispose();
  if (tabRuntime.delete(tabId)) emitRuntimeChange();
}

/** Normalizes line endings to the editor's internal LF form. */
export function normalizeDocumentEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function isDocumentTabDirty(tabId: string): boolean {
  const runtime = tabRuntime.get(tabId);
  return (
    runtime !== undefined &&
    runtime.doc !== null &&
    normalizeDocumentEol(runtime.draft) !== normalizeDocumentEol(runtime.doc.content)
  );
}

/** Test hook: drops every tab runtime (drafts, load state) between cases. */
export function resetDocumentTabRuntimes(): void {
  for (const runtime of tabRuntime.values()) runtime.imageSession?.dispose();
  tabRuntime.clear();
  emitRuntimeChange();
}

/* ------------------------- group actions ------------------------- */

interface LocatedTab {
  groupIndex: number;
  tabIndex: number;
  tab: DocumentTab;
}

function locateTab(groups: DocumentGroup[], tabId: string): LocatedTab | null {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const tabIndex = groups[groupIndex].tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex >= 0) {
      return { groupIndex, tabIndex, tab: groups[groupIndex].tabs[tabIndex] };
    }
  }
  return null;
}

function cloneGroups(groups: DocumentGroup[]): DocumentGroup[] {
  return groups.map((group) => ({ ...group, tabs: [...group.tabs] }));
}

/** Removes empty groups and keeps the active index pointing at `active`. */
function commitGroups(groups: DocumentGroup[], active: DocumentGroup | null): void {
  const kept = groups.filter((group) => group.tabs.length > 0);
  setState({
    docGroups: kept,
    activeDocGroupIndex: active ? Math.max(0, kept.indexOf(active)) : 0,
    // Closing the last tab also leaves expanded mode (the pre-tabs
    // closeDocument did the same): a tree-only panel keeping the expanded
    // flex class stretches full-width and leaves a blank area beside the
    // tree.
    ...(kept.length === 0
      ? { docPanelExpanded: false, docPanelCollapsed: false, docReadingMode: false }
      : {}),
  });
}

/** Opens a parsed target in the active group's viewer, reusing the group's
 * preview tab unless this is an explicit pinned open (file-tree clicks). */
export function openDocumentTarget(
  target: DocumentLinkTarget,
  options?: { pinned?: boolean; imageContext?: MarkdownImageContext },
): void {
  const state = getState();
  const groups = cloneGroups(state.docGroups);
  const imageContext =
    options?.imageContext ?? captureDocumentImageContext(target.path);
  const tabId = documentTabId(target.path, imageContext.device);

  // Same path on the same device already open anywhere: activate it (a
  // line/anchor target re-reveals). The same path on another device is a
  // different document and must not reuse this tab's origin.
  const existing = locateTab(groups, tabId);
  if (existing) {
    const tab = { ...existing.tab };
    if (target.line != null) tab.pendingLine = target.line;
    if (target.anchor) tab.pendingAnchor = target.anchor;
    if (options?.pinned) tab.pinned = true;
    const group = groups[existing.groupIndex];
    group.tabs[existing.tabIndex] = tab;
    group.activeTabId = tab.id;
    commitGroups(groups, group);
    setState({ docPanelCollapsed: false });
    return;
  }

  const tab: DocumentTab = {
    id: tabId,
    path: target.path,
    pinned: options?.pinned ?? false,
    pendingLine: target.line,
    pendingAnchor: target.anchor ?? null,
    // Links inside a remote document must keep that document's device/root.
    imageContext,
  };
  let group = groups[state.activeDocGroupIndex] ?? groups[groups.length - 1];
  if (!group) {
    group = { tabs: [], activeTabId: null };
    groups.push(group);
  }
  if (!tab.pinned) {
    // Replace the group's preview tab in place (it is always clean).
    const previewIndex = group.tabs.findIndex((candidate) => !candidate.pinned);
    if (previewIndex >= 0) {
      dropDocumentTabRuntime(group.tabs[previewIndex].id);
      group.tabs[previewIndex] = tab;
    } else {
      group.tabs.push(tab);
    }
  } else {
    group.tabs.push(tab);
  }
  group.activeTabId = tab.id;
  commitGroups(groups, group);
  setState({ docPanelCollapsed: false });
}

/** Explicit "open to the side" (tree context menu): pinned in the other
 * group, creating the second split when needed. An already-open device-scoped
 * path is moved/activated there instead of duplicated — tab identity is
 * (device, path), so one document can only live in one group at a time. */
export function openDocumentTargetToSide(
  target: DocumentLinkTarget,
  options?: { imageContext?: MarkdownImageContext },
): void {
  const state = getState();
  const imageContext =
    options?.imageContext ?? captureDocumentImageContext(target.path);
  const tabId = documentTabId(target.path, imageContext.device);
  const existing = locateTab(state.docGroups, tabId);
  if (existing) {
    if (target.line != null || target.anchor) {
      const groups = cloneGroups(state.docGroups);
      const group = groups[existing.groupIndex];
      const tab = { ...existing.tab };
      if (target.line != null) tab.pendingLine = target.line;
      if (target.anchor) tab.pendingAnchor = target.anchor;
      group.tabs[existing.tabIndex] = tab;
      commitGroups(groups, group);
    }
    const sideEmpty =
      state.docGroups.length === 1 && state.docGroups[0].tabs.length === 1;
    // The only open file cannot split against itself; just activate it.
    if (sideEmpty) {
      setActiveDocumentTab(existing.tab.id);
      setState({ docPanelCollapsed: false });
      return;
    }
    const targetGroup = existing.groupIndex === 0 ? 1 : 0;
    moveDocumentTab(existing.tab.id, targetGroup);
    pinDocumentTab(existing.tab.id);
    return;
  }
  const groups = cloneGroups(state.docGroups);
  let group: DocumentGroup;
  if (groups.length >= MAX_DOCUMENT_GROUPS) {
    // Both splits exist: "the side" is the group that is not active.
    group = groups[state.activeDocGroupIndex === 0 ? 1 : 0];
  } else {
    group = { tabs: [], activeTabId: null };
    groups.push(group);
  }
  const tab: DocumentTab = {
    id: tabId,
    path: target.path,
    pinned: true,
    pendingLine: target.line,
    pendingAnchor: target.anchor ?? null,
    imageContext,
  };
  group.tabs.push(tab);
  group.activeTabId = tab.id;
  commitGroups(groups, group);
  setState({ docPanelCollapsed: false });
}

export function setActiveDocumentTab(tabId: string): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located) return;
  const groups = cloneGroups(state.docGroups);
  const group = groups[located.groupIndex];
  group.activeTabId = tabId;
  commitGroups(groups, group);
}

export function setActiveDocumentGroup(groupIndex: number): void {
  const state = getState();
  if (groupIndex < 0 || groupIndex >= state.docGroups.length) return;
  if (state.activeDocGroupIndex === groupIndex) return;
  setState({ activeDocGroupIndex: groupIndex });
}

export function pinDocumentTab(tabId: string): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located || located.tab.pinned) return;
  const groups = cloneGroups(state.docGroups);
  groups[located.groupIndex].tabs[located.tabIndex] = { ...located.tab, pinned: true };
  commitGroups(groups, groups[located.groupIndex]);
}

/** Moves a tab into another group (creating the second split on demand) or
 * reorders it within its own group before `beforeTabId` (null = append).
 * The moved tab becomes active in the target group; a source group left
 * empty collapses. */
export function moveDocumentTab(
  tabId: string,
  targetGroupIndex: number,
  beforeTabId: string | null = null,
): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located || beforeTabId === tabId) return;
  const groups = cloneGroups(state.docGroups);
  const source = groups[located.groupIndex];
  source.tabs.splice(located.tabIndex, 1);
  // Moving the active tab away hands the source group to its neighbour;
  // otherwise activeTabId keeps pointing at the moved tab and the group
  // renders blank.
  if (source.activeTabId === located.tab.id) {
    source.activeTabId =
      source.tabs[Math.min(located.tabIndex, source.tabs.length - 1)]?.id ?? null;
  }

  let target = groups[targetGroupIndex];
  if (!target) {
    if (groups.length >= MAX_DOCUMENT_GROUPS) return;
    target = { tabs: [], activeTabId: null };
    groups.push(target);
  }
  const insertAt = beforeTabId
    ? target.tabs.findIndex((tab) => tab.id === beforeTabId)
    : -1;
  if (insertAt >= 0) target.tabs.splice(insertAt, 0, located.tab);
  else target.tabs.push(located.tab);
  target.activeTabId = located.tab.id;
  commitGroups(groups, target);
}

function closeDocumentTabNow(tabId: string): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located) return;
  const groups = cloneGroups(state.docGroups);
  const group = groups[located.groupIndex];
  group.tabs.splice(located.tabIndex, 1);
  if (group.activeTabId === tabId) {
    // Activate the tab that slid into the closed slot, else the last one.
    group.activeTabId =
      group.tabs[Math.min(located.tabIndex, group.tabs.length - 1)]?.id ?? null;
  }
  dropDocumentTabRuntime(tabId);
  commitGroups(groups, group.tabs.length > 0 ? group : null);
}

/** Closes a tab, asking first when it holds unsaved edits. */
export function closeDocumentTab(tabId: string): void {
  if (isDocumentTabDirty(tabId)) {
    void confirmDialog({
      title: i18n.t("shell:ui.document.unsavedTitle"),
      body: i18n.t("shell:ui.document.unsavedBody"),
      confirmLabel: i18n.t("shell:ui.document.unsavedDiscard"),
      danger: true,
    }).then((ok) => {
      if (ok) closeDocumentTabNow(tabId);
    });
    return;
  }
  closeDocumentTabNow(tabId);
}

/** Silently closes every tab for `path` or inside it on one device (tree
 * delete flow — the save target is gone either way, matching the old viewer
 * behavior). Tabs for the same path on another device stay open. */
export function closeDocumentTabsUnder(
  path: string,
  device: DeviceContext = getState().activeDevice,
): void {
  const state = getState();
  const base = documentTabId(path, device);
  const doomed = state.docGroups
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.id === base || tab.id.startsWith(`${base}/`))
    .map((tab) => tab.id);
  for (const tabId of doomed) closeDocumentTabNow(tabId);
}

/** Rekeys an open tab after the tree renamed its file. */
export function updateDocumentTabPath(
  oldPath: string,
  newPath: string,
  device: DeviceContext = getState().activeDevice,
): void {
  const state = getState();
  const oldId = documentTabId(oldPath, device);
  const newId = documentTabId(newPath, device);
  const located = locateTab(state.docGroups, oldId);
  const runtime = tabRuntime.get(oldId);
  if (runtime) {
    runtime.imageSession?.dispose();
    tabRuntime.delete(oldId);
    tabRuntime.set(newId, {
      ...runtime,
      doc: runtime.doc ? { ...runtime.doc, path: newPath } : null,
      // The draft now belongs to the new path; without moving loadedPath the
      // remounted editor treats the rename as a different file and reloads
      // the disk contents over unsaved edits.
      loadedPath: runtime.loadedPath === oldPath ? newPath : runtime.loadedPath,
      imageContext: runtime.imageContext ? { ...runtime.imageContext, path: newPath } : undefined,
      imageSession: runtime.doc && runtime.imageContext ? new MarkdownImageSession({ ...runtime.imageContext, path: newPath }) : null,
    });
  }
  if (!located) return;
  const groups = cloneGroups(state.docGroups);
  const group = groups[located.groupIndex];
  group.tabs[located.tabIndex] = {
    ...located.tab, id: newId, path: newPath,
    imageContext: located.tab.imageContext ? { ...located.tab.imageContext, path: newPath } : undefined,
  };
  if (group.activeTabId === oldId) group.activeTabId = newId;
  commitGroups(groups, group);
}

/** One-shot consumption of a `path:line` reveal after the editor showed it. */
export function clearDocumentPendingLine(tabId: string): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located || located.tab.pendingLine == null) return;
  const groups = cloneGroups(state.docGroups);
  groups[located.groupIndex].tabs[located.tabIndex] = { ...located.tab, pendingLine: null };
  commitGroups(groups, groups[located.groupIndex]);
}

/** One-shot consumption of a heading anchor reveal. */
export function clearDocumentPendingAnchor(tabId: string): void {
  const state = getState();
  const located = locateTab(state.docGroups, tabId);
  if (!located || !located.tab.pendingAnchor) return;
  const groups = cloneGroups(state.docGroups);
  groups[located.groupIndex].tabs[located.tabIndex] = { ...located.tab, pendingAnchor: null };
  commitGroups(groups, groups[located.groupIndex]);
}

/** Toggles the VSCode-like file tree. When opening, the tree roots at the
 * active session's working directory so it always shows the project the
 * terminal is operating on. */
export function toggleExplorer(): void {
  const state = getState();
  if (state.explorerOpen) {
    setState({ explorerOpen: false });
    return;
  }
  const session = findSession(state.projects, state.activeSessionId);
  setState({
    explorerOpen: true,
    explorerRoot: session?.cwd ?? state.explorerRoot,
  });
}

/* ------------------------- tree search requests ------------------------- *
 * ⌘⇧F / Ctrl+Shift+F must work while the tree is closed, so the shortcut
 * only records a one-shot request; the tree consumes it when it mounts (or
 * immediately, when it already is). */

let treeSearchRequestVersion = 0;
let treeSearchPending = false;
const treeSearchRequestListeners = new Set<() => void>();

function emitTreeSearchRequest(): void {
  for (const listener of treeSearchRequestListeners) listener();
}

export function subscribeDocumentTreeSearch(listener: () => void): () => void {
  treeSearchRequestListeners.add(listener);
  return () => {
    treeSearchRequestListeners.delete(listener);
  };
}

export function getDocumentTreeSearchVersion(): number {
  return treeSearchRequestVersion;
}

/** Opens the explorer when needed and asks the tree to focus its search box. */
export function openDocumentTreeSearch(): void {
  if (!getState().explorerOpen) toggleExplorer();
  treeSearchPending = true;
  treeSearchRequestVersion += 1;
  emitTreeSearchRequest();
}

/** One-shot consumption so a later tree remount never reopens the search. */
export function consumeDocumentTreeSearchRequest(): boolean {
  if (!treeSearchPending) return false;
  treeSearchPending = false;
  return true;
}

/** Test hook: drops pending requests between cases. */
export function resetDocumentTreeSearchRequests(): void {
  treeSearchPending = false;
  treeSearchRequestVersion = 0;
  emitTreeSearchRequest();
}

/** Global shortcut matcher (⌘⇧F on macOS, Ctrl+Shift+F elsewhere). */
export function isDocumentTreeSearchShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "key">,
  mac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "f") return false;
  return mac
    ? event.metaKey && event.shiftKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
}

/**
 * Fallback path candidates when the literal link target does not exist.
 * Agents print paths inside prose (`…/报告.md, 包含…`), so even with a
 * conservative link regex an OSC 8 target or an unusual match can carry
 * trailing sentence punctuation. Each candidate re-strips an exposed
 * `:line` suffix so `/a/b.md:3,` can still resolve to `/a/b.md`.
 */
export function documentPathFallbacks(path: string): string[] {
  const seen = new Set<string>([path]);
  const out: string[] = [];
  const TERMINATOR = /[，。；、！？【】《》「」『』]/u;
  const push = (candidate: string) => {
    const position = /:(\d+)(?::(\d+))?$/.exec(candidate);
    const base = position ? candidate.slice(0, position.index) : candidate;
    // A candidate still containing sentence punctuation is junk by
    // construction — skip it instead of issuing a doomed read.
    if (base.length > 1 && !seen.has(base) && !TERMINATOR.test(base)) {
      seen.add(base);
      out.push(base);
    }
  };
  // Cut at the first CJK sentence punctuation mark.
  const terminator = path.search(TERMINATOR);
  if (terminator > 0) push(path.slice(0, terminator));
  // Trim trailing junk punctuation/brackets/quotes.
  push(path.replace(/[\s,;，。；：、！？【】《》「」『』)\]}"'`]+$/u, ""));
  return out;
}

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

export function isMarkdownPath(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return MARKDOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
