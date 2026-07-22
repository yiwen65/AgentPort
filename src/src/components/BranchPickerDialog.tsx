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
import { openWorktreeView, update, closeDialog, toast, useStore } from "../store";
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
  onChoose,
  onOpenWorktree,
}: {
  branch: LocalBranch;
  selected: boolean;
  disabled: boolean;
  onChoose: (branch: LocalBranch) => void;
  onOpenWorktree: (worktreeId: string) => void;
}) {
  const occupied = Boolean(branch.checkedOutPath);
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
  const [success, setSuccess] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<AutoStashRecord[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const startPointProjectRef = useRef<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const localBusyRef = useRef(false);
  const eventBusyRef = useRef(false);
  const activeEventOperationsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    setFailure(null);
    try {
      const response = await api.listLocalBranches(projectId);
      if (sequence !== refreshSequenceRef.current) return;
      setData(response);
      setRecovery(response.autoStashes ?? []);
      update((state) => ({
        repositoryStatuses: { ...state.repositoryStatuses, [projectId]: response.status },
      }));
      if (startPointProjectRef.current !== projectId) {
        startPointProjectRef.current = projectId;
        setStartBranch(response.status.head?.kind === "branch" ? response.status.head.branch || "" : "");
      }
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return;
      setFailure(operationFailure(error));
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
        setData((previous) => (previous ? { ...previous, status } : previous));
        update((state) => ({ repositoryStatuses: { ...state.repositoryStatuses, [projectId]: status } }));
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

  const complete = async (message: string, operation: () => Promise<void>) => {
    if (localBusyRef.current || eventBusyRef.current) return;
    localBusyRef.current = true;
    setBusy(true);
    setProgress({
      operationId: "ui-pending",
      command: "branch_picker",
      projectId,
      branch: null,
      phase: "started",
      message: "正在重新检查仓库并执行安全操作",
      coreOperationId: null,
      recoverable: false,
      occurredAt: new Date().toISOString(),
    });
    setFailure(null);
    setSuccess(null);
    try {
      await operation();
      await refresh();
      setSuccess(message);
      toast(message, "success");
    } catch (error) {
      await refresh();
      setFailure(operationFailure(error));
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
      if (selected) switchTo(selected);
    } else if (event.key.toLowerCase() === "r" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void refresh();
    }
  };

  const status = data?.status ?? store.repositoryStatuses[projectId] ?? null;
  const changeLines = changesLabel(status);
  const controlsBusy = busy || eventBusy;
  const canCreate = Boolean(newName.trim()) && !controlsBusy && status?.isGitRepository !== false;

  return (
    <Modal title={`管理本地分支 · ${project?.name ?? "项目"}`} onClose={closeDialog} wide>
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
      {success ? <div className="info-box branch-picker-success" role="status">完成：{success}。已重新读取仓库状态。</div> : null}
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
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="搜索本地分支（↑ ↓ 选择，Enter 切换）"
          aria-label="搜索本地分支"
          aria-controls="local-branch-list"
        />
        <button className="btn ghost" onClick={() => void refresh()} disabled={controlsBusy}>刷新</button>
      </div>
      <span className="sr-only" aria-live="polite">
        {branches[selectedIndex] ? `已选择 ${branches[selectedIndex].name}` : "没有匹配的本地分支"}
      </span>
      <div id="local-branch-list" className="branch-picker-list" role="list" aria-label="本地分支">
        {branches.length ? branches.map((branch, index) => (
          <BranchRow
            key={branch.name}
            branch={branch}
            selected={index === selectedIndex}
            disabled={controlsBusy}
            onChoose={switchTo}
            onOpenWorktree={(worktreeId) => { closeDialog(); openWorktreeView(projectId, worktreeId); }}
          />
        )) : <div className="branch-picker-empty">没有匹配的本地分支。</div>}
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
    </Modal>
  );
}
