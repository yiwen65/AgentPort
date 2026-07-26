// New Worktree dialog (PRD 3.5): create an auto/manual branch from a base,
// or select one exact local branch snapshot for an existing-branch Worktree.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { Trans, useTranslation } from "react-i18next";
import Modal from "./Modal";
import { api, errorText, isStructuredGitError } from "../api";
import { refreshProjects } from "../actions";
import { closeDialog, toast, useStore } from "../store";
import type {
  LocalBranch,
  LocalBranchesResponse,
  WorktreeBranchMode,
  WorktreePreview,
} from "../types";

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
  t: TFunction<["worktree", "common"]>,
  selected: LocalBranch,
  refreshed: LocalBranchesResponse,
): string | null {
  const branch = refreshed.branches.find((candidate) => candidate.name === selected.name);
  if (!branch) {
    return t("worktree:ui.newWorktree.staleSelection.deleted", { branch: selected.name });
  }
  if (branch.oid !== selected.oid) {
    return t("worktree:ui.newWorktree.staleSelection.moved", { branch: selected.name });
  }
  const occupiedPath = branchOccupationPath(branch, refreshed);
  if (branch.current || occupiedPath) {
    return t("worktree:ui.newWorktree.staleSelection.occupied", {
      branch: selected.name,
      path: occupiedPath ?? t("worktree:ui.newWorktree.staleSelection.anotherCheckout"),
    });
  }
  return null;
}

export default function NewWorktreeDialog({ projectId }: { projectId: string }) {
  const { t } = useTranslation(["worktree", "common"]);
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
  const [preview, setPreview] = useState<{ task: string; value: WorktreePreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
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
        const issue = staleSelectionMessage(t, selected, response);
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
        setBranchesError(t("worktree:ui.newWorktree.loadBranchesFailed", {
          detail: displayError(refreshError),
        }));
      }
      return null;
    } finally {
      if (sequence === refreshSequenceRef.current) setBranchesLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void refreshBranches();
    const refreshOnFocus = () => void refreshBranches();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refreshBranches]);

  useEffect(() => {
    void api.reconcileWorktrees(projectId).then(
      (recovered) => {
        if (recovered > 0) {
          void refreshProjects();
          toast(t("worktree:ui.newWorktree.recoveredOrphans", { count: recovered }), "info");
        }
      },
      () => {
        // Branch enumeration and creation still surface authoritative Git
        // errors. A recovery probe must not make the dialog unusable.
      },
    );
  }, [projectId, t]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    const timer = window.setTimeout(() => {
      void api.previewWorktree(projectId, task).then(
        (value) => {
          if (!cancelled) setPreview({ task, value });
        },
        (previewFailure) => {
          if (!cancelled) {
            setPreviewError(t("worktree:ui.newWorktree.previewFailed", {
              detail: displayError(previewFailure),
            }));
          }
        },
      );
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId, task, t]);

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

  const currentPreview = preview?.task === task ? preview.value : null;
  const previewBranch = branch.trim() || currentPreview?.branch || "agent/…";
  const branchMode: WorktreeBranchMode = selectedExisting
    ? "existing"
    : branch.trim()
      ? "new"
      : "auto";
  const canSubmit = Boolean(task.trim() || branch.trim())
    && !busy
    && !selectionIssue
    && (branchMode !== "auto" || Boolean(currentPreview));

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
      toast(t("worktree:ui.newWorktree.createdToast", { branch: res.branch }), "success");
    } catch (createError) {
      setError(t("worktree:ui.newWorktree.createFailed", {
        detail: displayError(createError),
      }));
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
      title={t("worktree:ui.newWorktree.title", { project: project?.name ?? "" })}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn ghost" onClick={closeDialog}>{t("common:actions.cancel")}</button>
          <button className="btn primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy
              ? t("worktree:ui.newWorktree.creating")
              : t("worktree:ui.newWorktree.createWorktree")}
          </button>
        </>
      }
    >
      {error ? <div className="error-bar" role="alert">{error}</div> : null}
      <div className="form-row">
        <label htmlFor="wt-task">{t("worktree:ui.newWorktree.taskName")}</label>
        <input
          id="wt-task"
          type="text"
          value={task}
          placeholder="fix-login-timeout"
          onChange={(event) => setTask(event.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="wt-branch">{t("worktree:ui.newWorktree.branch.label")}</label>
        <div className="worktree-branch-picker" ref={branchPickerRef}>
          <div className="worktree-branch-input-row">
            <input
              id="wt-branch"
              ref={branchInputRef}
              type="text"
              role={showBranchCandidates ? "combobox" : undefined}
              className="mono"
              value={branch}
              placeholder={currentPreview?.branch
                ?? t("worktree:ui.newWorktree.branch.autoPlaceholder")}
              aria-label={showBranchCandidates
                ? t("worktree:ui.newWorktree.branch.localBranchAria")
                : undefined}
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
                  aria-label={t("worktree:ui.newWorktree.branch.refreshAria")}
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
                  aria-label={branchListOpen
                    ? t("worktree:ui.newWorktree.branch.collapseOptionsAria")
                    : t("worktree:ui.newWorktree.branch.expandOptionsAria")}
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
                <span>{t("worktree:ui.newWorktree.branch.localBranches")}</span>
                <span aria-live="polite">
                  {branchesLoading
                    ? t("worktree:ui.newWorktree.branch.refreshing")
                    : t("worktree:ui.newWorktree.branch.candidateCount", {
                        count: filteredBranches.length,
                      })}
                </span>
              </div>
              {branchesError ? <div className="error-bar compact" role="alert">{branchesError}</div> : null}
              {branchesLoading && !branchData ? (
                <div className="worktree-branch-empty" role="status">
                  {t("worktree:ui.newWorktree.branch.loadingLocalBranches")}
                </div>
              ) : filteredBranches.length ? (
                <div
                  id="wt-local-branch-list"
                  role="listbox"
                  aria-label={t("worktree:ui.newWorktree.branch.optionsAria")}
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
                        {candidate.current ? (
                          <span className="worktree-branch-state">
                            {t("worktree:ui.newWorktree.branch.currentCheckout")}
                          </span>
                        ) : null}
                        {!candidate.current && candidate.checkedOutPath ? (
                          <span className="worktree-branch-state">
                            {t("worktree:ui.newWorktree.branch.occupiedByWorktree")}
                          </span>
                        ) : null}
                        {occupationPath ? <span className="worktree-branch-path mono">{occupationPath}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="worktree-branch-empty" role="status">
                  {branch.trim()
                    ? t("worktree:ui.newWorktree.branch.noMatchCreateNew")
                    : t("worktree:ui.newWorktree.branch.noneAvailable")}
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
            <span>{t("worktree:ui.newWorktree.branch.useExisting")}</span>
            <strong className="mono">{selectedExisting.name}</strong>
            <code>{selectedExisting.oid.slice(0, 12)}</code>
          </div>
        ) : (
          <span id="wt-branch-mode-hint" className="form-hint">
            {branch.trim()
              ? t("worktree:ui.newWorktree.branch.createNew")
              : t("worktree:ui.newWorktree.branch.autoGenerate")}
            <span className="mono">{previewBranch}</span>
          </span>
        )}
      </div>

      {selectedExisting ? (
        <div className="form-row worktree-existing-base">
          <span className="form-label">{t("worktree:ui.newWorktree.base.label")}</span>
          <span className="form-hint">
            <Trans
              t={t}
              i18nKey="worktree:ui.newWorktree.base.existingBranchHint"
              values={{ oid: selectedExisting.oid.slice(0, 12) }}
              components={{ oid: <span className="mono" /> }}
            />
          </span>
        </div>
      ) : (
        <div className="form-row">
          <span className="form-label" id="wt-base-label">
            {t("worktree:ui.newWorktree.base.label")}
          </span>
          <div className="radio-row" role="radiogroup" aria-labelledby="wt-base-label">
            <button
              type="button"
              role="radio"
              aria-checked={baseMode === "head"}
              className={"radio-chip" + (baseMode === "head" ? " selected" : "")}
              onClick={() => setBaseMode("head")}
            >
              {t("worktree:ui.newWorktree.base.currentHead")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={baseMode === "ref"}
              className={"radio-chip" + (baseMode === "ref" ? " selected" : "")}
              onClick={() => setBaseMode("ref")}
            >
              {t("worktree:ui.newWorktree.base.specificRef")}
            </button>
          </div>
          {baseMode === "ref" ? (
            <input
              type="text"
              className="mono"
              value={baseRef}
              placeholder={t("worktree:ui.newWorktree.base.refPlaceholder")}
              aria-label={t("worktree:ui.newWorktree.base.refAria")}
              onChange={(event) => setBaseRef(event.target.value)}
            />
          ) : null}
        </div>
      )}
      {previewError && branchMode === "auto" ? (
        <div className="error-bar compact" role="alert">{previewError}</div>
      ) : null}
      <p className="form-hint">
        {currentPreview
          ? t("worktree:ui.newWorktree.directoryPreview", { path: currentPreview.path })
          : t("worktree:ui.newWorktree.directoryHint")}
      </p>
    </Modal>
  );
}
