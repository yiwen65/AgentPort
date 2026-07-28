import { useMemo, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  adoptCurrentGitWorktreeBranch,
  discardGitEntry,
  gitWritesEnabled,
  ignoreGitEntry,
  mutateAllGitChanges,
  mutateGitSelection,
  openGitFile,
  selectGitDiff,
  setAllGitSelections,
  setGitSelection,
  trashGitEntry,
} from "../gitCenter";
import {
  openContextMenu,
  useStore,
  type GitCheckoutUiState,
} from "../store";
import type {
  GitChangeEntry,
  GitDiffSide,
} from "../types";

type ChangeGroup = {
  id: "conflict" | "staged" | "unstaged" | "untracked" | "ignored";
  side: GitDiffSide;
  entries: GitChangeEntry[];
};

function groupsFor(cache: GitCheckoutUiState): ChangeGroup[] {
  const entries = (cache.changes?.entries ?? []).filter((entry) => !entry.ignored);
  return [
    {
      id: "conflict",
      side: "unstaged",
      entries: entries.filter((entry) => entry.conflicted),
    },
    {
      id: "staged",
      side: "staged",
      entries: entries.filter((entry) => entry.staged && !entry.conflicted),
    },
    {
      id: "unstaged",
      side: "unstaged",
      entries: entries.filter(
        (entry) =>
          entry.unstaged &&
          !entry.untracked &&
          !entry.conflicted &&
          !entry.ignored,
      ),
    },
    {
      id: "untracked",
      side: "unstaged",
      entries: entries.filter((entry) => entry.untracked),
    },
    {
      id: "ignored",
      side: "unstaged",
      entries: entries.filter((entry) => entry.ignored),
    },
  ];
}

function ChangeRow({
  entry,
  side,
  groupId,
  cache,
}: {
  entry: GitChangeEntry;
  side: GitDiffSide;
  groupId: ChangeGroup["id"];
  cache: GitCheckoutUiState;
}) {
  const { t } = useTranslation("git");
  const key = `${side}:${entry.entryToken}`;
  const selected = cache.selectedEntries[key] === true;
  const active =
    cache.diffSelection?.entryToken === entry.entryToken &&
    cache.diffSelection.side === side;
  const writeEnabled = gitWritesEnabled(cache);
  const actionable = groupId !== "ignored";
  const actionLabel =
    groupId === "staged"
      ? t("actions.unstage")
      : groupId === "conflict"
        ? t("actions.markResolved")
        : t("actions.stage");
  const openMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const diffSelection = {
      entryToken: entry.entryToken,
      pathToken: entry.pathToken,
      side,
    };
    openContextMenu(event.clientX, event.clientY, [
      {
        label: actionLabel,
        disabled: !writeEnabled,
        action: () => void mutateGitSelection(side, entry),
      },
      ...(entry.unstaged && !entry.untracked && !entry.conflicted
        ? [{
          label: t("fileActions.discard"),
          danger: true,
          disabled: !writeEnabled,
          action: () => void discardGitEntry(entry),
        }]
        : []),
      ...(entry.untracked
        ? [
          {
            label: t("fileActions.trash"),
            danger: true,
            disabled: !writeEnabled,
            action: () => void trashGitEntry(entry),
          },
          {
            label: t("fileActions.ignoreRepository"),
            disabled: !writeEnabled,
            action: () => void ignoreGitEntry(entry, "repository"),
          },
          {
            label: t("fileActions.ignoreLocal"),
            disabled: !writeEnabled,
            action: () => void ignoreGitEntry(entry, "local"),
          },
        ]
        : []),
      { label: "", separator: true },
      {
        label: t("fileActions.openDiff"),
        action: () => void selectGitDiff(diffSelection),
      },
      {
        label: t("fileActions.viewFile"),
        disabled: entry.kind === "deleted",
        action: () => void openGitFile(entry),
      },
    ]);
  };

  return (
    <div
      className={`git-change-row${active ? " active" : ""}${entry.conflicted ? " conflict" : ""}`}
      role="row"
      onContextMenu={openMenu}
      onClick={() => {
        if (!entry.ignored) {
          void selectGitDiff({
            entryToken: entry.entryToken,
            pathToken: entry.pathToken,
            side,
          });
        }
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={!actionable || !writeEnabled}
        aria-label={`${entry.displayPath}: ${selected ? t("selection.clearAll") : t("selection.selectAll")}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setGitSelection(entry, side, event.target.checked)}
      />
      <span className={`git-change-kind ${entry.kind}`}>
        {entry.conflictCode ?? entry.indexStatus ?? entry.worktreeStatus ?? "·"}
      </span>
      <span className="git-change-path">
        <span className="mono" title={entry.displayPath}>{entry.displayPath}</span>
        {entry.displayOldPath ? (
          <small>{t("entry.renamedFrom", { path: entry.displayOldPath })}</small>
        ) : null}
        {entry.submoduleState ? (
          <small>{t("entry.submodule", { state: entry.submoduleState })}</small>
        ) : null}
        {entry.ignored ? <small>{t("entry.ignoredNoPreview")}</small> : null}
        <small className="git-change-label">
          {t(`entry.kinds.${entry.kind}`)}
        </small>
      </span>
      {actionable ? (
        <button
          className="btn small ghost git-file-action"
          disabled={!writeEnabled}
          onClick={(event) => {
            event.stopPropagation();
            void mutateGitSelection(side, entry);
          }}
        >
          {actionLabel}
        </button>
      ) : null}
      <button
        className="icon-btn git-file-menu"
        aria-label={t("fileActions.more", { path: entry.displayPath })}
        onClick={openMenu}
      >
        ⋯
      </button>
    </div>
  );
}

function ChangeSection({
  group,
  cache,
}: {
  group: ChangeGroup;
  cache: GitCheckoutUiState;
}) {
  const { t } = useTranslation("git");
  const selectable = group.id !== "ignored";
  const selectedCount = group.entries.filter(
    (entry) => cache.selectedEntries[`${group.side}:${entry.entryToken}`],
  ).length;
  const allSelected = group.entries.length > 0 && selectedCount === group.entries.length;
  const writeEnabled = gitWritesEnabled(cache);
  if (group.entries.length === 0) return null;
  const actionLabel = group.id === "staged"
    ? t("actions.unstageSelected")
    : group.id === "conflict"
      ? t("actions.markResolved")
      : t("actions.stageSelected");

  return (
    <section className={`git-change-group ${group.id}`}>
      <header>
        {selectable ? (
          <input
            type="checkbox"
            checked={allSelected}
            disabled={!writeEnabled}
            aria-label={
              allSelected ? t("selection.clearAll") : t("selection.selectAll")
            }
            onChange={(event) =>
              setAllGitSelections(group.entries, group.side, event.target.checked)
            }
          />
        ) : <span className="git-checkbox-placeholder" />}
        <strong>{t(`groups.${group.id}`)}</strong>
        <span className="git-group-count">{group.entries.length}</span>
        <span className="spacer" />
        {selectedCount > 0 ? (
          <>
            <span className="dim">
              {t("selection.selected", { count: selectedCount })}
            </span>
            <button
              className="btn small"
              disabled={!writeEnabled}
              onClick={() => void mutateGitSelection(group.side)}
            >
              {actionLabel}
            </button>
          </>
        ) : null}
      </header>
      <div role="table">
        {group.entries.map((entry) => (
          <ChangeRow
            key={`${group.side}:${entry.entryToken}`}
            entry={entry}
            side={group.side}
            groupId={group.id}
            cache={cache}
          />
        ))}
      </div>
    </section>
  );
}

export default function GitChangesPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  const groups = useMemo(() => cache ? groupsFor(cache) : [], [cache]);

  if (!cache || cache.changesPhase === "loading" || !cache.changes) {
    if (cache?.context.blockers.includes("worktree_missing")) {
      return (
        <div className="git-panel-state error" role="alert">
          <strong>{t("states.missing")}</strong>
          <span className="mono">{cache.context.checkoutRoot}</span>
        </div>
      );
    }
    if (cache?.changesPhase === "error") {
      return (
        <div className="git-panel-state error" role="alert">
          <strong>{t("states.error")}</strong>
          <span>{cache.changesError}</span>
        </div>
      );
    }
    return <div className="git-panel-state" role="status">{t("states.loading")}</div>;
  }

  const changes = cache.changes;
  const stageable = changes.entries.filter(
    (entry) => !entry.ignored && (entry.unstaged || entry.untracked || entry.conflicted),
  ).length;
  const unstageable = changes.entries.filter(
    (entry) => entry.staged && !entry.conflicted,
  ).length;
  const canAdoptBranch =
    cache.context.target.kind === "worktree" &&
    Boolean(cache.context.expectedBranch) &&
    Boolean(cache.context.actualBranch) &&
    cache.context.expectedBranch !== cache.context.actualBranch &&
    cache.context.blockers.length === 1 &&
    cache.context.blockers[0] === "worktree_branch_drift";
  return (
    <div className="git-changes-panel">
      {stageable > 0 || unstageable > 0 ? (
        <div className="git-changes-toolbar">
          <span>{t("actions.allChanges")}</span>
          <span className="spacer" />
          {unstageable > 0 ? (
            <button
              className="btn small ghost"
              disabled={!gitWritesEnabled(cache)}
              onClick={() => void mutateAllGitChanges("staged")}
            >
              {t("actions.unstageAll")}
            </button>
          ) : null}
          {stageable > 0 ? (
            <button
              className="btn small"
              disabled={!gitWritesEnabled(cache)}
              onClick={() => void mutateAllGitChanges("unstaged")}
            >
              {t("actions.stageAll")}
            </button>
          ) : null}
        </div>
      ) : null}
      {cache.changesPhase === "stale" ? (
        <div className="git-inline-state warn" role="status">{t("states.stale")}</div>
      ) : null}
      {cache.changesPhase === "error" ? (
        <div className="git-inline-state error" role="alert">
          {cache.changesError}
        </div>
      ) : null}
      {!changes.complete ? (
        <div className="git-inline-state warn" role="alert">
          {t("states.partial", { reason: changes.partialReason ?? "unknown" })}
        </div>
      ) : null}
      {!cache.context.writable ? (
        <div className="git-inline-state warn" role="alert">
          <span>
            {cache.context.blockers.includes("worktree_missing")
              ? t("states.missing")
              : canAdoptBranch
                ? t("branchAdoption.notice", {
                  expectedBranch: cache.context.expectedBranch,
                  actualBranch: cache.context.actualBranch,
                })
                : t("states.readOnly", {
                  reason: cache.context.blockers.join(", ") || t("states.unknown"),
                })}
          </span>
          {canAdoptBranch ? (
            <button
              className="btn small"
              onClick={() => void adoptCurrentGitWorktreeBranch()}
            >
              {t("branchAdoption.confirm")}
            </button>
          ) : null}
        </div>
      ) : null}
      {changes.counts.conflict > 0 ? (
        <div className="git-inline-state conflict" role="alert">
          {t("states.conflicts", { count: changes.counts.conflict })}
        </div>
      ) : null}
      {groups.every((group) => group.entries.length === 0) ? (
        <div className="git-panel-state empty">{t("states.empty")}</div>
      ) : (
        groups.map((group) => (
          <ChangeSection key={group.id} group={group} cache={cache} />
        ))
      )}
    </div>
  );
}
