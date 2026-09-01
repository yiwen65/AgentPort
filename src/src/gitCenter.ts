import {
  api,
  commitAiErrorText,
  errorText,
  isGitWorkspaceCommandError,
} from "./api";
import { refreshProjects } from "./actions";
import { openDocumentTarget } from "./documents";
import { i18n } from "./i18n";
import {
  confirmDialog,
  emptyGitCenterState,
  getState,
  setState,
  toast,
  update,
  type GitCheckoutUiState,
  type GitDiffSelection,
} from "./store";
import type {
  GitChangeEntry,
  GitChangesSnapshot,
  GitContextLocator,
  GitDiffSide,
  GitIgnoreTarget,
  GitPathSelection,
  GitRemoteAction,
  GitStateInvalidated,
} from "./types";

type RequestScope =
  | "changes"
  | "diff"
  | "history"
  | "commitDetail"
  | "commitPatch"
  | "mutation"
  | "commitAi"
  | "review"
  | "commit";

let resolveSequence = 0;
const requestSequences = new Map<string, Record<RequestScope, number>>();
const invalidationTimers = new Map<string, number>();

function locatorKey(locator: GitContextLocator): string {
  switch (locator.kind) {
    case "session":
      return `session:${locator.sessionId}`;
    case "projectMain":
      return `project:${locator.projectId}:main`;
    case "worktree":
      return `project:${locator.projectId}:worktree:${locator.worktreeId}`;
  }
}

function sameLocator(
  left: GitContextLocator | null,
  right: GitContextLocator | null,
): boolean {
  return left !== null && right !== null && locatorKey(left) === locatorKey(right);
}

function nextRequest(checkoutId: string, scope: RequestScope): number {
  const current = requestSequences.get(checkoutId) ?? {
    changes: 0,
    diff: 0,
    history: 0,
    commitDetail: 0,
    commitPatch: 0,
    mutation: 0,
    commitAi: 0,
    review: 0,
    commit: 0,
  };
  const next = { ...current, [scope]: current[scope] + 1 };
  requestSequences.set(checkoutId, next);
  return next[scope];
}

function requestIsCurrent(
  checkoutId: string,
  scope: RequestScope,
  request: number,
): boolean {
  return getState().gitCenter.activeCheckoutId === checkoutId &&
    requestSequences.get(checkoutId)?.[scope] === request;
}

function createCheckoutState(
  context: GitCheckoutUiState["context"],
): GitCheckoutUiState {
  return {
    context,
    changes: null,
    changesPhase: "idle",
    changesError: null,
    selectedEntries: {},
    diffSelection: null,
    diff: null,
    diffPhase: "idle",
    diffError: null,
    history: null,
    historyPhase: "idle",
    historyError: null,
    selectedCommitOid: null,
    commitDetail: null,
    commitPatch: null,
    commitDetailPhase: "idle",
    commitDetailError: null,
    commitDraft: "",
    commitReview: null,
    commitReviewOpen: false,
    commitPhase: "idle",
    commitError: null,
    commitAiPhase: "idle",
    commitAiError: null,
    lastCommitResult: null,
  };
}

function updateCheckout(
  checkoutId: string,
  mutate: (current: GitCheckoutUiState) => GitCheckoutUiState,
) {
  update((state) => {
    const current = state.gitCenter.caches[checkoutId];
    if (!current) return {};
    return {
      gitCenter: {
        ...state.gitCenter,
        caches: {
          ...state.gitCenter.caches,
          [checkoutId]: mutate(current),
        },
      },
    };
  });
}

function activeTarget(): {
  checkoutId: string;
  locator: GitContextLocator;
  cache: GitCheckoutUiState;
} | null {
  const center = getState().gitCenter;
  if (!center.activeCheckoutId || !center.locator) return null;
  const cache = center.caches[center.activeCheckoutId];
  return cache
    ? { checkoutId: center.activeCheckoutId, locator: center.locator, cache }
    : null;
}

function hasPendingUserWork(cache: GitCheckoutUiState | undefined): boolean {
  return Boolean(
    cache &&
      (cache.commitDraft.trim().length > 0 ||
        Object.keys(cache.selectedEntries).length > 0 ||
        cache.commitReviewOpen),
  );
}

async function allowTargetChange(locator: GitContextLocator): Promise<boolean> {
  const center = getState().gitCenter;
  if (!center.open || sameLocator(center.locator, locator)) return true;
  const cache = center.activeCheckoutId
    ? center.caches[center.activeCheckoutId]
    : undefined;
  if (!hasPendingUserWork(cache)) return true;
  return confirmDialog({
    title: i18n.t("git:targetSwitch.title"),
    body: i18n.t("git:targetSwitch.body"),
    confirmLabel: i18n.t("git:targetSwitch.confirm"),
  });
}

/** Open Git Center and freeze it to the backend-resolved checkout. */
export async function openGitCenter(locator: GitContextLocator): Promise<void> {
  if (!(await allowTargetChange(locator))) return;
  const sequence = ++resolveSequence;
  const sourceActiveSessionId = getState().activeSessionId;
  update((state) => ({
    gitCenter: {
      ...state.gitCenter,
      open: true,
      locator,
      sourceActiveSessionId,
      activeCheckoutId: null,
      resolvePhase: "loading",
      resolveError: null,
      pendingSessionLocator: null,
    },
  }));
  try {
    const context = await api.resolveGitContext(locator);
    const center = getState().gitCenter;
    if (
      sequence !== resolveSequence ||
      !center.open ||
      !sameLocator(center.locator, locator)
    ) {
      return;
    }
    update((state) => {
      const existing = state.gitCenter.caches[context.checkoutId];
      return {
        gitCenter: {
          ...state.gitCenter,
          activeCheckoutId: context.checkoutId,
          resolvePhase: "ready",
          resolveError: null,
          caches: {
            ...state.gitCenter.caches,
            [context.checkoutId]: existing
              ? { ...existing, context }
              : createCheckoutState(context),
          },
        },
      };
    });
    await Promise.all([
      refreshGitChanges({ initial: true }),
      refreshGitHistory({ reset: true, initial: true }),
    ]);
  } catch (error) {
    if (sequence !== resolveSequence) return;
    update((state) => ({
      gitCenter: {
        ...state.gitCenter,
        resolvePhase: "error",
        resolveError: errorText(error),
      },
    }));
  }
}

export function closeGitCenter() {
  resolveSequence += 1;
  update((state) => ({
    gitCenter: {
      ...state.gitCenter,
      open: false,
      pendingSessionLocator: null,
    },
  }));
}

export function setGitCenterView(view: "changes" | "history") {
  update((state) => ({ gitCenter: { ...state.gitCenter, view } }));
}

export function noteActiveSessionForGitCenter(sessionId: string | null) {
  const center = getState().gitCenter;
  if (!center.open || !sessionId || center.sourceActiveSessionId === sessionId) return;
  if (
    center.pendingSessionLocator?.kind === "session" &&
    center.pendingSessionLocator.sessionId === sessionId
  ) {
    return;
  }
  update((state) => ({
    gitCenter: {
      ...state.gitCenter,
      pendingSessionLocator: { kind: "session", sessionId },
    },
  }));
}

export function keepFrozenGitTarget() {
  update((state) => ({
    gitCenter: {
      ...state.gitCenter,
      sourceActiveSessionId: state.activeSessionId,
      pendingSessionLocator: null,
    },
  }));
}

export async function switchGitCenterToPendingSession() {
  const locator = getState().gitCenter.pendingSessionLocator;
  if (locator) await openGitCenter(locator);
}

export function setGitSelection(
  entry: GitChangeEntry,
  side: GitDiffSide,
  selected: boolean,
) {
  const target = activeTarget();
  if (!target) return;
  const key = `${side}:${entry.entryToken}`;
  updateCheckout(target.checkoutId, (cache) => {
    const selectedEntries = { ...cache.selectedEntries };
    if (selected) selectedEntries[key] = true;
    else delete selectedEntries[key];
    return { ...cache, selectedEntries };
  });
}

export function setAllGitSelections(
  entries: GitChangeEntry[],
  side: GitDiffSide,
  selected: boolean,
) {
  const target = activeTarget();
  if (!target) return;
  updateCheckout(target.checkoutId, (cache) => {
    const selectedEntries = { ...cache.selectedEntries };
    for (const entry of entries) {
      const key = `${side}:${entry.entryToken}`;
      if (selected) selectedEntries[key] = true;
      else delete selectedEntries[key];
    }
    return { ...cache, selectedEntries };
  });
}

function selectedPaths(
  cache: GitCheckoutUiState,
  side: GitDiffSide,
  explicitEntry?: GitChangeEntry,
): GitPathSelection[] {
  const entries = explicitEntry
    ? [explicitEntry]
    : (cache.changes?.entries ?? []).filter(
      (entry) => cache.selectedEntries[`${side}:${entry.entryToken}`],
    );
  const deduplicated = new Map<string, GitPathSelection>();
  for (const entry of entries) {
    deduplicated.set(entry.entryToken, {
      pathToken: entry.pathToken,
      entryToken: entry.entryToken,
    });
  }
  return [...deduplicated.values()];
}

function pathSelection(entry: GitChangeEntry): GitPathSelection {
  return {
    pathToken: entry.pathToken,
    entryToken: entry.entryToken,
  };
}

function applyAuthoritativeChanges(
  checkoutId: string,
  changes: GitChangesSnapshot,
  options: { clearSelection?: boolean } = {},
) {
  if (changes.context.checkoutId !== checkoutId) return;
  updateCheckout(checkoutId, (cache) => {
    const reviewStillCurrent = Boolean(
      cache.commitReview &&
        cache.commitReview.message === cache.commitDraft &&
        cache.changes?.statusToken === changes.statusToken &&
        cache.context.headOid === changes.context.headOid,
    );
    const alive = new Set(changes.entries.map((entry) => entry.entryToken));
    const selectedEntries = options.clearSelection
      ? {}
      : Object.fromEntries(
        Object.entries(cache.selectedEntries).filter(([key]) => {
          const entryToken = key.slice(key.indexOf(":") + 1);
          return alive.has(entryToken);
        }),
      );
    const selectedAlive = cache.diffSelection &&
      changes.entries.some((entry) => entry.entryToken === cache.diffSelection?.entryToken);
    const history = cache.history &&
      cache.history.anchorOid !== changes.context.headOid
      ? { ...cache.history, headChanged: true }
      : cache.history;
    return {
      ...cache,
      context: changes.context,
      changes,
      changesPhase: "ready",
      changesError: null,
      selectedEntries,
      diffSelection: selectedAlive ? cache.diffSelection : null,
      diff: selectedAlive && cache.diff?.statusToken === changes.statusToken
        ? cache.diff
        : null,
      diffPhase: selectedAlive && cache.diff?.statusToken === changes.statusToken
        ? cache.diffPhase
        : "idle",
      history,
      commitReview: reviewStillCurrent ? cache.commitReview : null,
      commitReviewOpen: reviewStillCurrent && cache.commitReviewOpen,
    };
  });
}

function applyWriteError(checkoutId: string, error: unknown) {
  // A write response carries the newest authoritative snapshot. Any status
  // request that started before the write must not overwrite it later.
  nextRequest(checkoutId, "changes");
  const structured = isGitWorkspaceCommandError(error) ? error : null;
  if (
    structured?.currentChanges &&
    structured.currentChanges.context.checkoutId === checkoutId
  ) {
    applyAuthoritativeChanges(checkoutId, structured.currentChanges);
  }
  updateCheckout(checkoutId, (cache) => ({
    ...cache,
    changesPhase: structured?.code === "stale" ? "stale" : "error",
    changesError: structured?.message ?? errorText(error),
    commitReview: null,
    commitReviewOpen: false,
  }));
}

export async function refreshGitChanges(
  options: { initial?: boolean } = {},
): Promise<void> {
  const target = activeTarget();
  if (!target) return;
  if (
    target.cache.changesPhase === "refreshing" ||
    target.cache.commitPhase === "loading"
  ) {
    return;
  }
  const { checkoutId, locator, cache } = target;
  const request = nextRequest(checkoutId, "changes");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    changesPhase: options.initial && !current.changes ? "loading" : "refreshing",
    changesError: null,
  }));
  try {
    const changes = await api.getGitChanges(locator, true);
    if (
      !requestIsCurrent(checkoutId, "changes", request) ||
      changes.context.checkoutId !== checkoutId
    ) {
      return;
    }
    applyAuthoritativeChanges(checkoutId, changes);
    if (
      cache.diffSelection &&
      changes.entries.some((entry) => entry.entryToken === cache.diffSelection?.entryToken)
    ) {
      void selectGitDiff(cache.diffSelection);
    }
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "changes", request)) return;
    updateCheckout(checkoutId, (current) => ({
      ...current,
      changesPhase: "error",
      changesError: errorText(error),
    }));
  }
}

export async function selectGitDiff(selection: GitDiffSelection): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes) return;
  const { checkoutId, locator } = target;
  const statusToken = target.cache.changes.statusToken;
  const request = nextRequest(checkoutId, "diff");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    diffSelection: selection,
    diff: null,
    diffPhase: "loading",
    diffError: null,
  }));
  try {
    const diff = await api.getGitDiff(
      locator,
      statusToken,
      selection.side,
      selection.pathToken,
    );
    const selected = activeTarget()?.cache.diffSelection;
    if (
      !requestIsCurrent(checkoutId, "diff", request) ||
      diff.context.checkoutId !== checkoutId ||
      !selected ||
      selected.entryToken !== selection.entryToken ||
      selected.side !== selection.side
    ) {
      return;
    }
    updateCheckout(checkoutId, (current) => ({
      ...current,
      diff,
      diffPhase: "ready",
      diffError: null,
    }));
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "diff", request)) return;
    const stale = isGitWorkspaceCommandError(error) && error.code === "stale";
    updateCheckout(checkoutId, (current) => ({
      ...current,
      diffPhase: "error",
      diffError: errorText(error),
      changesPhase: stale ? "stale" : current.changesPhase,
    }));
    if (stale) void refreshGitChanges();
  }
}

export async function mutateGitSelection(
  side: GitDiffSide,
  explicitEntry?: GitChangeEntry,
): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes || !gitWritesEnabled(target.cache)) return;
  const { checkoutId, locator, cache } = target;
  const statusToken = target.cache.changes.statusToken;
  const selections = selectedPaths(cache, side, explicitEntry);
  await mutateGitPaths(checkoutId, locator, statusToken, side, selections);
}

export async function adoptCurrentGitWorktreeBranch(): Promise<void> {
  const target = activeTarget();
  if (!target) return;
  const { checkoutId, locator, cache } = target;
  const { context } = cache;
  const expectedBranch = context.expectedBranch;
  const actualBranch = context.actualBranch;
  if (
    context.target.kind !== "worktree" ||
    !expectedBranch ||
    !actualBranch ||
    expectedBranch === actualBranch ||
    context.blockers.length !== 1 ||
    context.blockers[0] !== "worktree_branch_drift"
  ) {
    return;
  }
  const confirmed = await confirmDialog({
    title: i18n.t("git:branchAdoption.title"),
    body: i18n.t("git:branchAdoption.body", {
      expectedBranch,
      actualBranch,
    }),
    details: context.liveSessionIds.length
      ? [
        i18n.t("git:branchAdoption.activeSessions", {
          count: context.liveSessionIds.length,
        }),
      ]
      : undefined,
    confirmLabel: i18n.t("git:branchAdoption.confirm"),
  });
  if (!confirmed) return;

  const request = nextRequest(checkoutId, "mutation");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    changesPhase: "refreshing",
    changesError: null,
  }));
  try {
    const changes = await api.adoptCurrentGitWorktreeBranch(
      locator,
      checkoutId,
      expectedBranch,
      actualBranch,
    );
    if (
      !requestIsCurrent(checkoutId, "mutation", request) ||
      changes.context.checkoutId !== checkoutId
    ) {
      return;
    }
    nextRequest(checkoutId, "changes");
    applyAuthoritativeChanges(checkoutId, changes);
    toast(i18n.t("git:branchAdoption.succeeded"), "success");
    await refreshProjects();
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "mutation", request)) return;
    applyWriteError(checkoutId, error);
  }
}

export async function mutateAllGitChanges(side: GitDiffSide): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes || !gitWritesEnabled(target.cache)) return;
  const entries = target.cache.changes.entries.filter((entry) =>
    side === "staged"
      ? entry.staged && !entry.conflicted
      : !entry.ignored &&
        (entry.unstaged || entry.untracked || entry.conflicted)
  );
  await mutateGitPaths(
    target.checkoutId,
    target.locator,
    target.cache.changes.statusToken,
    side,
    entries.map(pathSelection),
  );
}

async function mutateGitPaths(
  checkoutId: string,
  locator: GitContextLocator,
  statusToken: string,
  side: GitDiffSide,
  selections: GitPathSelection[],
): Promise<void> {
  if (selections.length === 0) return;
  const request = nextRequest(checkoutId, "mutation");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    changesPhase: "refreshing",
    changesError: null,
  }));
  try {
    const result = side === "staged"
      ? await api.unstageGitPaths(
        locator,
        checkoutId,
        statusToken,
        selections,
      )
      : await api.stageGitPaths(
        locator,
        checkoutId,
        statusToken,
        selections,
      );
    if (
      !requestIsCurrent(checkoutId, "mutation", request) ||
      result.changes.context.checkoutId !== checkoutId
    ) {
      return;
    }
    nextRequest(checkoutId, "changes");
    applyAuthoritativeChanges(checkoutId, result.changes, {
      clearSelection: true,
    });
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "mutation", request)) return;
    applyWriteError(checkoutId, error);
  }
}

async function runFileMutation(
  operation: (
    locator: GitContextLocator,
    checkoutId: string,
    statusToken: string,
  ) => Promise<{ changes: GitChangesSnapshot }>,
): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes || !gitWritesEnabled(target.cache)) return;
  const { checkoutId, locator } = target;
  const request = nextRequest(checkoutId, "mutation");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    changesPhase: "refreshing",
    changesError: null,
  }));
  try {
    const result = await operation(
      locator,
      checkoutId,
      target.cache.changes.statusToken,
    );
    if (
      !requestIsCurrent(checkoutId, "mutation", request) ||
      result.changes.context.checkoutId !== checkoutId
    ) {
      return;
    }
    nextRequest(checkoutId, "changes");
    applyAuthoritativeChanges(checkoutId, result.changes, {
      clearSelection: true,
    });
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "mutation", request)) return;
    applyWriteError(checkoutId, error);
  }
}

export async function discardGitEntry(entry: GitChangeEntry): Promise<void> {
  const confirmed = await confirmDialog({
    title: i18n.t("git:fileActions.discardTitle"),
    body: i18n.t("git:fileActions.discardBody", { path: entry.displayPath }),
    confirmLabel: i18n.t("git:fileActions.discard"),
    danger: true,
  });
  if (!confirmed) return;
  await runFileMutation((locator, checkoutId, statusToken) =>
    api.discardGitPaths(
      locator,
      checkoutId,
      statusToken,
      [pathSelection(entry)],
    )
  );
}

export async function ignoreGitEntry(
  entry: GitChangeEntry,
  target: GitIgnoreTarget,
): Promise<void> {
  await runFileMutation((locator, checkoutId, statusToken) =>
    api.addGitIgnore(
      locator,
      checkoutId,
      statusToken,
      pathSelection(entry),
      target,
    )
  );
}

export async function trashGitEntry(entry: GitChangeEntry): Promise<void> {
  const confirmed = await confirmDialog({
    title: i18n.t("git:fileActions.trashTitle"),
    body: i18n.t("git:fileActions.trashBody", { path: entry.displayPath }),
    confirmLabel: i18n.t("git:fileActions.trash"),
    danger: true,
  });
  if (!confirmed) return;
  await runFileMutation((locator, checkoutId, statusToken) =>
    api.trashGitPath(
      locator,
      checkoutId,
      statusToken,
      pathSelection(entry),
    )
  );
}

export async function openGitFile(entry: GitChangeEntry): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes) return;
  try {
    const resolved = await api.resolveGitFile(
      target.locator,
      target.checkoutId,
      target.cache.changes.statusToken,
      pathSelection(entry),
    );
    if (
      resolved.context.checkoutId !== target.checkoutId ||
      activeTarget()?.checkoutId !== target.checkoutId
    ) {
      return;
    }
    closeGitCenter();
    openDocumentTarget({ path: resolved.absolutePath, line: null });
  } catch (error) {
    toast(errorText(error), "error");
  }
}

export async function runGitRemoteAction(action: GitRemoteAction): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes || !gitWritesEnabled(target.cache)) return;
  const context = target.cache.context;
  const requestedAction = action === "pull_autostash"
    ? "pull"
    : action === "pull_rebase_autostash"
    ? "pull_rebase"
    : action;
  const pulling = requestedAction === "pull" || requestedAction === "pull_rebase";
  const localChanges = target.cache.changes.entries.filter((entry) => !entry.ignored);
  const activeSessionWarning = pulling && context.liveSessionIds.length > 0
    ? i18n.t("git:remote.confirm.sessionWarning", {
      count: context.liveSessionIds.length,
    })
    : null;
  const noIncomingWarning = pulling && context.behind === 0
    ? i18n.t("git:remote.confirm.noIncoming")
    : null;
  const pullActionName = requestedAction === "pull" ? "Pull" : "Pull Rebase";
  let effectiveAction = action;

  if (pulling && localChanges.length > 0) {
    const confirmed = await confirmDialog({
      title: i18n.t("git:remote.dirty.title", {
        action: pullActionName,
      }),
      body: i18n.t("git:remote.dirty.body"),
      details: [
        i18n.t("git:remote.confirm.target", {
          branch: context.actualBranch ?? "—",
          upstream: context.upstream ?? context.remote ?? "—",
        }),
        noIncomingWarning,
        activeSessionWarning,
      ].filter((detail): detail is string => Boolean(detail)),
      confirmLabel: i18n.t("git:remote.dirty.confirm", {
        action: pullActionName,
      }),
      cancelLabel: i18n.t("git:remote.dirty.commitFirst"),
    });
    if (!confirmed) {
      document.querySelector<HTMLTextAreaElement>(
        ".git-commit-composer textarea",
      )?.focus();
      return;
    }
    effectiveAction = requestedAction === "pull"
      ? "pull_autostash"
      : "pull_rebase_autostash";
  } else if (requestedAction !== "fetch") {
    const confirmed = await confirmDialog({
      title: i18n.t(`git:remote.confirm.${requestedAction}.title`),
      body: i18n.t(`git:remote.confirm.${requestedAction}.body`, {
        branch: context.actualBranch ?? "—",
        upstream: context.upstream ?? context.remote ?? "—",
      }),
      details: [noIncomingWarning, activeSessionWarning]
        .filter((detail): detail is string => Boolean(detail)),
      confirmLabel: i18n.t(`git:remote.actions.${requestedAction}`),
      danger: requestedAction === "force_push",
    });
    if (!confirmed) return;
  }
  await runFileMutation((locator, checkoutId, statusToken) =>
    api.syncGitRemote(locator, checkoutId, statusToken, effectiveAction)
  );
  if (activeTarget()?.cache.changesPhase === "ready") {
    toast(i18n.t(`git:remote.success.${requestedAction}`), "success");
  }
}

export async function refreshGitHistory(
  options: { reset?: boolean; initial?: boolean } = {},
): Promise<void> {
  const target = activeTarget();
  if (!target) return;
  const { checkoutId, locator, cache } = target;
  const reset = options.reset ?? false;
  const cursor = reset ? null : cache.history?.nextCursor ?? null;
  if (!reset && cache.history && !cursor) return;
  const request = nextRequest(checkoutId, "history");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    historyPhase: options.initial && !current.history ? "loading" : "refreshing",
    historyError: null,
  }));
  try {
    const page = await api.getGitHistory(locator, cursor, 50);
    if (
      !requestIsCurrent(checkoutId, "history", request) ||
      page.context.checkoutId !== checkoutId
    ) {
      return;
    }
    updateCheckout(checkoutId, (current) => {
      const history = !reset &&
        current.history &&
        current.history.anchorOid === page.anchorOid
        ? {
          ...page,
          commits: [...current.history.commits, ...page.commits],
          headChanged: current.history.headChanged || page.headChanged,
        }
        : page;
      return {
        ...current,
        context: page.context,
        history,
        historyPhase: "ready",
        historyError: null,
      };
    });
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "history", request)) return;
    updateCheckout(checkoutId, (current) => ({
      ...current,
      historyPhase: "error",
      historyError: errorText(error),
    }));
  }
}

export async function selectGitCommit(
  commitOid: string,
  parentOid?: string | null,
): Promise<void> {
  const target = activeTarget();
  if (!target) return;
  const { checkoutId, locator } = target;
  const request = nextRequest(checkoutId, "commitDetail");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    selectedCommitOid: commitOid,
    commitDetail: null,
    commitPatch: null,
    commitDetailPhase: "loading",
    commitDetailError: null,
  }));
  try {
    const detail = await api.getGitCommitDetail(locator, commitOid);
    if (
      !requestIsCurrent(checkoutId, "commitDetail", request) ||
      detail.context.checkoutId !== checkoutId ||
      activeTarget()?.cache.selectedCommitOid !== commitOid
    ) {
      return;
    }
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitDetail: detail,
      commitDetailPhase: "ready",
      commitDetailError: null,
    }));
    await loadGitCommitPatch(
      commitOid,
      parentOid === undefined ? detail.selectedParentOid : parentOid,
      null,
    );
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "commitDetail", request)) return;
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitDetailPhase: "error",
      commitDetailError: errorText(error),
    }));
  }
}

export async function loadGitCommitPatch(
  commitOid: string,
  parentOid: string | null,
  pathToken: string | null,
): Promise<void> {
  const target = activeTarget();
  if (!target || target.cache.selectedCommitOid !== commitOid) return;
  const { checkoutId, locator } = target;
  const request = nextRequest(checkoutId, "commitPatch");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    commitPatch: null,
    commitDetailPhase: current.commitDetail ? "refreshing" : current.commitDetailPhase,
    commitDetailError: null,
  }));
  try {
    const patch = await api.getGitCommitDiff(
      locator,
      commitOid,
      parentOid,
      pathToken,
    );
    if (
      !requestIsCurrent(checkoutId, "commitPatch", request) ||
      patch.context.checkoutId !== checkoutId ||
      activeTarget()?.cache.selectedCommitOid !== commitOid
    ) {
      return;
    }
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitPatch: patch,
      commitDetailPhase: "ready",
      commitDetailError: null,
    }));
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "commitPatch", request)) return;
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitDetailPhase: "error",
      commitDetailError: errorText(error),
    }));
  }
}

export function setGitCommitDraft(message: string) {
  const target = activeTarget();
  if (!target) return;
  const cancelPendingReview = target.cache.commitPhase === "refreshing";
  const cancelPendingAi = target.cache.commitAiPhase === "loading";
  if (cancelPendingReview) nextRequest(target.checkoutId, "review");
  if (cancelPendingAi) nextRequest(target.checkoutId, "commitAi");
  updateCheckout(target.checkoutId, (cache) => ({
    ...cache,
    commitDraft: message,
    commitReview: cache.commitReview?.message === message ? cache.commitReview : null,
    commitReviewOpen: cache.commitReview?.message === message && cache.commitReviewOpen,
    commitPhase: cancelPendingReview ? "ready" : cache.commitPhase,
    commitError: null,
    commitAiPhase: cancelPendingAi ? "ready" : cache.commitAiPhase,
    commitAiError: null,
  }));
}

export async function generateGitCommitMessage(): Promise<void> {
  const target = activeTarget();
  if (
    !target?.cache.changes ||
    !gitCommitEnabled(target.cache) ||
    target.cache.changes.counts.staged === 0 ||
    target.cache.commitAiPhase === "loading"
  ) {
    return;
  }
  if (target.cache.commitDraft.trim()) {
    const replace = await confirmDialog({
      title: i18n.t("git:commit.aiReplaceTitle"),
      body: i18n.t("git:commit.aiReplaceBody"),
      confirmLabel: i18n.t("git:commit.aiReplaceConfirm"),
    });
    if (!replace) return;
  }

  const { checkoutId, locator } = target;
  const statusToken = target.cache.changes.statusToken;
  const request = nextRequest(checkoutId, "commitAi");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    commitAiPhase: "loading",
    commitAiError: null,
  }));
  try {
    const suggestion = await api.generateGitCommitMessage(
      locator,
      checkoutId,
      statusToken,
    );
    const current = activeTarget();
    if (
      !requestIsCurrent(checkoutId, "commitAi", request) ||
      current?.cache.changes?.statusToken !== statusToken ||
      suggestion.statusToken !== statusToken
    ) {
      if (requestIsCurrent(checkoutId, "commitAi", request)) {
        updateCheckout(checkoutId, (cache) => ({
          ...cache,
          commitAiPhase: "stale",
          commitAiError: i18n.t("git:commit.aiStale"),
        }));
      }
      return;
    }
    updateCheckout(checkoutId, (cache) => ({
      ...cache,
      commitDraft: suggestion.message,
      commitReview: null,
      commitReviewOpen: false,
      commitAiPhase: "ready",
      commitAiError: null,
      commitError: null,
    }));
    if (suggestion.truncated) {
      toast(i18n.t("git:commit.aiTruncated"), "info");
    }
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "commitAi", request)) return;
    updateCheckout(checkoutId, (cache) => ({
      ...cache,
      commitAiPhase: "error",
      commitAiError: commitAiErrorText(error),
    }));
  }
}

export async function prepareGitCommitReview(): Promise<void> {
  const target = activeTarget();
  if (!target?.cache.changes || !gitCommitEnabled(target.cache)) return;
  const { checkoutId, locator, cache } = target;
  const statusToken = target.cache.changes.statusToken;
  const message = cache.commitDraft;
  const request = nextRequest(checkoutId, "review");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    commitPhase: "refreshing",
    commitError: null,
    commitReview: null,
    commitReviewOpen: false,
  }));
  try {
    const review = await api.prepareGitCommit(
      locator,
      checkoutId,
      statusToken,
      message,
    );
    if (
      !requestIsCurrent(checkoutId, "review", request) ||
      review.context.checkoutId !== checkoutId ||
      activeTarget()?.cache.commitDraft !== message
    ) {
      return;
    }
    updateCheckout(checkoutId, (current) => ({
      ...current,
      context: review.context,
      commitReview: review,
      commitReviewOpen: true,
      commitPhase: "ready",
      commitError: null,
    }));
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "review", request)) return;
    const structured = isGitWorkspaceCommandError(error) ? error : null;
    if (
      structured?.currentChanges &&
      structured.currentChanges.context.checkoutId === checkoutId
    ) {
      applyAuthoritativeChanges(checkoutId, structured.currentChanges);
    }
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitPhase: "error",
      commitError: structured?.message ?? errorText(error),
      commitReview: null,
      commitReviewOpen: false,
    }));
  }
}

export function closeGitCommitReview() {
  const target = activeTarget();
  if (!target) return;
  updateCheckout(target.checkoutId, (cache) => ({
    ...cache,
    commitReviewOpen: false,
  }));
}

export async function confirmGitCommit(): Promise<void> {
  const target = activeTarget();
  const review = target?.cache.commitReview;
  if (
    !target ||
    !review ||
    !target.cache.commitReviewOpen ||
    target.cache.commitPhase === "loading" ||
    !gitCommitEnabled(target.cache)
  ) {
    return;
  }
  const { checkoutId, locator } = target;
  const request = nextRequest(checkoutId, "commit");
  updateCheckout(checkoutId, (current) => ({
    ...current,
    commitPhase: "loading",
    commitError: null,
  }));
  try {
    const result = await api.commitGitChanges(
      locator,
      checkoutId,
      review.commitToken,
      review.message,
    );
    if (
      !requestIsCurrent(checkoutId, "commit", request) ||
      result.changes.context.checkoutId !== checkoutId
    ) {
      return;
    }
    nextRequest(checkoutId, "changes");
    applyAuthoritativeChanges(checkoutId, result.changes, {
      clearSelection: true,
    });
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitDraft: result.outcome === "succeeded" ? "" : current.commitDraft,
      commitReview: null,
      commitReviewOpen: false,
      commitPhase: result.outcome === "succeeded" ? "ready" : "error",
      commitError: result.outcome === "succeeded"
        ? null
        : result.error ?? i18n.t(`git:commit.outcomes.${result.outcome}`),
      lastCommitResult: result,
    }));
    if (result.outcome === "succeeded") {
      toast(i18n.t("git:commit.succeeded"), "success");
    }
    if (
      result.outcome === "succeeded" ||
      result.outcome === "scope_drift" ||
      (result.outcome === "indeterminate" && result.afterHead !== result.beforeHead)
    ) {
      await refreshGitHistory({ reset: true });
    }
  } catch (error) {
    if (!requestIsCurrent(checkoutId, "commit", request)) return;
    applyWriteError(checkoutId, error);
    updateCheckout(checkoutId, (current) => ({
      ...current,
      commitPhase: "error",
      commitError: isGitWorkspaceCommandError(error)
        ? error.message
        : errorText(error),
    }));
  }
}

export function gitWritesEnabled(cache: GitCheckoutUiState | null): boolean {
  return Boolean(
    cache?.changes &&
      cache.changesPhase === "ready" &&
      cache.changes.complete &&
      cache.context.writable &&
      cache.context.blockers.length === 0 &&
      cache.commitPhase !== "loading" &&
      cache.commitPhase !== "refreshing",
  );
}

export function gitCommitEnabled(cache: GitCheckoutUiState | null): boolean {
  return Boolean(
    gitWritesEnabled(cache) &&
      cache &&
      !cache.context.detached &&
      !cache.context.ongoingOperation &&
      (cache.changes?.counts.conflict ?? 0) === 0,
  );
}

function scheduleInvalidatedRefresh(checkoutId: string) {
  const existing = invalidationTimers.get(checkoutId);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    invalidationTimers.delete(checkoutId);
    if (
      getState().gitCenter.open &&
      getState().gitCenter.activeCheckoutId === checkoutId &&
      document.visibilityState === "visible"
    ) {
      void refreshGitChanges();
    }
  }, 350);
  invalidationTimers.set(checkoutId, timer);
}

export function handleGitStateInvalidation(event: GitStateInvalidated) {
  const center = getState().gitCenter;
  const checkoutId = center.activeCheckoutId;
  if (!center.open || !checkoutId) return;
  const cache = center.caches[checkoutId];
  if (!cache) return;
  const checkoutMatches =
    event.checkoutIds.length === 0 || event.checkoutIds.includes(checkoutId);
  const repoMatches = event.repoKey === null || event.repoKey === cache.context.repoKey;
  if (!checkoutMatches || !repoMatches) return;
  updateCheckout(checkoutId, (current) => ({
    ...current,
    changesPhase: "stale",
    history: event.scopes.includes("history") && current.history
      ? { ...current.history, headChanged: true }
      : current.history,
    commitReview: null,
    commitReviewOpen: false,
  }));
  scheduleInvalidatedRefresh(checkoutId);
}

/** Used by tests to isolate module-level request counters and store state. */
export function resetGitCenterStateForTests() {
  resolveSequence += 1;
  requestSequences.clear();
  for (const timer of invalidationTimers.values()) window.clearTimeout(timer);
  invalidationTimers.clear();
  setState({ gitCenter: emptyGitCenterState() });
}
