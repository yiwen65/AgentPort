// Git decorations for the Session file tree, mirroring the desktop explorer:
// colored file names, letter badges, directory change dots and dimmed
// gitignored entries. Built from the existing `git.changes` snapshot, so no
// backend fields are added to `session.files.list`. Pure functions only; the
// caller owns fetching and caching.

import type {
  GitChangeEntry,
  GitChangesSnapshot,
} from "../git/types";

export type FileTreeGitStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflict";

export type FileTreeGitBadge = "M" | "A" | "U" | "D" | "R" | "!";

export interface FileTreeGitDecoration {
  /** File-level status driving name color (dirs stay uncolored). */
  status: FileTreeGitStatus | null;
  /** Letter badge at the row end; dirs never get one (dot only). */
  badge: FileTreeGitBadge | null;
  /** Ignored by git — itself or any ancestor directory. */
  dimmed: boolean;
  /** Directory contains at least one changed descendant (or is itself a change). */
  dirChanged: boolean;
  /** Worst descendant status, driving the directory dot color. */
  dirStatus: FileTreeGitStatus | null;
}

interface IndexedEntry {
  status: FileTreeGitStatus;
  badge: FileTreeGitBadge;
}

export interface FileTreeGitIndex {
  /** Absolute checkout root used to relativize tree row paths. */
  checkoutRoot: string;
  /** Changed entries by checkout-relative path (directory entries stored
   * without their trailing slash). */
  entries: Map<string, IndexedEntry>;
  /** Ignored paths: exact files/dirs (no trailing slash). */
  ignoredPaths: Set<string>;
  /** Ignored directories whose descendants inherit dimming. */
  ignoredDirs: Set<string>;
  /** Untracked-collapsed directories whose descendants count as untracked. */
  untrackedDirs: Set<string>;
  /** Every directory containing at least one change → its worst status. */
  changedDirs: Map<string, FileTreeGitStatus>;
}

const CLEAN: FileTreeGitDecoration = {
  status: null,
  badge: null,
  dimmed: false,
  dirChanged: false,
  dirStatus: null,
};

function entryStatus(entry: GitChangeEntry): IndexedEntry | null {
  if (entry.kind === "ignored") return null;
  if (entry.conflicted || entry.kind === "conflict") {
    return { status: "conflict", badge: "!" };
  }
  switch (entry.kind) {
    case "untracked":
      return { status: "untracked", badge: "U" };
    case "added":
      return { status: "added", badge: "A" };
    case "deleted":
      return { status: "deleted", badge: "D" };
    case "renamed":
      return { status: "renamed", badge: "R" };
    default:
      // modified / type_changed / copied all read as "modified".
      return { status: "modified", badge: "M" };
  }
}

/** Directory dot severity: conflict beats modified-ish beats new files. */
function worseStatus(
  a: FileTreeGitStatus,
  b: FileTreeGitStatus,
): FileTreeGitStatus {
  const rank = (status: FileTreeGitStatus) =>
    status === "conflict"
      ? 3
      : status === "added" || status === "untracked"
        ? 1
        : 2;
  return rank(a) >= rank(b) ? a : b;
}

function parentDir(rel: string): string | null {
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : null;
}

function normalizeRoot(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** Builds the decoration index from a git status snapshot. */
export function buildFileTreeGitIndex(
  snapshot: GitChangesSnapshot,
): FileTreeGitIndex {
  const index: FileTreeGitIndex = {
    checkoutRoot: normalizeRoot(snapshot.context.checkoutRoot),
    entries: new Map(),
    ignoredPaths: new Set(),
    ignoredDirs: new Set(),
    untrackedDirs: new Set(),
    changedDirs: new Map(),
  };
  for (const entry of snapshot.entries) {
    const isDirEntry = entry.displayPath.endsWith("/");
    const rel = isDirEntry
      ? entry.displayPath.slice(0, -1)
      : entry.displayPath;
    if (!rel) continue;

    if (entry.kind === "ignored") {
      index.ignoredPaths.add(rel);
      if (isDirEntry) index.ignoredDirs.add(rel);
      continue;
    }
    const status = entryStatus(entry);
    if (!status) continue;

    if (isDirEntry && entry.kind === "untracked") {
      // git may collapse a fully-untracked directory into one `dir/` entry;
      // descendants count as untracked too.
      index.untrackedDirs.add(rel);
    }
    index.entries.set(rel, status);

    for (let dir = parentDir(rel); dir !== null; dir = parentDir(dir)) {
      const current = index.changedDirs.get(dir);
      if (!current) index.changedDirs.set(dir, status.status);
      else if (current !== status.status) {
        index.changedDirs.set(dir, worseStatus(current, status.status));
      }
    }
  }
  return index;
}

function hasAncestor(set: Set<string>, rel: string): boolean {
  for (let dir = parentDir(rel); dir !== null; dir = parentDir(dir)) {
    if (set.has(dir)) return true;
  }
  return false;
}

/** Resolves a session-root-relative tree path to an absolute path. */
export function treeAbsolutePath(rootPath: string, relPath: string): string {
  const root = normalizeRoot(rootPath);
  const rel = relPath.replace(/^\/+/, "");
  return root === "/" ? `/${rel}` : `${root}/${rel}`;
}

/** Computes the decoration for one tree row. Rows outside the checkout —
 * for example when the Session cwd sits outside a repository — are clean. */
export function decorateFileTreePath(
  index: FileTreeGitIndex,
  rootPath: string,
  relPath: string,
  isDir: boolean,
): FileTreeGitDecoration {
  const prefix = index.checkoutRoot === "/" ? "/" : `${index.checkoutRoot}/`;
  const absPath = treeAbsolutePath(rootPath, relPath);
  if (!absPath.startsWith(prefix) || absPath.length === prefix.length) {
    return CLEAN;
  }
  const rel = absPath.slice(prefix.length);

  const dimmed =
    index.ignoredPaths.has(rel) || hasAncestor(index.ignoredDirs, rel);
  const own = index.entries.get(rel) ?? null;
  const inheritedUntracked = hasAncestor(index.untrackedDirs, rel);

  if (isDir) {
    // Untracked-collapsed dirs read as changes themselves; other dirs dot
    // only when a descendant changed. Dirs never get a letter badge and
    // their names stay uncolored, matching the desktop explorer.
    const dotStatus =
      own?.status ??
      index.changedDirs.get(rel) ??
      (inheritedUntracked ? "untracked" : null);
    return {
      status: null,
      badge: null,
      dimmed,
      dirChanged: dotStatus !== null,
      dirStatus: dotStatus,
    };
  }

  const status = own?.status ?? (inheritedUntracked ? "untracked" : null);
  const badge = own?.badge ?? (inheritedUntracked ? "U" : null);
  return {
    status,
    badge,
    dimmed,
    dirChanged: false,
    dirStatus: null,
  };
}
