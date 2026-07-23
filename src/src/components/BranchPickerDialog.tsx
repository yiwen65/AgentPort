// Local branch management deliberately renders from backend snapshots. Git can
// change outside AgentPort, so a successful click is never treated as a local
// checkout switch until the command result / repository event confirms it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  copyText,
  errorText,
  isStructuredGitError,
  onAutoStashChanged,
  onRepositoryOperationProgress,
  onRepositoryStateChanged,
} from "../api";
import {
  applyRepositoryStatusSnapshot,
  closeDialog,
  getState,
  markRepositoryStatusUnavailable,
  openWorktreeView,
  toast,
  useStore,
} from "../store";
import { selectSession } from "../actions";
import type {
  AutoStashRecord,
  LocalBranch,
  LocalBranchesResponse,
  RepositoryOperationProgress,
  RepositoryStatus,
} from "../types";
import Modal from "./Modal";

interface BranchFailure {
  message: string;
  liveSessionIds: string[];
  recoveryActions: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function operationFailure(error: unknown): BranchFailure {
  if (isStructuredGitError(error)) {
    return {
      message: error.message || (typeof error.diagnostics.message === "string" ? error.diagnostics.message : error.code),
      liveSessionIds: stringIds(error.liveSessionIds),
      recoveryActions: stringIds(error.recoveryActions),
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
      recoveryActions: stringIds(wrapped.recoveryActions),
    };
  }
  return { message: errorText(error), liveSessionIds: [], recoveryActions: [] };
}

function headLabel(status: RepositoryStatus | null): string {
  if (!status) return "正在读取 checkout…";
  if (status.head?.kind === "branch") return status.head.branch || "未命名分支";
  if (status.head?.kind === "detached") return `Detached @ ${status.head.shortOid || status.head.oid?.slice(0, 12) || "unknown"}`;
  return "未初始化仓库";
}

function changesLabel(status: RepositoryStatus | null): string[] {
  if (!status) return [];
  const changes = status.changes ?? { staged: 0, unstaged: 0, untracked: 0, unmerged: 0, dirtySubmodules: 0 };
  return [
    changes.staged ? `暂存 ${changes.staged}` : "",
    changes.unstaged ? `修改 ${changes.unstaged}` : "",
    changes.untracked ? `未跟踪 ${changes.untracked}` : "",
    changes.unmerged ? `冲突 ${changes.unmerged}` : "",
    changes.dirtySubmodules ? `子模块 ${changes.dirtySubmodules}` : "",
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
  const occupied = Boolean(branch.checkedOutPath);
  const effectiveDeleteBlockedReason = branch.current
    ? "该分支已成为当前 checkout"
    : occupied
      ? `该分支已被 Worktree 占用：${branch.checkedOutPath}`
      : deleteBlockedReason;
  if (confirmingDelete) {
    return (
      <div
        className={"branch-picker-row branch-picker-delete-confirm" + (selected ? " selected" : "")}
        role="listitem"
      >
        <div className="branch-picker-delete-warning" role="alert" aria-live="assertive">
          <strong>删除 <span className="mono">{branch.name}</span>？</strong>
          <span>仅删除已合并的本地分支，不影响远端。此操作不可撤销。</span>
          {effectiveDeleteBlockedReason ? <span>暂不能删除：{effectiveDeleteBlockedReason}</span> : null}
        </div>
        <div className="branch-picker-delete-confirm-actions" role="group" aria-label={`确认删除分支 ${branch.name}`}>
          <button
            ref={confirmDeleteRef}
            className="btn small danger"
            disabled={disabled || Boolean(effectiveDeleteBlockedReason)}
            onClick={() => onConfirmDelete(branch)}
          >
            确认删除
          </button>
          <button className="btn small ghost" onClick={() => onCancelDelete(branch)}>
            取消
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
        title={occupied ? `已在 ${branch.checkedOutPath} checkout` : undefined}
        aria-current={branch.current ? "page" : undefined}
        aria-label={`${branch.name}${branch.current ? "，当前 checkout" : ""}${occupied ? `，已被 Worktree 占用：${branch.checkedOutPath}` : ""}`}
      >
        <span className="branch-picker-name mono">{branch.name}</span>
        <span className="branch-picker-meta mono">{branch.oid.slice(0, 12)}</span>
        {branch.current ? <span className="branch-picker-state">当前 checkout</span> : null}
        {occupied ? <span className="branch-picker-state">已被 Worktree 占用</span> : null}
        {occupied ? <span className="branch-picker-path mono">{branch.checkedOutPath}</span> : null}
      </button>
      {branch.agentPortWorktreeId ? (
        <button
          className="btn small ghost branch-picker-worktree"
          onClick={() => onOpenWorktree(branch.agentPortWorktreeId!)}
          aria-label={`打开 ${branch.name} 的 AgentPort Worktree`}
        >
          查看 Worktree
        </button>
      ) : null}
      {!branch.current && !occupied ? (
        <button
          ref={deleteButtonRef}
          className="btn small ghost branch-picker-delete"
          disabled={disabled || Boolean(deleteBlockedReason)}
          title={deleteBlockedReason || `删除本地分支 ${branch.name}`}
          aria-label={`删除分支 ${branch.name}`}
          onClick={() => onRequestDelete(branch)}
        >
          删除
        </button>
      ) : null}
    </div>
  );
}

export default function BranchPickerDialog({ projectId }: { projectId: string }) {
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

  const complete = async (
    message: string,
    operation: () => Promise<void>,
    pending: { command?: string; branch?: string | null; message?: string } = {},
  ): Promise<boolean> => {
    if (localBusyRef.current || eventBusyRef.current) return false;
    localBusyRef.current = true;
    setBusy(true);
    setProgress({
      operationId: "ui-pending",
      command: pending.command ?? "branch_picker",
      projectId,
      branch: pending.branch ?? null,
      phase: "started",
      message: pending.message ?? "正在重新检查仓库并执行安全操作",
      coreOperationId: null,
      recoverable: false,
      occurredAt: new Date().toISOString(),
    });
    setFailure(null);
    setRefreshError(null);
    setSuccess(null);
    try {
      await operation();
      const refreshed = await refresh();
      setSuccess({ message, refreshed });
      toast(
        refreshed ? message : `${message}，但仓库状态刷新失败`,
        refreshed ? "success" : "error",
      );
      return true;
    } catch (error) {
      await refresh();
      setFailure(operationFailure(error));
      return false;
    } finally {
      localBusyRef.current = false;
      setBusy(false);
    }
  };

  const switchTo = (branch: LocalBranch) => {
    if (localBusyRef.current || eventBusyRef.current || branch.current || branch.checkedOutPath) return;
    void complete(`已切换到 ${branch.name}`, async () => {
      const result = await api.switchLocalBranch(projectId, branch.name);
      setData((previous) => (previous ? { ...previous, status: result.status } : previous));
    });
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

  const deleteBranch = (branch: LocalBranch) => {
    void (async () => {
      const deleted = await complete(
        `已删除本地分支 ${branch.name}`,
        async () => {
          const result = await api.deleteLocalBranch(projectId, branch.name);
          setData((previous) => (previous ? { ...previous, status: result.status } : previous));
        },
        {
          command: "delete_local_branch",
          branch: branch.name,
          message: `正在重新检查并删除本地分支 ${branch.name}`,
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

  const create = () => {
    const name = newName.trim();
    if (!name) return;
    void complete(switchAfterCreate ? `已创建并切换到 ${name}` : `已创建 ${name}`, async () => {
      let result = await api.createLocalBranch(projectId, name, startBranch.trim() || null);
      if (switchAfterCreate) {
        try {
          result = await api.switchLocalBranch(projectId, name);
        } catch (error) {
          const failure = operationFailure(error);
          throw {
            ...(isStructuredGitError(error) ? error : {}),
            code: isStructuredGitError(error) ? error.code : "switch_after_create_failed",
            message: `分支 ${name} 已创建，但未能切换。${failure.message}`,
            phase: isStructuredGitError(error) ? error.phase : "switch",
            operationId: isStructuredGitError(error) ? error.operationId : "ui-create-switch",
            recoverable: true,
            currentStatus: isStructuredGitError(error) ? error.currentStatus : null,
            recoveryActions: failure.recoveryActions,
            diagnostics: isStructuredGitError(error) ? error.diagnostics : {},
            liveSessionIds: failure.liveSessionIds,
          };
        }
      }
      setData((previous) => (previous ? { ...previous, status: result.status } : previous));
      if (result.autoStash) setRecovery((items) => [result.autoStash!, ...items]);
      setNewName("");
    });
  };

  const restore = (stash: AutoStashRecord, strategy: "target" | "source") => {
    void complete(strategy === "target" ? "已尝试恢复到当前 checkout" : "已返回原 checkout", async () => {
      await api.restoreAutoStash(stash.operationId, strategy);
    });
  };

  const cleanup = (stash: AutoStashRecord) => {
    void complete("恢复记录已清理", async () => {
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
  const changeLines = changesLabel(status);
  const controlsBusy = busy || eventBusy;
  const canCreate = Boolean(newName.trim()) && !controlsBusy && status?.isGitRepository === true;
  let deleteBlockedReason: string | null = null;
  if (controlsBusy) deleteBlockedReason = "仓库操作进行中，暂时不能删除分支";
  else if (!status || !status.isGitRepository) deleteBlockedReason = "仓库状态不可用";
  else if (status.ongoingOperation) deleteBlockedReason = `Git ${status.ongoingOperation} 操作进行中`;
  else if (status.changes.unmerged) deleteBlockedReason = "存在未解决冲突，不能删除分支";

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
    <Modal title={`管理本地分支 · ${project?.name ?? "项目"}`} onClose={closeDialog} wide>
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
          <span className="branch-picker-eyebrow">当前 checkout</span>
          <strong className="mono">{headLabel(status)}</strong>
        </div>
        <div className="branch-picker-summary">
          {changeLines.length ? <span>工作区：{changeLines.join(" · ")}</span> : <span>工作区干净</span>}
          {status?.ongoingOperation ? <span>Git 操作中：{status.ongoingOperation}</span> : null}
          {status?.liveSessionIds.length ? <span>同 checkout 运行中 Session：{status.liveSessionIds.length}</span> : null}
          {status?.pendingAutoStashes ? <span>待恢复记录：{status.pendingAutoStashes}</span> : null}
        </div>
      </div>

      {status && !status.isGitRepository ? (
        <div className="error-bar" role="alert">该项目不是 Git 仓库，无法管理本地分支。</div>
      ) : null}
      {progress ? <div className="info-box branch-picker-progress" role="status">{controlsBusy ? "进行中" : "最近操作"}：{progress.message}（{progress.phase}）</div> : null}
      {success ? (
        <div className="info-box branch-picker-success" role="status">
          完成：{success.message}。
          {success.refreshed ? "已重新读取仓库状态。" : "仓库状态刷新失败；操作入口已禁用，请重试刷新。"}
        </div>
      ) : null}
      {refreshError ? (
        <div className="error-bar" role="alert">
          <strong>仓库状态读取失败。</strong> {refreshError}
        </div>
      ) : null}
      {failure ? (
        <div className="error-bar" role="alert">
          <strong>分支操作未完成。</strong> {failure.message}
          {failure.liveSessionIds.length ? (
            <div className="branch-picker-live-sessions">
              <span>这些 Session 正在使用该 checkout：</span>
              {failure.liveSessionIds.map((id) => (
                <button key={id} className="btn small ghost" onClick={() => openLiveSession(id)}>
                  打开 Session {id.slice(0, 8)}
                </button>
              ))}
            </div>
          ) : null}
          {failure.recoveryActions.length ? (
            <div className="branch-picker-recovery-actions">
              <span>可用恢复动作：</span>
              {failure.recoveryActions.map((action) => <code key={action}>{action}</code>)}
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
          placeholder="搜索本地分支（↑ ↓ 选择，Enter 切换）"
          aria-label="搜索本地分支"
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
          刷新
        </button>
      </div>
      <span className="sr-only" aria-live="polite">
        {branches[selectedIndex] ? `已选择 ${branches[selectedIndex].name}` : "没有匹配的本地分支"}
      </span>
      <div id="local-branch-list" className="branch-picker-list" role="list" aria-label="本地分支">
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
              onConfirmDelete={deleteBranch}
              onCancelDelete={(item) => cancelDelete(item.name)}
              onOpenWorktree={(worktreeId) => { closeDialog(); openWorktreeView(projectId, worktreeId); }}
              deleteButtonRef={(element) => {
                if (element) deleteButtonRefs.current.set(branch.name, element);
                else deleteButtonRefs.current.delete(branch.name);
              }}
              confirmDeleteRef={(element) => { confirmDeleteRef.current = element; }}
            />
          );
        }) : <div className="branch-picker-empty">没有匹配的本地分支。</div>}
      </div>

      <section className="branch-picker-create" aria-labelledby="branch-create-title">
        <div className="section-title" id="branch-create-title">创建本地分支</div>
        <div className="branch-picker-create-grid">
          <input disabled={controlsBusy} value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="feature/my-change" aria-label="新分支名称" />
          <select disabled={controlsBusy} value={startBranch} onChange={(event) => setStartBranch(event.target.value)} aria-label="新分支起点">
            <option value="">当前 HEAD</option>
            {(data?.branches ?? []).map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
          </select>
          <label className="check-row"><input disabled={controlsBusy} type="checkbox" checked={switchAfterCreate} onChange={(event) => setSwitchAfterCreate(event.target.checked)} />创建后切换到新分支</label>
          <button className="btn primary" disabled={!canCreate} onClick={create}>{controlsBusy ? "处理中…" : "创建分支"}</button>
        </div>
      </section>

      {recovery.length ? (
        <section className="branch-picker-recovery" aria-labelledby="branch-recovery-title">
          <div className="section-title" id="branch-recovery-title">可恢复的自动暂存</div>
          <p className="form-hint">操作中断或冲突后，记录会保留在此处，直到恢复或明确清理。</p>
          {recovery.map((stash) => (
            <div className="branch-picker-stash" key={stash.id}>
              <div><strong>{stash.targetBranch}</strong><span className="mono">{stash.stashOid || stash.id}</span><span>{stash.state}</span>{stash.lastError ? <span>错误：{stash.lastError}</span> : null}</div>
              {stash.restorable === false ? (
                <p className="form-hint" role="status">
                  此备份缺少操作快照，AgentPort 不会自动 apply 或清理；请确认 checkout 后手动使用持久化 OID 恢复。
                </p>
              ) : null}
              <div className="branch-picker-stash-actions">
                <button className="btn small ghost" disabled={controlsBusy || stash.restorable === false || stash.state === "restored_verified"} onClick={() => restore(stash, "target")}>恢复到目标分支</button>
                <button className="btn small ghost" disabled={controlsBusy || stash.restorable === false || stash.state === "restored_verified"} onClick={() => restore(stash, "source")}>返回源分支并恢复</button>
                {stash.restorable === false && stash.stashOid ? (
                  <button
                    className="btn small ghost"
                    disabled={controlsBusy}
                    onClick={() => void copyText(`git stash apply --index ${stash.stashOid}`).then((ok) => toast(ok ? "已复制手动恢复命令" : "复制失败", ok ? "success" : "error"))}
                  >
                    复制手动恢复命令
                  </button>
                ) : null}
                <button
                  className="btn small danger"
                  disabled={controlsBusy || stash.restorable === false || stash.state !== "restored_verified"}
                  title={stash.state === "restored_verified" ? "删除已验证恢复记录" : "仅恢复已验证后可清理"}
                  onClick={() => cleanup(stash)}
                >
                  清理记录
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
