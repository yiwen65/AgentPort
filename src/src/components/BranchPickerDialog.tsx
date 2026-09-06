// Local branch management deliberately renders from backend snapshots. Git can
// change outside AgentPort, so a successful click is never treated as a local
// checkout switch until the command result / repository event confirms it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import {
  api,
  asRecord,
  errorText,
  isStructuredGitError,
  onAutoStashChanged,
  onRepositoryOperationProgress,
  onRepositoryStateChanged,
} from "../api";
import {
  applyRepositoryStatusSnapshot,
  closeDialog,
  findSession,
  getState,
  markRepositoryStatusUnavailable,
  openWorktreeView,
  toast,
  useStore,
} from "../store";
import { copyTextWithToast, selectSession } from "../actions";
import {
  branchOperationPhaseLabel,
  recoveryActionLabel,
  repositoryProgressMessage,
} from "../format";
import type {
  AutoStashRecord,
  LocalBranch,
  LocalBranchesResponse,
  LifecycleStr,
  RepositoryOperationProgress,
  RepositoryStatus,
  SessionView,
} from "../types";
import Modal from "./Modal";

interface BranchFailure {
  message: string;
  liveSessionIds: string[];
  recoveryActions: string[];
  /** Branch the backend said could be force-deleted after a merged-only block. */
  forceDeleteBranch: string | null;
}

type CheckoutChangingOperation =
  | { kind: "switch"; branch: string }
  | { kind: "createAndSwitch"; branch: string; startPoint: string | null };

interface SessionHandlingIssue {
  affectedSessionIds: string[];
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** True when the backend tagged this failure as an unmerged-branch block that an explicit force delete may override. */
function forceDeleteOffered(error: unknown): boolean {
  const wrapped = asRecord(error)?.error;
  const structured = isStructuredGitError(error)
    ? error
    : isStructuredGitError(wrapped)
      ? wrapped
      : null;
  return structured
    ? stringIds(structured.recoveryActionCodes).includes("force_delete_branch")
    : false;
}

function operationFailure(error: unknown): BranchFailure {
  if (isStructuredGitError(error)) {
    return {
      message: error.message || (typeof error.diagnostics.message === "string" ? error.diagnostics.message : error.code),
      liveSessionIds: stringIds(error.liveSessionIds),
      recoveryActions: stringIds(error.recoveryActionCodes).length
        ? stringIds(error.recoveryActionCodes)
        : stringIds(error.recoveryActions),
      forceDeleteBranch: null,
    };
  }
  // Some adapters wrap the structured payload in an `error` field. Inspect
  // that object directly; never JSON.parse(errorText(...)) because doing so
  // loses metadata when Tauri changes its display formatting.
  const wrapped = asRecord(error)?.error;
  if (isStructuredGitError(wrapped)) {
    return {
      message: wrapped.message || (typeof wrapped.diagnostics.message === "string" ? wrapped.diagnostics.message : wrapped.code),
      liveSessionIds: stringIds(wrapped.liveSessionIds),
      recoveryActions: stringIds(wrapped.recoveryActionCodes).length
        ? stringIds(wrapped.recoveryActionCodes)
        : stringIds(wrapped.recoveryActions),
      forceDeleteBranch: null,
    };
  }
  return { message: errorText(error), liveSessionIds: [], recoveryActions: [], forceDeleteBranch: null };
}

function lifecycleLabel(
  lifecycle: LifecycleStr,
  t: TFunction<["worktree", "common"]>,
): string {
  switch (lifecycle) {
    case "creating":
      return t("worktree:ui.branchPicker.sessionHandling.lifecycle.creating");
    case "running":
      return t("worktree:ui.branchPicker.sessionHandling.lifecycle.running");
    case "interrupted":
      return t("worktree:ui.branchPicker.sessionHandling.lifecycle.interrupted");
    case "exited":
      return t("worktree:ui.branchPicker.sessionHandling.lifecycle.exited");
    case "stopped":
      return t("worktree:ui.branchPicker.sessionHandling.lifecycle.stopped");
  }
}

function headLabel(status: RepositoryStatus | null, t: TFunction<["worktree", "common"]>): string {
  if (!status) return t("worktree:ui.branchPicker.head.loadingCheckout");
  if (status.head?.kind === "branch") {
    return status.head.branch || t("worktree:ui.branchPicker.head.unnamedBranch");
  }
  if (status.head?.kind === "detached") {
    return t("worktree:ui.branchPicker.head.detachedAt", {
      oid: status.head.shortOid || status.head.oid?.slice(0, 12) || t("common:status.unknown"),
    });
  }
  return t("worktree:ui.branchPicker.head.uninitializedRepository");
}

function changesLabel(status: RepositoryStatus | null, t: TFunction<["worktree", "common"]>): string[] {
  if (!status) return [];
  const changes = status.changes ?? { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 };
  return [
    changes.staged ? t("worktree:ui.branchPicker.changes.staged", { count: changes.staged }) : "",
    changes.unstaged ? t("worktree:ui.branchPicker.changes.unstaged", { count: changes.unstaged }) : "",
    changes.untracked ? t("worktree:ui.branchPicker.changes.untracked", { count: changes.untracked }) : "",
    changes.unmerged ? t("worktree:ui.branchPicker.changes.unmerged", { count: changes.unmerged }) : "",
    changes.dirtySubmodules
      ? t("worktree:ui.branchPicker.changes.dirtySubmodules", { count: changes.dirtySubmodules })
      : "",
  ].filter(Boolean);
}

function BranchRow({
  branch,
  selected,
  disabled,
  deleteBlockedReason,
  confirmingDelete,
  onChoose,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onOpenWorktree,
  deleteButtonRef,
  confirmDeleteRef,
}: {
  branch: LocalBranch;
  selected: boolean;
  disabled: boolean;
  deleteBlockedReason: string | null;
  confirmingDelete: boolean;
  onChoose: (branch: LocalBranch) => void;
  onRequestDelete: (branch: LocalBranch) => void;
  onConfirmDelete: (branch: LocalBranch) => void;
  onCancelDelete: (branch: LocalBranch) => void;
  onOpenWorktree: (worktreeId: string) => void;
  deleteButtonRef: (element: HTMLButtonElement | null) => void;
  confirmDeleteRef: (element: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation(["worktree", "common"]);
  const occupied = Boolean(branch.checkedOutPath);
  const effectiveDeleteBlockedReason = branch.current
    ? t("worktree:ui.branchPicker.row.currentDeleteBlocked")
    : occupied
      ? t("worktree:ui.branchPicker.row.occupiedDeleteBlocked", { path: branch.checkedOutPath })
      : deleteBlockedReason;
  if (confirmingDelete) {
    return (
      <div
        className={"branch-picker-row branch-picker-delete-confirm" + (selected ? " selected" : "")}
        role="listitem"
      >
        <div className="branch-picker-delete-warning" role="alert" aria-live="assertive">
          <strong>
            <Trans
              t={t}
              i18nKey="worktree:ui.branchPicker.delete.question"
              values={{ branch: branch.name }}
              components={{ branch: <span className="mono" /> }}
            />
          </strong>
          <span>{t("worktree:ui.branchPicker.delete.mergedOnlyWarning")}</span>
          {effectiveDeleteBlockedReason ? (
            <span>{t("worktree:ui.branchPicker.delete.blocked", { reason: effectiveDeleteBlockedReason })}</span>
          ) : null}
        </div>
        <div
          className="branch-picker-delete-confirm-actions"
          role="group"
          aria-label={t("worktree:ui.branchPicker.delete.confirmGroupAria", { branch: branch.name })}
        >
          <button
            ref={confirmDeleteRef}
            className="btn small danger"
            disabled={disabled || Boolean(effectiveDeleteBlockedReason)}
            onClick={() => onConfirmDelete(branch)}
          >
            {t("worktree:ui.branchPicker.delete.confirm")}
          </button>
          <button className="btn small ghost" onClick={() => onCancelDelete(branch)}>
            {t("common:actions.cancel")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      className={"branch-picker-row" + (selected ? " selected" : "")}
      role="listitem"
    >
      <button
        className="branch-picker-choice"
        disabled={disabled || branch.current || occupied}
        onClick={() => onChoose(branch)}
        title={occupied
          ? t("worktree:ui.branchPicker.row.checkedOutAt", { path: branch.checkedOutPath })
          : undefined}
        aria-current={branch.current ? "page" : undefined}
        aria-label={branch.current && occupied
          ? t("worktree:ui.branchPicker.row.ariaCurrentAndOccupied", {
              branch: branch.name,
              path: branch.checkedOutPath,
            })
          : branch.current
            ? t("worktree:ui.branchPicker.row.ariaCurrent", { branch: branch.name })
            : occupied
              ? t("worktree:ui.branchPicker.row.ariaOccupied", {
                  branch: branch.name,
                  path: branch.checkedOutPath,
                })
              : branch.name}
      >
        <span className="branch-picker-name mono">{branch.name}</span>
        <span className="branch-picker-meta mono">{branch.oid.slice(0, 12)}</span>
        {branch.current ? (
          <span className="branch-picker-state">{t("worktree:ui.branchPicker.row.currentCheckout")}</span>
        ) : null}
        {occupied ? (
          <span className="branch-picker-state">{t("worktree:ui.branchPicker.row.occupiedByWorktree")}</span>
        ) : null}
        {occupied ? <span className="branch-picker-path mono">{branch.checkedOutPath}</span> : null}
      </button>
      {branch.agentPortWorktreeId ? (
        <button
          className="btn small ghost branch-picker-worktree"
          onClick={() => onOpenWorktree(branch.agentPortWorktreeId!)}
          aria-label={t("worktree:ui.branchPicker.row.openWorktreeAria", { branch: branch.name })}
        >
          {t("worktree:ui.branchPicker.row.viewWorktree")}
        </button>
      ) : null}
      {!branch.current && !occupied ? (
        <button
          ref={deleteButtonRef}
          className="btn small ghost branch-picker-delete"
          disabled={disabled || Boolean(deleteBlockedReason)}
          title={deleteBlockedReason || t("worktree:ui.branchPicker.row.deleteLocalBranch", { branch: branch.name })}
          aria-label={t("worktree:ui.branchPicker.row.deleteBranchAria", { branch: branch.name })}
          onClick={() => onRequestDelete(branch)}
        >
          {t("common:actions.delete")}
        </button>
      ) : null}
    </div>
  );
}

export default function BranchPickerDialog({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["worktree", "common"]);
  const store = useStore();
  const project = store.projects.find((item) => item.id === projectId);
  const [data, setData] = useState<LocalBranchesResponse | null>(null);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [newName, setNewName] = useState("");
  const [startBranch, setStartBranch] = useState("");
  const [switchAfterCreate, setSwitchAfterCreate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [eventBusy, setEventBusy] = useState(false);
  const [progress, setProgress] = useState<RepositoryOperationProgress | null>(null);
  const [failure, setFailure] = useState<BranchFailure | null>(null);
  const [sessionHandlingIssue, setSessionHandlingIssue] =
    useState<SessionHandlingIssue | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ message: string; refreshed: boolean } | null>(null);
  const [recovery, setRecovery] = useState<AutoStashRecord[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const confirmDeleteRef = useRef<HTMLButtonElement | null>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const restoreDeleteFocusRef = useRef<string | null>(null);
  const selectedIndexRef = useRef(0);
  const startPointProjectRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const repositoryStatusRevisionRef = useRef(0);
  const localBusyRef = useRef(false);
  const eventBusyRef = useRef(false);
  const activeEventOperationsRef = useRef(new Set<string>());

  useEffect(() => {
    if (confirmingDelete) {
      confirmDeleteRef.current?.focus();
      return;
    }
    const branchName = restoreDeleteFocusRef.current;
    restoreDeleteFocusRef.current = null;
    if (branchName) (deleteButtonRefs.current.get(branchName) ?? searchRef.current)?.focus();
  }, [confirmingDelete]);

  const refresh = useCallback(async (): Promise<boolean> => {
    const sequence = ++refreshSequenceRef.current;
    const statusRevision = repositoryStatusRevisionRef.current;
    setFailure(null);
    setRefreshError(null);
    try {
      const response = await api.listLocalBranches(projectId);
      if (sequence !== refreshSequenceRef.current) return true;
      const eventStatus = statusRevision === repositoryStatusRevisionRef.current
        ? null
        : getState().repositoryStatuses[projectId] ?? null;
      const nextResponse = eventStatus ? { ...response, status: eventStatus } : response;
      setData(nextResponse);
      setRecovery(response.autoStashes ?? []);
      if (!eventStatus) applyRepositoryStatusSnapshot(response.status);
      if (startPointProjectRef.current !== projectId) {
        startPointProjectRef.current = projectId;
        setStartBranch(nextResponse.status.head?.kind === "branch" ? nextResponse.status.head.branch || "" : "");
      }
      return true;
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return true;
      setData(null);
      setRecovery([]);
      if (statusRevision === repositoryStatusRevisionRef.current) {
        markRepositoryStatusUnavailable(projectId);
      }
      setRefreshError(errorText(error));
      return false;
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
    searchRef.current?.focus();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlistens: Array<() => void> = [];
    void Promise.all([
      onRepositoryOperationProgress((event) => {
        if (disposed) return;
        if (event.projectId !== projectId) return;
        setProgress(event);
        if (event.phase === "started") {
          activeEventOperationsRef.current.add(event.operationId);
        } else {
          activeEventOperationsRef.current.delete(event.operationId);
        }
        eventBusyRef.current = activeEventOperationsRef.current.size > 0;
        setEventBusy(eventBusyRef.current);
      }),
      onRepositoryStateChanged((status) => {
        if (disposed) return;
        if (status.projectId !== projectId) return;
        repositoryStatusRevisionRef.current += 1;
        setData((previous) => (previous ? { ...previous, status } : previous));
        applyRepositoryStatusSnapshot(status);
      }),
      onAutoStashChanged((stash) => {
        if (disposed) return;
        if (stash.projectId === projectId) void refresh();
      }),
    ]).then((listeners) => {
      if (disposed) {
        listeners.forEach((unlisten) => unlisten());
      } else {
        unlistens = listeners;
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      refreshSequenceRef.current += 1;
      activeEventOperationsRef.current.clear();
      eventBusyRef.current = false;
      unlistens.forEach((unlisten) => unlisten());
    };
  }, [projectId, refresh]);

  // Git state may change while the modal is open (terminal, IDE, or another
  // AgentPort window). Re-read on window focus/visibility instead of trusting
  // the last successful operation result.
  useEffect(() => {
    const onFocus = () => void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const branches = useMemo(
    () =>
      (data?.branches ?? []).filter((branch) =>
        branch.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [data, query],
  );

  useEffect(() => setSelectedIndex(0), [query, data?.status.snapshotToken]);

  useEffect(() => {
    if (selectedIndexRef.current === selectedIndex) return;
    selectedIndexRef.current = selectedIndex;
    if (confirmingDelete) {
      restoreDeleteFocusRef.current = null;
      setConfirmingDelete(null);
    }
  }, [confirmingDelete, selectedIndex]);

  const sessionForId = (id: string): SessionView | null =>
    findSession(store.projects, id);

  const sessionTitle = (id: string, index: number): string =>
    sessionForId(id)?.title || t("worktree:ui.branchPicker.sessionHandling.unknownSession", {
      index: index + 1,
    });

  const sessionDetail = (id: string, index: number): string => {
    const session = sessionForId(id);
    const liveLifecycle: LifecycleStr = session?.lifecycle === "creating"
      ? "creating"
      : "running";
    return t("worktree:ui.branchPicker.sessionHandling.sessionDetail", {
      title: sessionTitle(id, index),
      status: lifecycleLabel(liveLifecycle, t),
    });
  };

  const setOperationFailure = (error: unknown, forceDeleteBranch: string | null = null) => {
    const nextFailure = operationFailure(error);
    if (nextFailure.liveSessionIds.length > 0) {
      setFailure(null);
      setSessionHandlingIssue({
        affectedSessionIds: nextFailure.liveSessionIds,
      });
    } else {
      setFailure({
        ...nextFailure,
        forceDeleteBranch: forceDeleteOffered(error) ? forceDeleteBranch : null,
      });
    }
  };

  const executeOperation = async (
    message: string,
    operation: () => Promise<void>,
    pending: { command?: string; branch?: string | null; message?: string } = {},
  ): Promise<boolean> => {
    setProgress({
      operationId: "ui-pending",
      command: pending.command ?? "branch_picker",
      projectId,
      branch: pending.branch ?? null,
      phase: "started",
      message: pending.message ?? t("worktree:ui.branchPicker.operation.checkingRepository"),
      coreOperationId: null,
      recoverable: false,
      occurredAt: new Date().toISOString(),
    });
    setFailure(null);
    setSessionHandlingIssue(null);
    setRefreshError(null);
    setSuccess(null);
    try {
      await operation();
      const refreshed = await refresh();
      setSuccess({ message, refreshed });
      toast(
        refreshed
          ? message
          : t("worktree:ui.branchPicker.operation.completedButRefreshFailed", { message }),
        refreshed ? "success" : "error",
      );
      return true;
    } catch (error) {
      await refresh();
      setOperationFailure(
        error,
        pending.command === "delete_local_branch" ? (pending.branch ?? null) : null,
      );
      return false;
    }
  };

  const complete = async (
    message: string,
    operation: () => Promise<void>,
    pending: { command?: string; branch?: string | null; message?: string } = {},
  ): Promise<boolean> => {
    if (localBusyRef.current || eventBusyRef.current) return false;
    localBusyRef.current = true;
    setBusy(true);
    try {
      return await executeOperation(message, operation, pending);
    } finally {
      localBusyRef.current = false;
      setBusy(false);
    }
  };

  const executeCheckoutChangingOperation = async (intent: CheckoutChangingOperation) => {
    const completionMessage = intent.kind === "switch"
      ? t("worktree:ui.branchPicker.operation.switched", { branch: intent.branch })
      : t("worktree:ui.branchPicker.operation.createdAndSwitched", { branch: intent.branch });
    const command = intent.kind === "switch"
      ? "switch_local_branch"
      : "create_and_switch_local_branch";
    const pendingMessage = intent.kind === "switch"
      ? t("worktree:ui.branchPicker.operation.switchingLocalBranch", { branch: intent.branch })
      : t("worktree:ui.branchPicker.operation.creatingAndSwitching", { branch: intent.branch });
    return executeOperation(
      completionMessage,
      async () => {
        const result = intent.kind === "switch"
          ? await api.switchLocalBranch(projectId, intent.branch)
          : await api.createAndSwitchLocalBranch(projectId, intent.branch, intent.startPoint);
        setData((previous) => (previous ? { ...previous, status: result.status } : previous));
        if (result.autoStash) setRecovery((items) => [result.autoStash!, ...items]);
        if (intent.kind === "createAndSwitch") setNewName("");
      },
      { command, branch: intent.branch, message: pendingMessage },
    );
  };

  const runCheckoutChangingOperation = (intent: CheckoutChangingOperation) => {
    void (async () => {
      if (localBusyRef.current || eventBusyRef.current) return;
      localBusyRef.current = true;
      setBusy(true);
      try {
        setFailure(null);
        setSessionHandlingIssue(null);
        setRefreshError(null);
        setSuccess(null);

        await executeCheckoutChangingOperation(intent);
      } catch (error) {
        setOperationFailure(error);
      } finally {
        localBusyRef.current = false;
        setBusy(false);
      }
    })();
  };

  const switchTo = (branch: LocalBranch) => {
    if (localBusyRef.current || eventBusyRef.current || branch.current || branch.checkedOutPath) return;
    runCheckoutChangingOperation({ kind: "switch", branch: branch.name });
  };

  const chooseBranch = (branch: LocalBranch) => {
    restoreDeleteFocusRef.current = null;
    setConfirmingDelete(null);
    switchTo(branch);
  };

  const requestDelete = (branch: LocalBranch) => {
    if (localBusyRef.current || eventBusyRef.current || branch.current || branch.checkedOutPath) return;
    restoreDeleteFocusRef.current = null;
    setConfirmingDelete(branch.name);
    setFailure(null);
    setSuccess(null);
  };

  const cancelDelete = (branchName: string, restoreFocus = true) => {
    restoreDeleteFocusRef.current = restoreFocus ? branchName : null;
    setConfirmingDelete(null);
  };

  const deleteBranch = (branchName: string, force = false) => {
    void (async () => {
      const deleted = await complete(
        t("worktree:ui.branchPicker.operation.deletedLocalBranch", { branch: branchName }),
        async () => {
          const result = await api.deleteLocalBranch(projectId, branchName, force);
          setData((previous) => (previous ? { ...previous, status: result.status } : previous));
        },
        {
          command: "delete_local_branch",
          branch: branchName,
          message: t("worktree:ui.branchPicker.operation.deletingLocalBranch", { branch: branchName }),
        },
      );
      if (deleted) {
        restoreDeleteFocusRef.current = null;
        setConfirmingDelete(null);
        searchRef.current?.focus();
      } else {
        confirmDeleteRef.current?.focus();
      }
    })();
  };

  // Explicit `branch -D` retry after the backend reported the merged-only
  // block: still journaled and guarded, but discards unmerged commits.
  const forceDelete = (branchName: string) => {
    if (localBusyRef.current || eventBusyRef.current) return;
    deleteBranch(branchName, true);
  };

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    const startPoint = startBranch.trim() || null;
    if (switchAfterCreate) {
      runCheckoutChangingOperation({
        kind: "createAndSwitch",
        branch: name,
        startPoint,
      });
      return;
    }
    void complete(t("worktree:ui.branchPicker.operation.created", { branch: name }), async () => {
      const result = await api.createLocalBranch(projectId, name, startPoint);
      setData((previous) => (previous ? { ...previous, status: result.status } : previous));
      setNewName("");
    });
  };

  const restore = (stash: AutoStashRecord, strategy: "target" | "source") => {
    void (async () => {
      const restored = await complete(
        strategy === "target"
          ? t("worktree:ui.branchPicker.operation.restoreAttemptedOnCurrentCheckout")
          : t("worktree:ui.branchPicker.operation.returnedToSourceCheckout"),
        async () => {
          await api.restoreAutoStash(stash.operationId, strategy);
        },
      );
      if (!restored) return;

      const cleaned = await complete(
        t("worktree:ui.branchPicker.operation.restoredAndCleaned"),
        async () => {
          await api.cleanupAutoStash(stash.operationId);
        },
      );
      if (!cleaned) {
        toast(t("worktree:ui.branchPicker.recovery.cleanupDeferred"), "info");
      }
    })();
  };

  const cleanup = (stash: AutoStashRecord) => {
    void complete(t("worktree:ui.branchPicker.operation.recoveryRecordCleaned"), async () => {
      await api.cleanupAutoStash(stash.operationId);
    });
  };

  const openLiveSession = (id: string) => {
    if (store.projects.some((projectItem) => projectItem.sessions.some((session) => session.id === id))) {
      closeDialog();
      selectSession(id);
    }
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(0, branches.length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const selected = branches[selectedIndex];
      if (selected) chooseBranch(selected);
    } else if (event.key.toLowerCase() === "r" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (confirmingDelete) cancelDelete(confirmingDelete, false);
      void refresh();
    }
  };

  const status = data?.status ?? store.repositoryStatuses[projectId] ?? null;
  const changeLines = changesLabel(status, t);
  const controlsBusy = busy || eventBusy;
  const canCreate = Boolean(newName.trim()) && !controlsBusy && status?.isGitRepository === true;
  let deleteBlockedReason: string | null = null;
  if (controlsBusy) {
    deleteBlockedReason = t("worktree:ui.branchPicker.deleteBlocked.repositoryOperation");
  } else if (!status || !status.isGitRepository) {
    deleteBlockedReason = t("worktree:ui.branchPicker.deleteBlocked.repositoryUnavailable");
  } else if (status.ongoingOperation) {
    deleteBlockedReason = t("worktree:ui.branchPicker.deleteBlocked.gitOperation", {
      operation: status.ongoingOperation,
    });
  } else if (status.changes.unmerged) {
    deleteBlockedReason = t("worktree:ui.branchPicker.deleteBlocked.unresolvedConflicts");
  }

  useEffect(() => {
    if (!confirmingDelete) return;
    const branch = data?.branches.find((item) => item.name === confirmingDelete);
    const becameCurrent = status?.head?.kind === "branch" && status.head.branch === confirmingDelete;
    if (branch && !branch.current && !branch.checkedOutPath && !becameCurrent) return;
    restoreDeleteFocusRef.current = null;
    searchRef.current?.focus();
    setConfirmingDelete(null);
  }, [confirmingDelete, data?.branches, status?.head?.branch, status?.head?.kind]);

  return (
    <Modal
      title={t("worktree:ui.branchPicker.title", {
        project: project?.name ?? t("worktree:ui.branchPicker.projectFallback"),
      })}
      onClose={closeDialog}
      wide
    >
      <div
        className="branch-picker-content"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !confirmingDelete) return;
          event.preventDefault();
          event.stopPropagation();
          cancelDelete(confirmingDelete);
        }}
      >
      <div className="branch-picker-status" aria-live="polite">
        <div>
          <span className="branch-picker-eyebrow">{t("worktree:ui.branchPicker.currentCheckout")}</span>
          <strong className="mono">{headLabel(status, t)}</strong>
        </div>
        <div className="branch-picker-summary">
          {changeLines.length ? (
            <span>{t("worktree:ui.branchPicker.workspace.changes", { changes: changeLines.join(" · ") })}</span>
          ) : (
            <span>{t("worktree:ui.branchPicker.workspace.clean")}</span>
          )}
          {status?.ongoingOperation ? (
            <span>{t("worktree:ui.branchPicker.workspace.gitOperation", { operation: status.ongoingOperation })}</span>
          ) : null}
          {status?.liveSessionIds.length ? (
            <span>
              {t("worktree:ui.branchPicker.workspace.liveSessions", {
                count: status.liveSessionIds.length,
              })}
            </span>
          ) : null}
          {status?.pendingAutoStashes ? (
            <span>
              {t("worktree:ui.branchPicker.workspace.pendingRecoveryRecords", {
                count: status.pendingAutoStashes,
              })}
            </span>
          ) : null}
        </div>
      </div>

      {status && !status.isGitRepository ? (
        <div className="error-bar" role="alert">{t("worktree:ui.branchPicker.notGitRepository")}</div>
      ) : null}
      {progress && !failure && !sessionHandlingIssue ? (
        <div className="info-box branch-picker-progress" role="status">
          {t("worktree:ui.branchPicker.progress.detail", {
            label: controlsBusy
              ? t("worktree:ui.branchPicker.progress.inProgress")
              : t("worktree:ui.branchPicker.progress.recentOperation"),
            message: repositoryProgressMessage(progress),
            phase: branchOperationPhaseLabel(progress.phase),
          })}
        </div>
      ) : null}
      {success ? (
        <div className="info-box branch-picker-success" role="status">
          {t("worktree:ui.branchPicker.success.completed", { message: success.message })}{" "}
          {success.refreshed
            ? t("worktree:ui.branchPicker.success.repositoryRefreshed")
            : t("worktree:ui.branchPicker.success.repositoryRefreshFailed")}
        </div>
      ) : null}
      {refreshError ? (
        <div className="error-bar" role="alert">
          <strong>{t("worktree:ui.branchPicker.error.repositoryReadFailed")}</strong> {refreshError}
        </div>
      ) : null}
      {sessionHandlingIssue ? (
        <div className="error-bar" role="alert">
          <strong>
            {t("worktree:ui.branchPicker.sessionHandling.checkoutChanged")}
          </strong>
          <div>{t("worktree:ui.branchPicker.sessionHandling.branchUnchanged")}</div>
          {sessionHandlingIssue.affectedSessionIds.length ? (
            <div className="branch-picker-live-sessions">
              {sessionHandlingIssue.affectedSessionIds.map((id, index) => (
                <span key={id}>
                  {sessionDetail(id, index)}{" "}
                  {sessionForId(id) ? (
                    <button className="btn small ghost" onClick={() => openLiveSession(id)}>
                      {t("worktree:ui.branchPicker.sessionHandling.openNamedSession", {
                        title: sessionTitle(id, index),
                      })}
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          <div className="branch-picker-recovery-actions">
            {t("worktree:ui.branchPicker.sessionHandling.nextStep")}
          </div>
        </div>
      ) : null}
      {failure ? (
        <div className="error-bar" role="alert">
          <strong>{t("worktree:ui.branchPicker.error.branchOperationFailed")}</strong> {failure.message}
          {failure.recoveryActions.length ? (
            <div className="branch-picker-recovery-actions">
              <span>{t("worktree:ui.branchPicker.error.recoveryActions")}</span>
              {failure.recoveryActions.map((action) => (
                <span key={action}>{recoveryActionLabel(action)}</span>
              ))}
            </div>
          ) : null}
          {failure.forceDeleteBranch ? (
            <div className="branch-picker-force-delete">
              <span>
                {t("worktree:ui.branchPicker.error.forceDeleteHint", { branch: failure.forceDeleteBranch })}
              </span>
              <button
                className="btn small danger"
                disabled={controlsBusy}
                onClick={() => {
                  const branch = failure.forceDeleteBranch;
                  if (branch) forceDelete(branch);
                }}
              >
                {t("worktree:ui.branchPicker.error.forceDeleteBranch")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="branch-picker-toolbar">
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => {
            if (confirmingDelete) cancelDelete(confirmingDelete, false);
            setQuery(event.target.value);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder={t("worktree:ui.branchPicker.search.placeholder")}
          aria-label={t("worktree:ui.branchPicker.search.aria")}
          aria-controls="local-branch-list"
        />
        <button
          className="btn ghost"
          onClick={() => {
            if (confirmingDelete) cancelDelete(confirmingDelete, false);
            void refresh();
          }}
          disabled={controlsBusy}
        >
          {t("common:actions.refresh")}
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {branches[selectedIndex]
          ? t("worktree:ui.branchPicker.search.selected", { branch: branches[selectedIndex].name })
          : t("worktree:ui.branchPicker.search.noMatch")}
      </span>
      <div
        id="local-branch-list"
        className="branch-picker-list"
        role="list"
        aria-label={t("worktree:ui.branchPicker.localBranchesAria")}
      >
        {branches.length ? branches.map((branch, index) => {
          const effectiveBranch = status?.head?.kind === "branch" && status.head.branch === branch.name
            ? { ...branch, current: true }
            : branch;
          return (
            <BranchRow
              key={branch.name}
              branch={effectiveBranch}
              selected={index === selectedIndex}
              disabled={controlsBusy}
              deleteBlockedReason={deleteBlockedReason}
              confirmingDelete={confirmingDelete === branch.name}
              onChoose={chooseBranch}
              onRequestDelete={requestDelete}
              onConfirmDelete={(item) => deleteBranch(item.name)}
              onCancelDelete={(item) => cancelDelete(item.name)}
              onOpenWorktree={(worktreeId) => { closeDialog(); openWorktreeView(projectId, worktreeId); }}
              deleteButtonRef={(element) => {
                if (element) deleteButtonRefs.current.set(branch.name, element);
                else deleteButtonRefs.current.delete(branch.name);
              }}
              confirmDeleteRef={(element) => { confirmDeleteRef.current = element; }}
            />
          );
        }) : (
          <div className="branch-picker-empty">{t("worktree:ui.branchPicker.search.noMatchSentence")}</div>
        )}
      </div>

      <section className="branch-picker-create" aria-labelledby="branch-create-title">
        <div className="section-title" id="branch-create-title">
          {t("worktree:ui.branchPicker.create.title")}
        </div>
        <div className="branch-picker-create-grid">
          <input disabled={controlsBusy} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="feature/my-change" aria-label={t("worktree:ui.branchPicker.create.branchNameAria")} />
          <select disabled={controlsBusy} value={startBranch} onChange={(event) => setStartBranch(event.target.value)} aria-label={t("worktree:ui.branchPicker.create.startPointAria")}>
            <option value="">{t("worktree:ui.branchPicker.create.currentHead")}</option>
            {(data?.branches ?? []).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
          </select>
          <label className="check-row"><input disabled={controlsBusy} type="checkbox" checked={switchAfterCreate} onChange={(event) => setSwitchAfterCreate(event.target.checked)} />{t("worktree:ui.branchPicker.create.switchAfterCreate")}</label>
          <button className="btn primary" disabled={!canCreate} onClick={create}>
            {controlsBusy
              ? t("worktree:ui.branchPicker.create.processing")
              : t("worktree:ui.branchPicker.create.createBranch")}
          </button>
        </div>
      </section>

      {recovery.length ? (
        <section className="branch-picker-recovery" aria-labelledby="branch-recovery-title">
          <div className="section-title" id="branch-recovery-title">
            {t("worktree:ui.branchPicker.recovery.title")}
          </div>
          <p className="form-hint">{t("worktree:ui.branchPicker.recovery.description")}</p>
          {recovery.map((stash) => (
            <div className="branch-picker-stash" key={stash.id}>
              <div><strong>{stash.targetBranch}</strong>{stash.restorable === false && stash.stashOid ? <span className="mono">{stash.stashOid.slice(0, 12)}</span> : null}<span>{branchOperationPhaseLabel(stash.state)}</span>{stash.lastError ? <span>{t("worktree:ui.branchPicker.recovery.error", { detail: stash.lastError })}</span> : null}</div>
              {stash.restorable === false ? (
                <p className="form-hint" role="status">
                  {t("worktree:ui.branchPicker.recovery.missingSnapshot")}
                </p>
              ) : null}
              <div className="branch-picker-stash-actions">
                <button className="btn small ghost" disabled={controlsBusy || stash.restorable === false || stash.state === "restored_verified"} onClick={() => restore(stash, "target")}>{t("worktree:ui.branchPicker.recovery.restoreToTarget")}</button>
                <button className="btn small ghost" disabled={controlsBusy || stash.restorable === false || stash.state === "restored_verified"} onClick={() => restore(stash, "source")}>{t("worktree:ui.branchPicker.recovery.returnToSourceAndRestore")}</button>
                {stash.restorable === false && stash.stashOid ? (
                  <button
                    className="btn small ghost"
                    disabled={controlsBusy}
                    onClick={() => void copyTextWithToast(
                      `git stash apply --index ${stash.stashOid}`,
                      t("worktree:ui.branchPicker.recovery.manualCommandCopied"),
                    )}
                  >
                    {t("worktree:ui.branchPicker.recovery.copyManualCommand")}
                  </button>
                ) : null}
                <button
                  className="btn small danger"
                  disabled={controlsBusy || stash.restorable === false || stash.state !== "restored_verified"}
                  title={stash.state === "restored_verified"
                    ? t("worktree:ui.branchPicker.recovery.deleteVerifiedRecord")
                    : t("worktree:ui.branchPicker.recovery.cleanupRequiresVerification")}
                  onClick={() => cleanup(stash)}
                >
                  {t("worktree:ui.branchPicker.recovery.cleanupRecord")}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      </div>
    </Modal>
  );
}
