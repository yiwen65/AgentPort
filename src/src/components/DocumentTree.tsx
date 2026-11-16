// VSCode-like project file tree inside the document panel. Directories load
// lazily on expand (the backend lists one directory per call), files open in
// the panel's editor through the same path as terminal document links, and
// the header buttons create new files/directories below the active row.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  api,
  copyText,
  createDocumentEntryForDevice,
  deleteDocumentEntryForDevice,
  duplicateDocumentEntryForDevice,
  errorText,
  listDocumentDirectoryForDevice,
  renameDocumentEntryForDevice,
  searchDocumentFilesForDevice,
} from "../api";
import { isMac } from "../actions";
import {
  closeDocumentTabsUnder,
  consumeDocumentTreeSearchRequest,
  documentTabId,
  getDocumentTreeSearchVersion,
  openDocumentTarget,
  openDocumentTargetToSide,
  subscribeDocumentTreeSearch,
  updateDocumentTabPath,
} from "../documents";
import { deviceKeyForContext } from "../sessionIdentity";
import type { DeviceContext } from "../deviceContext";
import type { MarkdownImageContext } from "../markdownImages";
import {
  buildDocGitIndex,
  decorateDocPath,
  getTreeGitState,
  refreshTreeGit,
  subscribeTreeGit,
  type DocGitDecoration,
  type DocGitIndex,
} from "../docTreeGit";
import { DocFileIcon } from "./docTreeIcons";
import { writeDragPayload } from "../terminalDrop";
import { beginNativeTreeDrag } from "../nativeDrag";
import {
  confirmDialog,
  getActiveDocumentTab,
  openContextMenu,
  toast,
  useStore,
} from "../store";
import { isRemoteRequestError, isRemoteUnavailableError } from "../remote/errors";
import type { DocumentDirEntry, DocumentFileSearchResult } from "../types";

interface DirState {
  entries: DocumentDirEntry[] | null;
  error: string | null;
  expanded: boolean;
}

const SEARCH_DEBOUNCE_MS = 150;
const MAX_SEARCH_QUERY_CHARS = 256;

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? trimmed;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : "/";
}

function relativeToRoot(path: string, root: string): string {
  if (root === "/") return path.replace(/^\/+/, "");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

/** Splits text around case-insensitive query hits so matches can be marked
 * without injecting raw HTML. */
function highlightMatches(text: string, query: string): React.ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const haystack = text.toLowerCase();
  const nodes: React.ReactNode[] = [];
  let from = 0;
  let key = 0;
  while (from < text.length) {
    const hit = haystack.indexOf(needle, from);
    if (hit < 0) {
      nodes.push(text.slice(from));
      break;
    }
    if (hit > from) nodes.push(text.slice(from, hit));
    nodes.push(
      <mark key={key} className="doc-tree-search-hit">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    key += 1;
    from = hit + needle.length;
  }
  return nodes;
}

function IconChevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`doc-tree-chevron${expanded ? " expanded" : ""}`}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.25 1.75 6.75 5l-3.5 3.25"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCollapseAll() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 7.2 8 2.7l4.5 4.5M3.5 12.3 8 7.8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.1" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 10.2 13.5 13.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function IconNewFile() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Zm0 0v3.5h3.5M8 8v4M6 10h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconNewFolder() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.25a1 1 0 0 1 1-1h2.6l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.25ZM8 7v4M6 9h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function DocumentTree() {
  const { t } = useTranslation("shell");
  const root = useStore((state) => state.explorerRoot);
  const activeDevice = useStore((state) => state.activeDevice);
  const deviceKey = deviceKeyForContext(activeDevice);
  const openTabKey = useStore((state) => {
    const tab = getActiveDocumentTab(state);
    return tab
      ? documentTabId(tab.path, tab.imageContext?.device ?? state.activeDevice)
      : null;
  });
  const treeGit = useSyncExternalStore(subscribeTreeGit, () =>
    getTreeGitState(root ?? ""),
  );
  const treeSearchVersion = useSyncExternalStore(
    subscribeDocumentTreeSearch,
    getDocumentTreeSearchVersion,
  );
  // A Git Center snapshot for the same checkout supersedes ours when newer
  // (stage/discard there must repaint the tree without a manual refresh).
  const checkoutRoot = treeGit?.checkoutRoot ?? null;
  const gcSnapshot = useStore((state) => {
    if (!checkoutRoot) return null;
    for (const cache of Object.values(state.gitCenter.caches)) {
      const snapshot = cache.changes;
      if (snapshot?.context.checkoutRoot === checkoutRoot) return snapshot;
    }
    return null;
  });
  const gitIndex = useMemo<DocGitIndex | null>(() => {
    const own = treeGit && treeGit.phase !== "unavailable" ? treeGit : null;
    if (gcSnapshot && (!own?.observedAt || gcSnapshot.observedAt > own.observedAt)) {
      return buildDocGitIndex(gcSnapshot);
    }
    return own?.index ?? null;
  }, [treeGit, gcSnapshot]);
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  // Lets the manual-refresh handler reload every loaded directory without
  // routing the whole map through an effect (which would loop on `dirs`).
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;
  const activeDeviceRef = useRef(activeDevice);
  activeDeviceRef.current = activeDevice;
  // Bumped whenever the tree is re-rooted or the active device changes, so a
  // listing that settles afterwards can never paint the new tree.
  const treeEpoch = useRef(0);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchListing, setSearchListing] = useState<DocumentFileSearchResult | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<{
    text: string;
    remoteUnsupported: boolean;
  } | null>(null);
  const [searchActive, setSearchActive] = useState(0);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const activeSearchRowRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const createBaseDir = activeDir ?? root;

  /** Origin captured for a tree action: the tree's device and root, never a
   * later active-device switch. */
  const treeImageContext = (
    path: string,
    device: DeviceContext = activeDeviceRef.current,
    rootPath: string | null = root,
  ): MarkdownImageContext => ({
    path,
    rootPath: rootPath ?? parentDir(path),
    device,
  });

  const loadDir = useCallback(
    (
      path: string,
      expand: boolean,
      device: DeviceContext = activeDeviceRef.current,
      epoch: number = treeEpoch.current,
    ) => {
      setDirs((current) => {
        const next = new Map(current);
        const prev = next.get(path);
        next.set(path, {
          entries: prev?.entries ?? null,
          error: null,
          expanded: expand,
        });
        return next;
      });
      void listDocumentDirectoryForDevice(path, device)
        .then((listing) => {
          if (epoch !== treeEpoch.current) return;
          setDirs((current) => {
            const next = new Map(current);
            next.set(path, { entries: listing.entries, error: null, expanded: expand });
            return next;
          });
        })
        .catch((e) => {
          if (epoch !== treeEpoch.current) return;
          setDirs((current) => {
            const next = new Map(current);
            next.set(path, { entries: null, error: errorText(e), expanded: expand });
            return next;
          });
        });
    },
    [],
  );

  // Load (or reload) the root directory and its git decorations. The device
  // key is part of the trigger: local and remote devices can share the same
  // cwd path, and reusing either's cached entries would open the wrong files.
  useEffect(() => {
    treeEpoch.current += 1;
    const epoch = treeEpoch.current;
    setSearchQuery("");
    setSearchListing(null);
    setSearchError(null);
    setSearchBusy(false);
    setSearchActive(0);
    setCreating(null);
    setCreateError(null);
    setRenaming(null);
    setRenameError(null);
    setActiveDir(null);
    if (!root) {
      setSearchOpen(false);
      setDirs(new Map());
      return;
    }
    setDirs(new Map());
    loadDir(root, true, activeDeviceRef.current, epoch);
    void refreshTreeGit(root);
  }, [root, deviceKey, loadDir]);

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchListing(null);
    setSearchError(null);
    setSearchBusy(false);
    setSearchActive(0);
  };

  const openSearch = useCallback(() => {
    // Search results and inline create/rename rows compete for the tree
    // body; only one editing affordance may be open at a time.
    setCreating(null);
    setCreateError(null);
    setRenaming(null);
    setRenameError(null);
    setSearchOpen(true);
    setSearchFocusRequest((request) => request + 1);
  }, []);

  // ⌘⇧F / Ctrl+Shift+F may arrive while the explorer is closed; the request
  // waits for the tree to mount and a real root before it is consumed.
  useEffect(() => {
    if (!root) return;
    if (!consumeDocumentTreeSearchRequest()) return;
    openSearch();
  }, [treeSearchVersion, root, openSearch]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen, searchFocusRequest]);

  // Debounced recursive search. Results are device- and root-scoped: a
  // response that settles after a switch must never repaint the new tree.
  useEffect(() => {
    if (!root || !searchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchListing(null);
      setSearchError(null);
      setSearchBusy(false);
      return;
    }
    let cancelled = false;
    setSearchBusy(true);
    setSearchError(null);
    const device = activeDeviceRef.current;
    const timer = window.setTimeout(() => {
      void searchDocumentFilesForDevice(root, query, device)
        .then((listing) => {
          if (cancelled) return;
          setSearchListing(listing);
          setSearchActive(0);
        })
        .catch((e) => {
          if (cancelled) return;
          setSearchListing(null);
          setSearchError({
            text: errorText(e),
            remoteUnsupported:
              isRemoteRequestError(e) &&
              (e.code === "unknown_method" || e.code === "capability_disabled"),
          });
        })
        .finally(() => {
          if (!cancelled) setSearchBusy(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [root, deviceKey, searchOpen, searchQuery]);

  // Keep the keyboard-selected result visible while arrowing through a long
  // flat list.
  useEffect(() => {
    activeSearchRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [searchActive, searchListing]);

  /** Manual refresh: re-read every directory that was ever loaded while
   * keeping each one's expanded/collapsed state (a refresh must not fold
   * the tree). Directories never expanded stay lazy. */
  const refreshAll = useCallback(() => {
    if (!root) return;
    const snapshot = dirsRef.current;
    if (snapshot.size === 0) {
      loadDir(root, true);
    } else {
      for (const [path, state] of snapshot) loadDir(path, state.expanded);
    }
    void refreshTreeGit(root);
  }, [root, loadDir]);

  // Coming back to the window repaints decorations (a commit or branch
  // switch may have happened elsewhere); best-effort, never blocking.
  useEffect(() => {
    if (!root) return;
    const onFocus = () => void refreshTreeGit(root);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [root]);

  const toggleDir = (path: string) => {
    setActiveDir(path);
    const state = dirs.get(path);
    if (state?.expanded) {
      setDirs((current) => {
        const next = new Map(current);
        next.set(path, { ...state, expanded: false });
        return next;
      });
    } else if (state?.entries) {
      setDirs((current) => {
        const next = new Map(current);
        next.set(path, { ...state, expanded: true });
        return next;
      });
    } else {
      loadDir(path, true);
    }
  };

  const startCreate = (kind: "file" | "dir", baseDir?: string) => {
    const base = baseDir ?? createBaseDir;
    if (!base) return;
    closeSearch();
    setActiveDir(base);
    setRenaming(null);
    setCreating(kind);
    setNameDraft("");
    setCreateError(null);
  };

  const toggleSearch = () => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    openSearch();
  };

  const openSearchResult = (entry: DocumentDirEntry) => {
    setActiveDir(parentDir(entry.path));
    const device = activeDeviceRef.current;
    openDocumentTarget(
      { path: entry.path, line: null },
      {
        pinned: true,
        imageContext: treeImageContext(
          entry.path,
          device,
          searchListing?.path ?? root,
        ),
      },
    );
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    const entries = searchListing?.entries ?? [];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (entries.length === 0) return;
      event.preventDefault();
      setSearchActive((index) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        return (index + step + entries.length) % entries.length;
      });
      return;
    }
    if (event.key === "Enter" && entries.length > 0) {
      event.preventDefault();
      const entry = entries[Math.min(searchActive, entries.length - 1)];
      if (entry) openSearchResult(entry);
    }
  };

  /** Error toast wrapper for fire-and-forget menu actions. */
  const runAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      // Safety net for menu items gated off remotely: a structured notice,
      // not an unhandled failure.
      if (isRemoteUnavailableError(e)) {
        toast(t("ui.document.remoteActionUnavailable"), "info");
        return;
      }
      toast(t("ui.document.entryActionFailed", { detail: errorText(e) }), "error");
    }
  };

  const startRename = (entry: DocumentDirEntry) => {
    setCreating(null);
    setRenaming(entry.path);
    setRenameDraft(entry.name);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renaming) return;
    const name = renameDraft.trim();
    if (!name || name === baseName(renaming)) {
      setRenaming(null);
      return;
    }
    // Rename stays in the same directory; nested paths are not a rename.
    if (name.includes("/") || name === "." || name === "..") {
      setRenameError(t("ui.document.createInvalidName"));
      return;
    }
    const parent = parentDir(renaming);
    const newPath = `${parent === "/" ? "" : parent}/${name}`;
    const device = activeDeviceRef.current;
    const epoch = treeEpoch.current;
    try {
      const result = await renameDocumentEntryForDevice(renaming, newPath, device);
      const oldPath = renaming;
      setRenaming(null);
      if (epoch === treeEpoch.current) loadDir(parent, true, device, epoch);
      // Keep an open tab pointed at the renamed file.
      updateDocumentTabPath(oldPath, result.path, device);
    } catch (e) {
      setRenameError(errorText(e));
    }
  };

  const confirmDelete = async (entry: DocumentDirEntry, device: DeviceContext) => {
    const ok = await confirmDialog({
      title: t(entry.isDir ? "ui.document.deleteDirTitle" : "ui.document.deleteFileTitle"),
      body: t(entry.isDir ? "ui.document.deleteDirBody" : "ui.document.deleteFileBody", {
        name: entry.name,
      }),
      confirmLabel: t("ui.document.deleteEntry"),
      danger: true,
    });
    if (!ok) return;
    await runAction(async () => {
      const epoch = treeEpoch.current;
      await deleteDocumentEntryForDevice(entry.path, device);
      if (epoch === treeEpoch.current) {
        loadDir(parentDir(entry.path), true, device, epoch);
      }
      // The viewer must not keep a deleted file (or one inside a deleted
      // directory) on screen.
      closeDocumentTabsUnder(entry.path, device);
    });
  };

  /** VSCode-style row context menu (see design reference in the PR review). */
  const openEntryMenu = (event: React.MouseEvent, entry: DocumentDirEntry) => {
    event.preventDefault();
    const parent = entry.isDir ? entry.path : parentDir(entry.path);
    setActiveDir(parent);
    // The menu belongs to the tree that listed the entry, not to whatever
    // device happens to be active when an item is clicked later.
    const device = activeDeviceRef.current;
    const osIntegration = device.kind === "local";
    const entryMutation = device.kind === "local";
    const relative =
      root && entry.path.startsWith(`${root}/`)
        ? entry.path.slice(root.length + 1)
        : entry.path;
    // Git decorations are best-effort; the root only names a checkout once
    // the tree-git snapshot proved this tree is inside a Git repository.
    const gitCheckoutRoot = treeGit?.checkoutRoot ?? null;
    openContextMenu(event.clientX, event.clientY, [
      { label: t("ui.document.newFile"), action: () => startCreate("file", parent) },
      { label: t("ui.document.newDir"), action: () => startCreate("dir", parent) },
      { label: "", separator: true },
      ...(entry.isDir
        ? []
        : [
            {
              label: t("ui.document.openToSide"),
              action: () =>
                openDocumentTargetToSide(
                  { path: entry.path, line: null },
                  { imageContext: treeImageContext(entry.path, device) },
                ),
            },
          ]),
      {
        label: t("ui.document.openInVsCode"),
        disabled: !osIntegration,
        tip: osIntegration ? undefined : t("ui.document.remoteOsIntegration"),
        action: () => {
          if (device.kind !== "local") {
            toast(t("ui.document.remoteActionUnavailable"), "info");
            return;
          }
          void runAction(() => api.openInVsCode(entry.path));
        },
      },
      { label: "", separator: true },
      { label: t("ui.document.copyPath"), action: () => void copyText(entry.path) },
      { label: t("ui.document.copyRelativePath"), action: () => void copyText(relative) },
      {
        label: t("ui.document.reveal"),
        disabled: !osIntegration,
        tip: osIntegration ? undefined : t("ui.document.remoteOsIntegration"),
        action: () => {
          if (device.kind !== "local") {
            toast(t("ui.document.remoteActionUnavailable"), "info");
            return;
          }
          void runAction(() => api.revealInFileManager(entry.path));
        },
      },
      ...(gitCheckoutRoot
        ? [
            { label: "", separator: true },
            {
              label: t("ui.document.addToGitignore"),
              disabled: !entryMutation,
              tip: entryMutation ? undefined : t("ui.document.remoteMutationUnavailable"),
              action: () => {
                if (device.kind !== "local") {
                  toast(t("ui.document.remoteActionUnavailable"), "info");
                  return;
                }
                void runAction(async () => {
                  await api.addDocumentEntryToGitignore(gitCheckoutRoot, entry.path);
                  await refreshTreeGit(root ?? gitCheckoutRoot);
                });
              },
            },
          ]
        : []),
      { label: "", separator: true },
      {
        label: t("ui.document.rename"),
        disabled: !entryMutation,
        tip: entryMutation ? undefined : t("ui.document.remoteMutationUnavailable"),
        action: () => startRename(entry),
      },
      {
        label: t("ui.document.duplicate"),
        disabled: !entryMutation,
        tip: entryMutation ? undefined : t("ui.document.remoteMutationUnavailable"),
        action: () =>
          void runAction(async () => {
            const epoch = treeEpoch.current;
            await duplicateDocumentEntryForDevice(entry.path, device);
            if (epoch === treeEpoch.current) loadDir(parent, true, device, epoch);
          }),
      },
      { label: "", separator: true },
      {
        label: t("ui.document.deleteEntry"),
        disabled: !entryMutation,
        tip: entryMutation ? undefined : t("ui.document.remoteMutationUnavailable"),
        danger: true,
        action: () => void confirmDelete(entry, device),
      },
    ]);
  };

  const submitCreate = async () => {
    if (!creating || !createBaseDir) return;
    const name = nameDraft.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!name) {
      setCreating(null);
      return;
    }
    if (name.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      setCreateError(t("ui.document.createInvalidName"));
      return;
    }
    const fullPath = `${createBaseDir.replace(/\/+$/, "")}/${name}`;
    const device = activeDeviceRef.current;
    const epoch = treeEpoch.current;
    setCreateBusy(true);
    try {
      const result = await createDocumentEntryForDevice(fullPath, creating, device);
      const kind = creating;
      setCreating(null);
      setNameDraft("");
      setCreateError(null);
      // Refresh the parent so the new entry shows up, then select/open it.
      if (epoch === treeEpoch.current) loadDir(createBaseDir, true, device, epoch);
      if (kind === "dir") {
        setActiveDir(result.path);
      } else {
        const rootPath =
          root && (result.path === root || result.path.startsWith(`${root}/`))
            ? root
            : parentDir(result.path);
        openDocumentTarget(
          { path: result.path, line: null },
          {
            pinned: true,
            imageContext: treeImageContext(result.path, device, rootPath),
          },
        );
      }
    } catch (e) {
      setCreateError(errorText(e));
    } finally {
      setCreateBusy(false);
    }
  };

  const renderDir = (entries: DocumentDirEntry[], depth: number): React.ReactNode =>
    entries.map((entry) => {
      const child = dirs.get(entry.path);
      const expanded = child?.expanded ?? false;
      const selected =
        !entry.isDir &&
        openTabKey === documentTabId(entry.path, activeDevice);
      const deco: DocGitDecoration | null = gitIndex
        ? decorateDocPath(gitIndex, entry.path, entry.isDir)
        : null;
      const gitClass = deco
        ? `${deco.dimmed ? " git-dimmed" : ""}${deco.status ? ` git-${deco.status}` : ""}`
        : "";
      const gitStatus = deco?.status ?? deco?.dirStatus;
      const gitLabel = gitStatus
        ? t(`ui.document.gitStatus.${gitStatus}`)
        : deco?.dimmed
          ? t("ui.document.gitStatus.ignored")
          : undefined;
      return (
        <div key={entry.path}>
          {renaming === entry.path ? (
            <div
              className={`doc-tree-row${entry.isDir ? " dir" : " file"}${gitClass}`}
              style={{ paddingLeft: 6 + depth * 16 }}
            >
              {/* One leading slot for both kinds: chevron for dirs, type
                 icon for files — sibling names stay flush. */}
              {entry.isDir ? (
                <span className="doc-tree-icon" aria-hidden="true">
                  <IconChevron expanded={expanded} />
                </span>
              ) : (
                <span className="doc-tree-kind file" aria-hidden="true">
                  <DocFileIcon name={entry.name} />
                </span>
              )}
              <input
                className="doc-tree-rename-input"
                value={renameDraft}
                aria-label={t("ui.document.rename")}
                autoFocus
                onChange={(event) => {
                  setRenameDraft(event.target.value);
                  setRenameError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(null);
                  }
                }}
                onBlur={() => setRenaming(null)}
              />
            </div>
          ) : (
          <button
            className={`doc-tree-row${entry.isDir ? " dir" : " file"}${selected ? " selected" : ""}${gitClass}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            draggable
            onContextMenu={(event) => openEntryMenu(event, entry)}
            onDragStart={(event) => {
              const payload = { path: entry.path, isDir: entry.isDir };
              writeDragPayload(event.dataTransfer, payload);
              beginNativeTreeDrag(payload);
            }}
            onClick={() => {
              if (entry.isDir) {
                toggleDir(entry.path);
              } else {
                setActiveDir(parentDir(entry.path));
                // Pinned, so clicking another file opens a new tab instead of
                // replacing the previous one (no preview slot in the tree).
                openDocumentTarget(
                  { path: entry.path, line: null },
                  {
                    pinned: true,
                    imageContext: treeImageContext(
                      entry.path,
                      activeDeviceRef.current,
                    ),
                  },
                );
              }
            }}
          >
            {entry.isDir ? (
              <span className="doc-tree-icon" aria-hidden="true">
                <IconChevron expanded={expanded} />
              </span>
            ) : (
              <span className="doc-tree-kind file" aria-hidden="true">
                <DocFileIcon name={entry.name} />
              </span>
            )}
            <span className="doc-tree-name">{entry.name}</span>
            {deco?.badge ? (
              <span
                className={`doc-tree-git-badge git-${deco.status}`}
                data-tip={gitLabel}
              >
                {deco.badge}
              </span>
            ) : null}
            {deco?.dirChanged ? (
              <span
                className={`doc-tree-git-dot git-${deco.dirStatus}`}
                data-tip={gitLabel}
                aria-label={gitLabel}
              />
            ) : null}
          </button>
          )}
          {renaming === entry.path && renameError ? (
            <div
              className="doc-tree-create-error"
              role="alert"
              style={{ paddingLeft: 12 + depth * 16 }}
            >
              {renameError}
            </div>
          ) : null}
          {entry.isDir && expanded ? (
            <div
              className="doc-tree-children"
              style={{ "--guide-x": `${13 + depth * 16}px` } as React.CSSProperties}
            >
              {child?.error ? (
                <div className="doc-tree-note" style={{ paddingLeft: 34 + depth * 16 }}>
                  {child.error}
                </div>
              ) : child?.entries ? (
                renderDir(child.entries, depth + 1)
              ) : (
                <div className="doc-tree-note" style={{ paddingLeft: 34 + depth * 16 }}>
                  {t("ui.document.treeLoading")}
                </div>
              )}
            </div>
          ) : null}
        </div>
      );
    });

  const rootState = root ? dirs.get(root) : null;
  const searching = searchOpen && searchQuery.trim().length > 0;
  const searchShortcut = isMac() ? "⌘⇧F" : "Ctrl+Shift+F";

  return (
    <div
      className={`doc-tree${searchOpen ? " searching" : ""}`}
      aria-label={t("ui.document.treeLabel")}
    >
      <div className="doc-tree-header">
        <span className="doc-tree-root">
          {root ? baseName(root) : t("ui.document.treeLabel")}
        </span>
        <span className="spacer" />
        <span className="doc-tree-actions">
          <button
            className="btn small ghost"
            data-tip={t("ui.document.searchFilesTip", { shortcut: searchShortcut })}
            aria-label={t("ui.document.searchFiles")}
            aria-pressed={searchOpen}
            disabled={!root}
            onClick={toggleSearch}
          >
            <IconSearch />
          </button>
          <button
            className="btn small ghost"
            data-tip={t("ui.document.newFileTip")}
            aria-label={t("ui.document.newFile")}
            disabled={!createBaseDir}
            onClick={() => startCreate("file")}
          >
            <IconNewFile />
          </button>
          <button
            className="btn small ghost"
            data-tip={t("ui.document.newDirTip")}
            aria-label={t("ui.document.newDir")}
            disabled={!createBaseDir}
            onClick={() => startCreate("dir")}
          >
            <IconNewFolder />
          </button>
          <button
            className="btn small ghost"
            data-tip={t("ui.document.refreshTreeTip")}
            aria-label={t("ui.document.refreshTree")}
            onClick={refreshAll}
          >
            ⟳
          </button>
          <button
            className="btn small ghost"
            data-tip={t("ui.document.collapseAllTip")}
            aria-label={t("ui.document.collapseAll")}
            onClick={() => {
              // Collapse every loaded directory except the root itself.
              setDirs((current) => {
                const next = new Map(current);
                for (const [path, dirState] of next) {
                  if (path !== root && dirState.expanded) {
                    next.set(path, { ...dirState, expanded: false });
                  }
                }
                return next;
              });
            }}
          >
            <IconCollapseAll />
          </button>
        </span>
      </div>
      {searchOpen ? (
        <div className="doc-tree-search">
          <IconSearch />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            placeholder={t("ui.document.searchPlaceholder")}
            aria-label={t("ui.document.searchFiles")}
            maxLength={MAX_SEARCH_QUERY_CHARS}
            autoFocus
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchActive(0);
            }}
            onKeyDown={onSearchKeyDown}
          />
          {searchBusy ? (
            <span className="doc-tree-search-busy" aria-hidden="true" />
          ) : null}
        </div>
      ) : null}
      <div
        className="doc-tree-body"
        role={searching ? "listbox" : "tree"}
        aria-label={searching ? t("ui.document.searchResultsLabel") : undefined}
      >
        {!searching && creating && createBaseDir ? (
          <div className="doc-tree-create">
            <span className="doc-tree-create-base">
              {creating === "dir" ? "📁" : "📄"} {baseName(createBaseDir)}/
            </span>
            <input
              ref={createInputRef}
              type="text"
              value={nameDraft}
              placeholder={t("ui.document.createPlaceholder")}
              aria-label={creating === "dir" ? t("ui.document.newDir") : t("ui.document.newFile")}
              disabled={createBusy}
              autoFocus
              onChange={(event) => {
                setNameDraft(event.target.value);
                setCreateError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitCreate();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(null);
                }
              }}
              onBlur={() => {
                if (!createBusy && !nameDraft.trim()) setCreating(null);
              }}
            />
            {createError ? (
              <div className="doc-tree-create-error" role="alert">
                {createError}
              </div>
            ) : null}
          </div>
        ) : null}
        {searching ? (
          searchError ? (
            <div className="doc-tree-note error" role="alert">
              {searchError.remoteUnsupported
                ? t("ui.document.searchRemoteUnsupported")
                : t("ui.document.searchFailed", { detail: searchError.text })}
            </div>
          ) : searchListing ? (
            searchListing.entries.length ? (
              <>
                {searchListing.entries.map((entry, index) => {
                  const relative = relativeToRoot(entry.path, searchListing.path);
                  const slash = relative.lastIndexOf("/");
                  const dirPart = slash >= 0 ? relative.slice(0, slash + 1) : "";
                  const namePart = relative.slice(slash + 1);
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      role="option"
                      aria-selected={index === searchActive}
                      aria-label={relative}
                      ref={index === searchActive ? activeSearchRowRef : undefined}
                      className={`doc-tree-row file doc-tree-search-row${
                        openTabKey === documentTabId(entry.path, activeDevice)
                          ? " selected"
                          : ""
                      }${index === searchActive ? " active" : ""}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setSearchActive(index)}
                      onClick={() => openSearchResult(entry)}
                    >
                      <span className="doc-tree-kind file" aria-hidden="true">
                        <DocFileIcon name={entry.name} />
                      </span>
                      <span className="doc-tree-search-path">
                        <span className="doc-tree-name">
                          {highlightMatches(namePart, searchQuery)}
                        </span>
                        {dirPart ? (
                          <span className="doc-tree-search-dir">
                            {highlightMatches(dirPart, searchQuery)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {searchListing.truncated ? (
                  <div className="doc-tree-note">
                    {t("ui.document.searchTruncated")}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="doc-tree-note">
                {searchBusy
                  ? t("ui.document.searchBusy")
                  : t("ui.document.searchNoResults")}
              </div>
            )
          ) : (
            <div className="doc-tree-note">
              {searchBusy
                ? t("ui.document.searchBusy")
                : t("ui.document.searchNoResults")}
            </div>
          )
        ) : !root ? (
          <div className="doc-tree-note">{t("ui.document.treeNoRoot")}</div>
        ) : rootState?.error ? (
          <div className="doc-tree-note error" role="alert">
            {rootState.error}
          </div>
        ) : rootState?.entries ? (
          rootState.entries.length ? (
            renderDir(rootState.entries, 0)
          ) : (
            <div className="doc-tree-note">{t("ui.document.treeEmpty")}</div>
          )
        ) : (
          <div className="doc-tree-note">{t("ui.document.treeLoading")}</div>
        )}
      </div>
    </div>
  );
}
