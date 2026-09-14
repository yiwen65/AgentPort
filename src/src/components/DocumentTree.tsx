// VSCode-like project file tree inside the document panel. Directories load
// lazily on expand (the backend lists one directory per call), files open in
// the panel's editor through the same path as terminal document links, and
// the header buttons create new files/directories below the active row.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, copyText, errorText } from "../api";
import { closeDocument, openDocumentTarget } from "../documents";
import { writeDragPayload } from "../terminalDrop";
import { confirmDialog, openContextMenu, toast, useStore } from "../store";
import type { DocumentDirEntry } from "../types";

interface DirState {
  entries: DocumentDirEntry[] | null;
  error: string | null;
  expanded: boolean;
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() ?? trimmed;
}

function parentDir(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : "/";
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

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4.25a1 1 0 0 1 1-1h2.6l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.25Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconFile() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.25L9 1.75Zm0 0v3.5h3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  const openPath = useStore((state) => state.openDocument?.path ?? null);
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [refreshToken, setRefreshToken] = useState(0);
  const [activeDir, setActiveDir] = useState<string | null>(null);
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const createInputRef = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const createBaseDir = activeDir ?? root;

  const loadDir = useCallback((path: string, expand: boolean) => {
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
    void api
      .listDocumentDirectory(path)
      .then((listing) => {
        setDirs((current) => {
          const next = new Map(current);
          next.set(path, { entries: listing.entries, error: null, expanded: expand });
          return next;
        });
      })
      .catch((e) => {
        setDirs((current) => {
          const next = new Map(current);
          next.set(path, { entries: null, error: errorText(e), expanded: expand });
          return next;
        });
      });
  }, []);

  // Load (or reload) the root directory.
  useEffect(() => {
    if (!root) return;
    setDirs(new Map());
    loadDir(root, true);
  }, [root, refreshToken, loadDir]);

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
    setActiveDir(base);
    setRenaming(null);
    setCreating(kind);
    setNameDraft("");
    setCreateError(null);
  };

  /** Error toast wrapper for fire-and-forget menu actions. */
  const runAction = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
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
    try {
      const result = await api.renameDocumentEntry(renaming, newPath);
      const oldPath = renaming;
      setRenaming(null);
      loadDir(parent, true);
      // Keep the viewer pointed at the renamed file.
      if (openPath === oldPath) openDocumentTarget({ path: result.path, line: null });
    } catch (e) {
      setRenameError(errorText(e));
    }
  };

  const confirmDelete = async (entry: DocumentDirEntry) => {
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
      await api.deleteDocumentEntry(entry.path);
      loadDir(parentDir(entry.path), true);
      // The viewer must not keep a deleted file (or one inside a deleted
      // directory) on screen.
      if (openPath === entry.path || openPath?.startsWith(`${entry.path}/`)) {
        closeDocument();
      }
    });
  };

  /** VSCode-style row context menu (see design reference in the PR review). */
  const openEntryMenu = (event: React.MouseEvent, entry: DocumentDirEntry) => {
    event.preventDefault();
    const parent = entry.isDir ? entry.path : parentDir(entry.path);
    setActiveDir(parent);
    const relative =
      root && entry.path.startsWith(`${root}/`)
        ? entry.path.slice(root.length + 1)
        : entry.path;
    openContextMenu(event.clientX, event.clientY, [
      { label: t("ui.document.newFile"), action: () => startCreate("file", parent) },
      { label: t("ui.document.newDir"), action: () => startCreate("dir", parent) },
      { label: "", separator: true },
      {
        label: t("ui.document.openInVsCode"),
        action: () => void runAction(() => api.openInVsCode(entry.path)),
      },
      { label: "", separator: true },
      { label: t("ui.document.copyPath"), action: () => void copyText(entry.path) },
      { label: t("ui.document.copyRelativePath"), action: () => void copyText(relative) },
      {
        label: t("ui.document.reveal"),
        action: () => void runAction(() => api.revealInFileManager(entry.path)),
      },
      { label: "", separator: true },
      { label: t("ui.document.rename"), action: () => startRename(entry) },
      {
        label: t("ui.document.duplicate"),
        action: () =>
          void runAction(async () => {
            await api.duplicateDocumentEntry(entry.path);
            loadDir(parent, true);
          }),
      },
      { label: "", separator: true },
      {
        label: t("ui.document.deleteEntry"),
        danger: true,
        action: () => void confirmDelete(entry),
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
    setCreateBusy(true);
    try {
      const result = await api.createDocumentEntry(fullPath, creating);
      const kind = creating;
      setCreating(null);
      setNameDraft("");
      setCreateError(null);
      // Refresh the parent so the new entry shows up, then select/open it.
      loadDir(createBaseDir, true);
      if (kind === "dir") {
        setActiveDir(result.path);
      } else {
        openDocumentTarget({ path: result.path, line: null });
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
      const selected = !entry.isDir && openPath === entry.path;
      return (
        <div key={entry.path}>
          {renaming === entry.path ? (
            <div
              className={`doc-tree-row${entry.isDir ? " dir" : " file"}`}
              style={{ paddingLeft: 6 + depth * 16 }}
            >
              <span className="doc-tree-icon" aria-hidden="true">
                {entry.isDir ? <IconChevron expanded={expanded} /> : null}
              </span>
              <span className={`doc-tree-kind${entry.isDir ? " dir" : " file"}`} aria-hidden="true">
                {entry.isDir ? <IconFolder /> : <IconFile />}
              </span>
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
            className={`doc-tree-row${entry.isDir ? " dir" : " file"}${selected ? " selected" : ""}`}
            style={{ paddingLeft: 6 + depth * 16 }}
            data-tip={entry.path}
            draggable
            onContextMenu={(event) => openEntryMenu(event, entry)}
            onDragStart={(event) => {
              writeDragPayload(event.dataTransfer, { path: entry.path, isDir: entry.isDir });
            }}
            onClick={() => {
              if (entry.isDir) {
                toggleDir(entry.path);
              } else {
                setActiveDir(parentDir(entry.path));
                openDocumentTarget({ path: entry.path, line: null });
              }
            }}
          >
            <span className="doc-tree-icon" aria-hidden="true">
              {entry.isDir ? <IconChevron expanded={expanded} /> : null}
            </span>
            <span className={`doc-tree-kind${entry.isDir ? " dir" : " file"}`} aria-hidden="true">
              {entry.isDir ? <IconFolder /> : <IconFile />}
            </span>
            <span className="doc-tree-name">{entry.name}</span>
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
              style={{ "--guide-x": `${11 + depth * 16}px` } as React.CSSProperties}
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

  return (
    <div className="doc-tree" aria-label={t("ui.document.treeLabel")}>
      <div className="doc-tree-header">
        <span className="doc-tree-root" data-tip={root ?? ""}>
          {root ? baseName(root) : t("ui.document.treeLabel")}
        </span>
        <span className="spacer" />
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
          onClick={() => setRefreshToken((token) => token + 1)}
        >
          ⟳
        </button>
      </div>
      <div className="doc-tree-body" role="tree">
        {creating && createBaseDir ? (
          <div className="doc-tree-create">
            <span className="doc-tree-create-base" data-tip={createBaseDir}>
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
        {!root ? (
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
