import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../components/Modal";
import { remoteErrorMessage } from "../../protocol/remoteError";
import type { RemoteClient } from "../../protocol/remoteClient";
import {
  branchNameOf, cleanupAutoStash, createAndSwitchGitBranch, executeGitCommit, listAutoStashes,
  listGitBranches, mutateGitPaths, prepareGitCommit, readGitChanges, readGitDiff,
  resolveGitContext, restoreAutoStash, sessionLocator, switchGitBranch,
} from "./gitApi";
import type {
  BranchSnapshot, GitChangeEntry, GitChangeKind, GitChangesSnapshot, GitCheckoutDescriptor,
  GitCommitReview, GitDiffSide, GitFileDiff, SwitchOutcome,
} from "./types";
import "./gitPanel.css";

const statusMark: Record<GitChangeKind, string> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C",
  type_changed: "T", conflict: "U", untracked: "?", ignored: "!",
};

const warningKeys: Record<string, string> = {
  active_sessions: "activeSessions",
  worktree_locked: "worktreeLocked",
  outside_project_scope: "outsideProject",
  subject_over_72: "longSubject",
};

function DiffText({ diff }: { diff: GitFileDiff }) {
  const { t } = useTranslation();
  if (diff.format !== "text" || !diff.patch) {
    return <p className="git-empty">{diff.reason ?? t("git.diffUnavailable")}</p>;
  }
  return <>
    {diff.truncated ? <p className="git-warning">{t("git.diffTruncated")}</p> : null}
    <pre className="git-diff-patch">{diff.patch.split("\n").map((line, index) => {
      const className = line.startsWith("@@") ? "is-hunk"
        : line.startsWith("+") && !line.startsWith("+++") ? "is-add"
          : line.startsWith("-") && !line.startsWith("---") ? "is-remove"
            : undefined;
      return <span key={index} className={className}>{line}{"\n"}</span>;
    })}</pre>
  </>;
}

export function GitPanel({ client, hostId, sessionId, sessionTitle, onClose, onChanged, onBranchChanged }: {
  client: RemoteClient;
  hostId: string;
  sessionId: string;
  sessionTitle: string;
  onClose: () => void;
  onChanged?: () => void;
  onBranchChanged?: (branch: string) => void;
}) {
  const { t } = useTranslation();
  const locator = useMemo(() => sessionLocator(sessionId), [sessionId]);
  const [context, setContext] = useState<GitCheckoutDescriptor>();
  const [contextError, setContextError] = useState("");
  const [tab, setTab] = useState<"changes" | "branches">("changes");
  const [changes, setChanges] = useState<GitChangesSnapshot>();
  const [changesBusy, setChangesBusy] = useState(false);
  const [changesError, setChangesError] = useState("");
  const [branches, setBranches] = useState<BranchSnapshot>();
  const [branchesBusy, setBranchesBusy] = useState(false);
  const [branchesError, setBranchesError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [mutation, setMutation] = useState("");
  const [diffRequest, setDiffRequest] = useState<{ entry: GitChangeEntry; side: GitDiffSide }>();
  const [diff, setDiff] = useState<GitFileDiff>();
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState("");
  const [discardTarget, setDiscardTarget] = useState<GitChangeEntry>();
  const [switchTarget, setSwitchTarget] = useState<string>();
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitReview, setCommitReview] = useState<GitCommitReview>();
  const [commitBusy, setCommitBusy] = useState(false);
  const [commitError, setCommitError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setContext(undefined);
    setContextError("");
    resolveGitContext(client, hostId, sessionId).then(value => {
      if (!cancelled) setContext(value);
    }).catch(error => {
      if (!cancelled) setContextError(remoteErrorMessage(error));
    });
    return () => { cancelled = true; };
  }, [client, hostId, sessionId]);

  const loadChanges = useCallback(async () => {
    setChangesBusy(true);
    setChangesError("");
    try {
      setChanges(await readGitChanges(client, hostId, locator));
    } catch (error) {
      setChangesError(remoteErrorMessage(error));
    } finally {
      setChangesBusy(false);
    }
  }, [client, hostId, locator]);

  const loadBranches = useCallback(async () => {
    if (!context) return;
    setBranchesBusy(true);
    setBranchesError("");
    try {
      setBranches(await listGitBranches(client, hostId, context.target.projectId));
    } catch (error) {
      setBranchesError(remoteErrorMessage(error));
    } finally {
      setBranchesBusy(false);
    }
  }, [client, context, hostId]);

  useEffect(() => {
    if (context) void loadChanges();
  }, [context, loadChanges]);

  useEffect(() => {
    if (context && tab === "branches" && !branches) void loadBranches();
  }, [context, tab, branches, loadBranches]);

  const refreshContext = useCallback(async () => {
    setContext(await resolveGitContext(client, hostId, sessionId));
  }, [client, hostId, sessionId]);

  const mutate = async (method: "git.stage" | "git.unstage" | "git.discard", entries: readonly GitChangeEntry[]) => {
    if (!changes || !entries.length || mutation) return;
    setMutation(entries.length === 1 ? entries[0].entryToken : "all");
    setActionError("");
    setNotice("");
    try {
      const result = await mutateGitPaths(client, hostId, method, changes, entries);
      setChanges(result.changes);
      setContext(result.changes.context);
      setDiffRequest(undefined);
      setDiff(undefined);
    } catch (error) {
      setActionError(remoteErrorMessage(error));
      await loadChanges();
    } finally {
      setMutation("");
    }
  };

  const openDiff = async (entry: GitChangeEntry, side: GitDiffSide) => {
    if (!changes) return;
    setDiffRequest({ entry, side });
    setDiff(undefined);
    setDiffError("");
    setDiffBusy(true);
    try {
      setDiff(await readGitDiff(client, hostId, locator, changes, entry, side));
    } catch (error) {
      setDiffError(remoteErrorMessage(error));
    } finally {
      setDiffBusy(false);
    }
  };

  const finishSwitch = async (outcome: SwitchOutcome) => {
    setSwitchTarget(undefined);
    setNewBranch("");
    // Only claim changes were restored when the backend did so without a
    // pending recovery; otherwise the recovered notice is set below.
    let message = !outcome.pendingRestore && outcome.stashed
      ? t("git.branch.stashed", { branch: outcome.targetBranch })
      : t("git.branch.switched", { branch: outcome.targetBranch });
    if (outcome.pendingRestore && context) {
      const projectId = context.target.projectId;
      try {
        const stashes = await listAutoStashes(client, hostId, projectId);
        const stash = stashes.find(item => item.operationId === outcome.operationId);
        if (stash && stash.phase !== "restored_verified") {
          await restoreAutoStash(client, hostId, outcome.operationId, "target");
        }
        // A verified restore is enough; dropping the stash is best effort.
        try { await cleanupAutoStash(client, hostId, outcome.operationId); } catch { /* cleanup is retryable */ }
        message = t("git.branch.restored", { branch: outcome.targetBranch });
      } catch (error) {
        // Keep the real host error; the stash stays intact for a later retry.
        setActionError(t("git.branch.restoreFailed", {
          branch: outcome.targetBranch,
          error: remoteErrorMessage(error),
        }));
      }
    }
    setNotice(message);
    onBranchChanged?.(outcome.targetBranch);
    onChanged?.();
    try { await refreshContext(); } catch { /* keep the reported outcome */ }
    await Promise.all([loadChanges(), loadBranches()]);
  };

  const runBranch = async (action: () => Promise<SwitchOutcome>) => {
    if (mutation) return;
    setMutation("branch");
    setActionError("");
    setNotice("");
    try {
      await finishSwitch(await action());
    } catch (error) {
      setActionError(remoteErrorMessage(error));
    } finally {
      setMutation("");
    }
  };

  const prepareCommit = async () => {
    if (!changes || !commitMessage.trim() || commitBusy) return;
    setCommitBusy(true);
    setCommitError("");
    setNotice("");
    try {
      setCommitReview(await prepareGitCommit(client, hostId, locator, changes, commitMessage));
    } catch (error) {
      setCommitError(remoteErrorMessage(error));
      await loadChanges();
    } finally {
      setCommitBusy(false);
    }
  };

  const runCommit = async () => {
    if (!commitReview || commitBusy) return;
    setCommitBusy(true);
    setCommitError("");
    try {
      const result = await executeGitCommit(client, hostId, locator, commitReview);
      setChanges(result.changes);
      setCommitReview(undefined);
      if (result.outcome === "succeeded") {
        setCommitMessage("");
        setNotice(t("git.commit.succeeded"));
        await refreshContext();
      } else {
        setCommitError(result.error ?? t("git.commit.uncertain"));
        await loadChanges();
      }
    } catch (error) {
      setCommitError(remoteErrorMessage(error));
      await loadChanges();
    } finally {
      setCommitBusy(false);
    }
  };

  const groups = changes ? [
    { id: "conflict", entries: changes.entries.filter(entry => entry.conflicted) },
    { id: "staged", entries: changes.entries.filter(entry => entry.staged && !entry.conflicted) },
    { id: "unstaged", entries: changes.entries.filter(entry => entry.unstaged && !entry.untracked && !entry.conflicted) },
    { id: "untracked", entries: changes.entries.filter(entry => entry.untracked) },
  ].filter(group => group.entries.length > 0) : [];
  const stageable = changes?.entries.filter(entry => !entry.ignored && !entry.conflicted && (entry.unstaged || entry.untracked)) ?? [];
  const unstageable = changes?.entries.filter(entry => entry.staged && !entry.conflicted) ?? [];
  const totalChanges = changes ? changes.counts.staged + changes.counts.unstaged + changes.counts.untracked + changes.counts.conflict : 0;
  const currentBranch = branchNameOf(branches?.status) ?? context?.actualBranch ?? undefined;
  const worktreeContext = context?.target.kind === "worktree";
  const commitBlocked = context?.detached ? t("git.commit.detached")
    : context?.unborn ? t("git.commit.unborn")
      : context?.ongoingOperation ? t("git.commit.operation", { operation: context.ongoingOperation })
        : changes?.counts.conflict ? t("git.commit.conflicts")
          : context && !context.writable ? t("git.commit.blocked", { reason: context.blockers.join(", ") })
            : !changes?.counts.staged ? t("git.commit.noStaged") : "";
  const canCommit = Boolean(changes && !commitBlocked && commitMessage.trim() && !commitBusy);

  return <Modal title={sessionTitle} onClose={onClose} className="git-panel">
    <div className="git-context">
      <span className="git-context-project">{context?.projectName ?? sessionTitle}</span>
      <span className="git-context-branch">{context?.detached ? t("git.branch.detached") : currentBranch ?? t("git.branch.loading")}</span>
    </div>
    {notice ? <p className="git-notice" role="status">{notice}</p> : null}
    {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
    {discardTarget ? <div className="git-confirm" role="alertdialog" aria-label={t("git.discard")}>
      <p>{t("git.discardConfirm", { path: discardTarget.displayPath })}</p>
      <div className="git-row-actions">
        <button type="button" onClick={() => setDiscardTarget(undefined)}>{t("common.cancel")}</button>
        <button type="button" className="danger-button" onClick={() => { const entry = discardTarget; setDiscardTarget(undefined); void mutate("git.discard", [entry]); }}>{t("git.discard")}</button>
      </div>
    </div> : null}

    {!context && !contextError ? <p className="git-empty" role="status">{t("git.loading")}</p> : null}
    {contextError ? <div className="git-error" role="alert"><p>{t("git.unavailable")}</p><small>{contextError}</small></div> : null}

    {context ? <>
      <div className="git-toolbar">
        <div className="git-tabs" role="tablist" aria-label={t("git.title")}>
          <button type="button" role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
            {t("git.changes")}{totalChanges ? <span className="git-tab-count">{totalChanges}</span> : null}
          </button>
          <button type="button" role="tab" aria-selected={tab === "branches"} onClick={() => setTab("branches")}>{t("git.branches")}</button>
        </div>
        <button type="button" className="git-refresh" disabled={changesBusy || branchesBusy} onClick={() => void (tab === "changes" ? loadChanges() : loadBranches())}>{t("git.refresh")}</button>
      </div>

      {diffRequest ? <section className="git-diff-view" aria-label={diffRequest.entry.displayPath}>
        <header className="git-subheader">
          <button type="button" className="git-back" onClick={() => { setDiffRequest(undefined); setDiff(undefined); setDiffError(""); }}>← {t("git.changes")}</button>
          <strong>{diffRequest.entry.displayPath}</strong>
        </header>
        {diffRequest.entry.staged && diffRequest.entry.unstaged ? <div className="git-segmented">
          <button type="button" className={diffRequest.side === "unstaged" ? "is-active" : undefined} onClick={() => void openDiff(diffRequest.entry, "unstaged")}>{t("git.unstaged")}</button>
          <button type="button" className={diffRequest.side === "staged" ? "is-active" : undefined} onClick={() => void openDiff(diffRequest.entry, "staged")}>{t("git.staged")}</button>
        </div> : null}
        {diffBusy ? <p className="git-empty" role="status">{t("git.loading")}</p> : null}
        {diffError ? <p className="inline-error" role="alert">{diffError}</p> : null}
        {diff ? <DiffText diff={diff} /> : null}
        <div className="git-row-actions">
          <button type="button" disabled={Boolean(mutation)} onClick={() => void mutate(diffRequest.entry.staged && !diffRequest.entry.unstaged ? "git.unstage" : "git.stage", [diffRequest.entry])}>
            {diffRequest.entry.staged && !diffRequest.entry.unstaged ? t("git.unstage") : t("git.stage")}
          </button>
          {diffRequest.entry.unstaged && !diffRequest.entry.untracked && !diffRequest.entry.conflicted ? <button type="button" className="danger-text" disabled={Boolean(mutation)} onClick={() => setDiscardTarget(diffRequest.entry)}>{t("git.discard")}</button> : null}
        </div>
      </section> : commitReview ? <section className="git-commit-review" aria-label={t("git.commit.review")}>
        <header className="git-subheader">
          <button type="button" className="git-back" onClick={() => setCommitReview(undefined)}>← {t("git.changes")}</button>
          <strong>{t("git.commit.review")}</strong>
        </header>
        <pre className="git-review-message">{commitReview.message}</pre>
        <ul className="git-review-files">{commitReview.files.map(file => <li key={file.pathToken}>
          <span className="git-status-mark is-neutral">{file.status.slice(0, 1).toUpperCase()}</span>
          <span className="git-change-path">{file.displayPath}</span>
          <small>{file.binary ? t("git.binary") : `${file.additions ?? 0} / ${file.deletions ?? 0}`}</small>
        </li>)}</ul>
        {commitReview.warnings.length ? <ul className="git-warning-list">{commitReview.warnings.map(warning => <li key={warning} className="git-warning">{t(`git.commit.warnings.${warningKeys[warning] ?? warning}`, { defaultValue: warning })}</li>)}</ul> : null}
        {commitError ? <p className="inline-error" role="alert">{commitError}</p> : null}
        <div className="git-row-actions">
          <button type="button" onClick={() => setCommitReview(undefined)} disabled={commitBusy}>{t("common.cancel")}</button>
          <button type="button" className="primary-button" onClick={() => void runCommit()} disabled={commitBusy}>{commitBusy ? t("git.commit.committing") : t("git.commit.confirm")}</button>
        </div>
      </section> : tab === "changes" ? <section className="git-changes" aria-label={t("git.changes")}>
        {changesBusy && !changes ? <p className="git-empty" role="status">{t("git.loading")}</p> : null}
        {changesError ? <div className="git-error" role="alert"><p>{changesError}</p><button type="button" onClick={() => void loadChanges()}>{t("common.retry")}</button></div> : null}
        {changes ? <>
          {changes.partialReason ? <p className="git-warning">{t("git.partial", { reason: changes.partialReason })}</p> : null}
          {totalChanges === 0 ? <p className="git-empty" role="status">{t("git.clean")}</p> : null}
          {totalChanges > 0 ? <div className="git-list-toolbar">
            {stageable.length ? <button type="button" disabled={Boolean(mutation)} onClick={() => void mutate("git.stage", stageable)}>{t("git.stageAll")}</button> : null}
            {unstageable.length ? <button type="button" disabled={Boolean(mutation)} onClick={() => void mutate("git.unstage", unstageable)}>{t("git.unstageAll")}</button> : null}
          </div> : null}
          {groups.map(group => <div className="git-group" key={group.id}>
            <h3 className="git-group-title">{t(`git.${group.id}`)}<span>{group.entries.length}</span></h3>
            <ul className="git-change-list">{group.entries.map(entry => <li className="git-change-row" data-kind={entry.kind} key={entry.entryToken}>
              <button type="button" className="git-change-open" onClick={() => void openDiff(entry, entry.staged && !entry.unstaged ? "staged" : "unstaged")}>
                <span className={`git-status-mark is-${entry.kind}`}>{statusMark[entry.kind]}</span>
                <span className="git-change-path">{entry.displayPath}{entry.displayOldPath ? <small> ← {entry.displayOldPath}</small> : null}</span>
              </button>
              {!entry.conflicted ? <button type="button" className="git-change-mutate" disabled={Boolean(mutation)} onClick={() => void mutate(entry.staged && !entry.unstaged ? "git.unstage" : "git.stage", [entry])}>
                {entry.staged && !entry.unstaged ? t("git.unstage") : t("git.stage")}
              </button> : null}
            </li>)}</ul>
          </div>)}
          {commitError ? <p className="inline-error" role="alert">{commitError}</p> : null}
          <section className="git-commit" aria-label={t("git.commit.title")}>
            <h3 className="git-group-title">{t("git.commit.title")}</h3>
            <textarea value={commitMessage} maxLength={65536} rows={3} placeholder={t("git.commit.placeholder")} aria-label={t("git.commit.placeholder")} onChange={event => setCommitMessage(event.target.value)} />
            {commitBlocked ? <p className="git-commit-hint">{commitBlocked}</p> : null}
            <div className="git-row-actions">
              <button type="button" className="primary-button" disabled={!canCommit} onClick={() => void prepareCommit()}>{commitBusy ? t("git.commit.preparing") : t("git.commit.reviewAction")}</button>
            </div>
          </section>
        </> : null}
      </section> : <section className="git-branches" aria-label={t("git.branches")}>
        {worktreeContext ? <p className="git-warning">{t("git.branch.worktreeNote", { branch: context.expectedBranch ?? currentBranch ?? "" })}</p> : null}
        {branchesBusy && !branches ? <p className="git-empty" role="status">{t("git.loading")}</p> : null}
        {branchesError ? <div className="git-error" role="alert"><p>{branchesError}</p><button type="button" onClick={() => void loadBranches()}>{t("common.retry")}</button></div> : null}
        {branches ? <>
          {switchTarget ? <div className="git-confirm" role="alertdialog" aria-label={t("git.branch.switchTo", { branch: switchTarget })}>
            <p>{t("git.branch.switchBody", { branch: switchTarget })}</p>
            <div className="git-row-actions">
              <button type="button" onClick={() => setSwitchTarget(undefined)}>{t("common.cancel")}</button>
              <button type="button" className="primary-button" disabled={mutation === "branch"} onClick={() => void runBranch(() => switchGitBranch(client, hostId, context.target.projectId, switchTarget))}>{t("git.branch.switchAction")}</button>
            </div>
          </div> : null}
          {!branches.branches.length ? <p className="git-empty" role="status">{t("git.branch.empty")}</p> : null}
          <ul className="git-branch-list">{branches.branches.map(branch => {
            const current = branch.current || branch.name === currentBranch;
            const occupied = Boolean(branch.occupiedWorktree) && !current;
            return <li key={branch.name}>
              <button type="button" className={`git-branch-row${current ? " is-current" : ""}`} disabled={current || occupied || worktreeContext || Boolean(mutation)} onClick={() => setSwitchTarget(branch.name)}>
                <span className="git-branch-name">{branch.name}</span>
                {current ? <span className="git-branch-tag">{t("git.branch.current")}</span> : occupied ? <span className="git-branch-tag">{t("git.branch.occupied")}</span> : null}
              </button>
            </li>;
          })}</ul>
          {!worktreeContext ? <div className="git-new-branch">
            <input value={newBranch} maxLength={255} autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder={t("git.branch.newBranchPlaceholder")} aria-label={t("git.branch.newBranch")} onChange={event => setNewBranch(event.target.value)} />
            <button type="button" disabled={!newBranch.trim() || Boolean(mutation)} onClick={() => void runBranch(() => createAndSwitchGitBranch(client, hostId, context.target.projectId, newBranch.trim()))}>{t("git.branch.createAndSwitch")}</button>
          </div> : null}
        </> : null}
      </section>}
    </> : null}
  </Modal>;
}
