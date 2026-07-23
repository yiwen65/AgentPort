// New Worktree dialog (PRD 3.5): create an auto/manual branch from a base,
// or select one exact local branch snapshot for an existing-branch Worktree.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import Modal from "./Modal";
import { api, errorText, isStructuredGitError } from "../api";
import { refreshProjects } from "../actions";
import { slugify } from "../format";
import { closeDialog, toast, useStore } from "../store";
import type { LocalBranch, LocalBranchesResponse, WorktreeBranchMode } from "../types";

function displayError(error: unknown): string {
  return isStructuredGitError(error) ? error.message : errorText(error);
}

function branchDisabled(branch: LocalBranch): boolean {
  return branch.current || Boolean(branch.checkedOutPath);
}

function branchOccupationPath(branch: LocalBranch, data: LocalBranchesResponse | null): string | null {
  if (branch.current) return data?.status.checkoutRoot ?? null;
  return branch.checkedOutPath ?? null;
}

function staleSelectionMessage(
  selected: LocalBranch,
  refreshed: LocalBranchesResponse,
): string | null {
  const branch = refreshed.branches.find((candidate) => candidate.name === selected.name);
  if (!branch) return `所选 branch ${selected.name} 已被删除，请重新选择。`;
  if (branch.oid !== selected.oid) {
    return `所选 branch ${selected.name} 已移动，请重新选择最新提交。`;
  }
  const occupiedPath = branchOccupationPath(branch, refreshed);
  if (branch.current || occupiedPath) {
    return `所选 branch ${selected.name} 已在 ${occupiedPath ?? "其他 checkout"} 使用，请重新选择。`;
  }
  return null;
}

export default function NewWorktreeDialog({ projectId }: { projectId: string }) {
  const store = useStore();
  const project = store.projects.find((candidate) => candidate.id === projectId);
  const [task, setTask] = useState("");
  const [branch, setBranch] = useState("");
  const [baseMode, setBaseMode] = useState<"head" | "ref">("head");
  const [baseRef, setBaseRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branchData, setBranchData] = useState<LocalBranchesResponse | null>(null);
  const [branchesLoading, setBranchesLoading] = useState(Boolean(project?.gitRootPath));
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [branchListOpen, setBranchListOpen] = useState(false);
  const [activeBranchIndex, setActiveBranchIndex] = useState(0);
  const [selectedExisting, setSelectedExisting] = useState<LocalBranch | null>(null);
  const [selectionIssue, setSelectionIssue] = useState<string | null>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const branchPickerRef = useRef<HTMLDivElement>(null);
  const selectedExistingRef = useRef<LocalBranch | null>(null);
  const refreshSequenceRef = useRef(0);

  useEffect(() => {
    selectedExistingRef.current = selectedExisting;
  }, [selectedExisting]);

  const refreshBranches = useCallback(async (): Promise<LocalBranchesResponse | null> => {
    const sequence = ++refreshSequenceRef.current;
    setBranchesLoading(true);
    setBranchesError(null);
    try {
      const response = await api.listLocalBranches(projectId);
      if (sequence !== refreshSequenceRef.current) return response;
      setBranchData(response);
      const selected = selectedExistingRef.current;
      if (selected) {
        const issue = staleSelectionMessage(selected, response);
        setSelectionIssue(issue);
        if (!issue) {
          setSelectedExisting(
            response.branches.find((candidate) => candidate.name === selected.name) ?? selected,
          );
        }
      }
      return response;
    } catch (refreshError) {
      if (sequence === refreshSequenceRef.current) {
        setBranchesError(displayError(refreshError));
      }
      return null;
    } finally {
      if (sequence === refreshSequenceRef.current) setBranchesLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshBranches();
    const refreshOnFocus = () => void refreshBranches();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshBranches]);

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!branchPickerRef.current?.contains(event.target as Node)) setBranchListOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, []);

  const isGitRepository = branchData?.status.isGitRepository === true;
  const showBranchCandidates = isGitRepository || (!branchData && Boolean(project?.gitRootPath));
  const filteredBranches = useMemo(() => {
    const query = branch.trim().toLocaleLowerCase();
    const candidates = branchData?.branches ?? [];
    if (!query) return candidates;
    return candidates.filter((candidate) => candidate.name.toLocaleLowerCase().includes(query));
  }, [branch, branchData?.branches]);

  useEffect(() => {
    if (!branchListOpen || filteredBranches.length === 0) {
      setActiveBranchIndex(0);
      return;
    }
    const active = filteredBranches[activeBranchIndex];
    if (active && !branchDisabled(active)) return;
    const firstAvailable = filteredBranches.findIndex((candidate) => !branchDisabled(candidate));
    setActiveBranchIndex(firstAvailable >= 0 ? firstAvailable : 0);
  }, [activeBranchIndex, branchListOpen, filteredBranches]);

  const selectExistingBranch = (candidate: LocalBranch) => {
    if (branchDisabled(candidate)) return;
    setBranch(candidate.name);
    setSelectedExisting(candidate);
    setSelectionIssue(null);
    setError(null);
    setBranchListOpen(false);
    branchInputRef.current?.focus();
  };

  const onBranchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!showBranchCandidates) return;
    if (event.key === "Escape" && branchListOpen) {
      event.preventDefault();
      event.stopPropagation();
      setBranchListOpen(false);
      branchInputRef.current?.focus();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!branchListOpen) {
        setBranchListOpen(true);
        return;
      }
      if (filteredBranches.length === 0) return;
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setActiveBranchIndex((current) =>
        (current + offset + filteredBranches.length) % filteredBranches.length,
      );
      return;
    }
    if (event.key === "Enter" && branchListOpen) {
      const candidate = filteredBranches[activeBranchIndex];
      if (!candidate || branchDisabled(candidate)) return;
      event.preventDefault();
      selectExistingBranch(candidate);
    }
  };

  const slug = slugify(task);
  const previewBranch = branch.trim() || (slug ? `agent/${slug}` : "agent/…");
  const branchMode: WorktreeBranchMode = selectedExisting
    ? "existing"
    : branch.trim()
      ? "new"
      : "auto";
  const canSubmit = Boolean(slug || branch.trim()) && !busy && !selectionIssue;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWorktree(
        projectId,
        task.trim(),
        branchMode === "existing" || baseMode !== "ref" || !baseRef.trim()
          ? null
          : baseRef.trim(),
        branchMode === "auto" ? null : branch.trim(),
        branchMode,
        selectedExisting?.oid ?? null,
      );
      await refreshProjects();
      closeDialog();
      toast(`已创建 Worktree：${res.branch}`, "success");
    } catch (createError) {
      setError(displayError(createError));
      if (branchMode === "existing") await refreshBranches();
    } finally {
      setBusy(false);
    }
  };

  const activeDescendant = branchListOpen && filteredBranches[activeBranchIndex]
    ? `wt-branch-option-${activeBranchIndex}`
    : undefined;

  return (
    <Modal
      title={`新 Worktree · ${project?.name ?? ""}`}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>取消</button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "创建中…" : "创建 Worktree"}
          </button>
        </>
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <div className="form-row">
        <label htmlFor="wt-task">任务名</label>
        <input
          id="wt-task"
          type="text"
          value={task}
          placeholder="fix-login-timeout"
          onChange={(event) => setTask(event.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="wt-branch">分支名（可选，留空自动生成；也可选择已有本地 branch）</label>
        <div className="worktree-branch-picker" ref={branchPickerRef}>
          <div className="worktree-branch-input-row">
            <input
              id="wt-branch"
              ref={branchInputRef}
              type="text"
              role={showBranchCandidates ? "combobox" : undefined}
              className="mono"
              value={branch}
              placeholder={slug ? `agent/${slug}` : "agent/<任务名>"}
              aria-label={showBranchCandidates ? "本地 branch" : undefined}
              aria-autocomplete={showBranchCandidates ? "list" : undefined}
              aria-expanded={showBranchCandidates ? branchListOpen : undefined}
              aria-controls={showBranchCandidates ? "wt-local-branch-list" : undefined}
              aria-activedescendant={activeDescendant}
              aria-describedby={selectionIssue ? "wt-branch-selection-issue" : "wt-branch-mode-hint"}
              onFocus={() => {
                if (showBranchCandidates) setBranchListOpen(true);
              }}
              onKeyDown={onBranchKeyDown}
              onChange={(event) => {
                setBranch(event.target.value);
                setSelectedExisting(null);
                setSelectionIssue(null);
                setError(null);
                setActiveBranchIndex(0);
                if (showBranchCandidates) setBranchListOpen(true);
              }}
            />
            {showBranchCandidates ? (
              <>
                <button
                  type="button"
                  className="btn ghost worktree-branch-icon-btn"
                  aria-label="刷新本地 branch"
                  disabled={branchesLoading}
                  onClick={() => {
                    void refreshBranches().finally(() => {
                      setBranchListOpen(true);
                      branchInputRef.current?.focus();
                    });
                  }}
                >
                  ↻
                </button>
                <button
                  type="button"
                  className="btn ghost worktree-branch-icon-btn"
                  aria-label={branchListOpen ? "收起本地 branch 候选" : "展开本地 branch 候选"}
                  onClick={() => {
                    setBranchListOpen((open) => !open);
                    branchInputRef.current?.focus();
                  }}
                >
                  ▾
                </button>
              </>
            ) : null}
          </div>

          {showBranchCandidates && branchListOpen ? (
            <div className="worktree-branch-popover">
              <div className="worktree-branch-popover-head">
                <span>本地 branch</span>
                <span aria-live="polite">
                  {branchesLoading ? "正在刷新…" : `${filteredBranches.length} 个候选`}
                </span>
              </div>
              {branchesError ? <div className="error-bar compact" role="alert">{branchesError}</div> : null}
              {branchesLoading && !branchData ? (
                <div className="worktree-branch-empty" role="status">正在读取本地 branch…</div>
              ) : filteredBranches.length ? (
                <div
                  id="wt-local-branch-list"
                  role="listbox"
                  aria-label="本地 branch 候选"
                  aria-busy={branchesLoading}
                >
                  {filteredBranches.map((candidate, index) => {
                    const disabled = branchDisabled(candidate);
                    const occupationPath = branchOccupationPath(candidate, branchData);
                    return (
                      <div
                        id={`wt-branch-option-${index}`}
                        key={candidate.name}
                        role="option"
                        aria-selected={index === activeBranchIndex}
                        aria-disabled={disabled}
                        className={
                          "worktree-branch-option"
                          + (index === activeBranchIndex ? " active" : "")
                          + (disabled ? " disabled" : "")
                        }
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveBranchIndex(index)}
                        onClick={() => selectExistingBranch(candidate)}
                      >
                        <span className="worktree-branch-option-main">
                          <strong className="mono">{candidate.name}</strong>
                          <code>{candidate.oid.slice(0, 12)}</code>
                        </span>
                        {candidate.current ? <span className="worktree-branch-state">当前 checkout</span> : null}
                        {!candidate.current && candidate.checkedOutPath ? (
                          <span className="worktree-branch-state">已被 Worktree 占用</span>
                        ) : null}
                        {occupationPath ? <span className="worktree-branch-path mono">{occupationPath}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="worktree-branch-empty" role="status">
                  {branch.trim()
                    ? "没有匹配的本地 branch；继续输入将创建新 branch。"
                    : "当前没有可列出的本地 branch。"}
                </div>
              )}
            </div>
          ) : null}
        </div>

        {branchesError && showBranchCandidates && !branchListOpen ? (
          <div className="error-bar compact" role="alert">{branchesError}</div>
        ) : null}
        {selectionIssue ? (
          <div id="wt-branch-selection-issue" className="error-bar compact" role="alert">
            {selectionIssue}
          </div>
        ) : selectedExisting ? (
          <div id="wt-branch-mode-hint" className="worktree-branch-mode existing">
            <span>使用已有 branch</span>
            <strong className="mono">{selectedExisting.name}</strong>
            <code>{selectedExisting.oid.slice(0, 12)}</code>
          </div>
        ) : (
          <span id="wt-branch-mode-hint" className="form-hint">
            {branch.trim() ? "创建新 branch：" : "自动生成 branch："}
            <span className="mono">{previewBranch}</span>
          </span>
        )}
      </div>

      {selectedExisting ? (
        <div className="form-row worktree-existing-base">
          <span className="form-label">基线</span>
          <span className="form-hint">
            使用所选 branch 当前提交 <span className="mono">{selectedExisting.oid.slice(0, 12)}</span>，不会创建新 branch。
          </span>
        </div>
      ) : (
        <div className="form-row">
          <span className="form-label" id="wt-base-label">基线</span>
          <div className="radio-row" role="radiogroup" aria-labelledby="wt-base-label">
            <button
              type="button"
              role="radio"
              aria-checked={baseMode === "head"}
              className={"radio-chip" + (baseMode === "head" ? " selected" : "")}
              onClick={() => setBaseMode("head")}
            >
              当前 HEAD
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={baseMode === "ref"}
              className={"radio-chip" + (baseMode === "ref" ? " selected" : "")}
              onClick={() => setBaseMode("ref")}
            >
              指定 Base Ref
            </button>
          </div>
          {baseMode === "ref" ? (
            <input
              type="text"
              className="mono"
              value={baseRef}
              placeholder="main / 分支 / commit"
              aria-label="Base Ref"
              onChange={(event) => setBaseRef(event.target.value)}
            />
          ) : null}
        </div>
      )}
      <p className="form-hint">
        Worktree 目录创建在应用数据目录下，不污染主仓库；删除前会检查未提交修改。
      </p>
    </Modal>
  );
}
