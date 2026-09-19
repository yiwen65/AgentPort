// Git decorations for the document tree: VSCode-style name colors, status
// badges, directory change dots and dimmed ignored files. Data comes from
// the existing `get_git_changes` snapshot (per-file entries with checkout-
// relative display paths); no backend additions. The pure index/decoration
// functions are separated from the refreshing module state so both sides
// are unit-testable.

import { api } from "./api";
import { getState, type AppState } from "./store";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitContextLocator,
} from "./types";

export type DocGitStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "renamed"
  | "conflict";

export type DocGitBadge = "M" | "A" | "U" | "D" | "R" | "!";

export interface DocGitDecoration {
  /** File-level status driving name color (dirs stay uncolored). */
  status: DocGitStatus | null;
  /** Letter badge on the row's right edge; dirs never get one (dot only). */
  badge: DocGitBadge | null;
  /** Ignored by git — itself or any ancestor directory. */
  dimmed: boolean;
  /** Directory contains ≥1 changed descendant (or is itself a change). */
  dirChanged: boolean;
  /** Worst descendant status, driving the directory dot color. */
  dirStatus: DocGitStatus | null;
}

interface IndexedEntry {
  status: DocGitStatus;
  badge: DocGitBadge;
}

export interface DocGitIndex {
  /** Absolute checkout root used to relativize tree row paths. */
  checkoutRoot: string;
  /** Changed entries by checkout-relative path (untracked/ignored directory
   * entries are stored without their trailing slash). */
  entries: Map<string, IndexedEntry>;
  /** Ignored paths: exact files/dirs (no trailing slash). */
  ignoredPaths: Set<string>;
  /** Ignored directories whose descendants inherit dimming. */
  ignoredDirs: Set<string>;
  /** Untracked-collapsed directories whose descendants count as untracked. */
  untrackedDirs: Set<string>;
  /** Every directory containing ≥1 change → its worst status (dot color). */
  changedDirs: Map<string, DocGitStatus>;
}

const CLEAN: DocGitDecoration = {
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
function worseStatus(a: DocGitStatus, b: DocGitStatus): DocGitStatus {
  const rank = (status: DocGitStatus) =>
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

/** Builds the decoration index from a git status snapshot. */
export function buildDocGitIndex(snapshot: GitChangesSnapshot): DocGitIndex {
  const index: DocGitIndex = {
    checkoutRoot: snapshot.context.checkoutRoot,
    entries: new Map(),
    ignoredPaths: new Set(),
    ignoredDirs: new Set(),
    untrackedDirs: new Set(),
    changedDirs: new Map(),
  };
  for (const entry of snapshot.entries) {
    const isDirEntry = entry.displayPath.endsWith("/");
    const rel = isDirEntry ? entry.displayPath.slice(0, -1) : entry.displayPath;
    if (!rel) continue;

    if (entry.kind === "ignored") {
      index.ignoredPaths.add(rel);
      if (isDirEntry) index.ignoredDirs.add(rel);
      continue;
    }
    const status = entryStatus(entry);
    if (!status) continue;

    if (isDirEntry && entry.kind === "untracked") {
      // git collapses fully-untracked directories into one `dir/` entry;
      // descendants count as untracked too.
      index.untrackedDirs.add(rel);
    }
    index.entries.set(rel, status);

    // Roll the change up to every ancestor for directory dots.
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

const EMPTY_DECORATION: DocGitDecoration = CLEAN;

/** Computes the decoration for one tree row (absolute path). Rows outside
 * the checkout are clean. */
export function decorateDocPath(
  index: DocGitIndex,
  absPath: string,
  isDir: boolean,
): DocGitDecoration {
  const prefix = `${index.checkoutRoot}/`;
  if (!absPath.startsWith(prefix)) return EMPTY_DECORATION;
  const rel = absPath.slice(prefix.length);
  if (!rel) return EMPTY_DECORATION;

  const dimmed = index.ignoredPaths.has(rel) || hasAncestor(index.ignoredDirs, rel);
  const own = index.entries.get(rel) ?? null;
  const inheritedUntracked = hasAncestor(index.untrackedDirs, rel);

  if (isDir) {
    // Untracked-collapsed dirs read as changes themselves; other dirs dot
    // only when a descendant changed. Dirs never get a letter badge and
    // their names stay uncolored (VSCode parity).
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

/* ------------------------------------------------------------------ *
 * Per-tree-root refreshing state (module store, useSyncExternalStore).
 * ------------------------------------------------------------------ */

export interface TreeGitState {
  phase: "loading" | "ready" | "unavailable";
  checkoutRoot: string | null;
  index: DocGitIndex | null;
  /** Snapshot timestamp; Git Center caches with a newer one take over. */
  observedAt: string | null;
}

const states = new Map<string, TreeGitState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeTreeGit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTreeGitState(root: string): TreeGitState | null {
  return states.get(root) ?? null;
}

function setTreeGitState(root: string, state: TreeGitState): void {
  states.set(root, state);
  emit();
}

/** Test hook: drop every cached tree-git state between cases. */
export function resetTreeGitForTests(): void {
  states.clear();
  emit();
}

/** Picks the git locator owning an explorer root: the deepest matching
 * worktree wins over the project main checkout. Roots outside every known
 * project return null (no decorations). */
export function locatorForExplorerRoot(
  root: string,
  state: Pick<AppState, "projects">,
): GitContextLocator | null {
  const contains = (path: string) => root === path || root.startsWith(`${path}/`);
  let best: { locator: GitContextLocator; depth: number } | null = null;
  for (const project of state.projects) {
    for (const worktree of project.worktrees) {
      if (contains(worktree.path) && worktree.path.length > (best?.depth ?? -1)) {
        best = {
          locator: { kind: "worktree", projectId: project.id, worktreeId: worktree.id },
          depth: worktree.path.length,
        };
      }
    }
    const main = project.gitRootPath ?? project.rootPath;
    if (contains(main) && main.length > (best?.depth ?? -1)) {
      best = { locator: { kind: "projectMain", projectId: project.id }, depth: main.length };
    }
  }
  return best?.locator ?? null;
}

/** Fetches (or refetches) the git snapshot for a tree root. Failures —
 * including "not a git repository" — resolve to the silent unavailable
 * state: decorations are best-effort and never block the tree. */
export async function refreshTreeGit(root: string): Promise<void> {
  const locator = locatorForExplorerRoot(root, getState());
  if (!locator) {
    setTreeGitState(root, {
      phase: "unavailable",
      checkoutRoot: null,
      index: null,
      observedAt: null,
    });
    return;
  }
  const previous = states.get(root);
  setTreeGitState(root, {
    phase: "loading",
    checkoutRoot: previous?.checkoutRoot ?? null,
    index: previous?.index ?? null,
    observedAt: previous?.observedAt ?? null,
  });
  try {
    const snapshot = await api.getGitChanges(locator, true);
    setTreeGitState(root, {
      phase: "ready",
      checkoutRoot: snapshot.context.checkoutRoot,
      index: buildDocGitIndex(snapshot),
      observedAt: snapshot.observedAt,
    });
  } catch {
    setTreeGitState(root, {
      phase: "unavailable",
      checkoutRoot: null,
      index: null,
      observedAt: null,
    });
  }
}
