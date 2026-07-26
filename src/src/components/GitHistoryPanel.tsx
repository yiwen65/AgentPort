import { useTranslation } from "react-i18next";
import {
  refreshGitHistory,
  selectGitCommit,
} from "../gitCenter";
import { useStore } from "../store";
import type { GitCommitSummary } from "../types";

function readableDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function CommitRow({
  commit,
  selected,
}: {
  commit: GitCommitSummary;
  selected: boolean;
}) {
  const { t } = useTranslation("git");
  return (
    <button
      className={`git-history-row${selected ? " active" : ""}`}
      onClick={() => void selectGitCommit(commit.oid)}
      aria-current={selected ? "true" : undefined}
    >
      <span className="git-commit-dot" aria-hidden="true" />
      <span className="git-history-main">
        <strong>{commit.subject || commit.shortOid}</strong>
        <small>
          {t("history.by", {
            author: commit.authorName,
            date: readableDate(commit.committedAt),
          })}
        </small>
      </span>
      <span className="mono git-short-oid">{commit.shortOid}</span>
    </button>
  );
}

export default function GitHistoryPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  if (!cache || (cache.historyPhase === "loading" && !cache.history)) {
    return <div className="git-panel-state" role="status">{t("states.loading")}</div>;
  }
  if (cache.historyPhase === "error" && !cache.history) {
    return (
      <div className="git-panel-state error" role="alert">
        <strong>{t("states.error")}</strong>
        <span>{cache.historyError}</span>
        <button className="btn small" onClick={() => void refreshGitHistory({ reset: true })}>
          {t("retry")}
        </button>
      </div>
    );
  }
  const history = cache.history;
  return (
    <section className="git-history-panel">
      {history?.headChanged ? (
        <div className="git-inline-state info" role="status">
          <span>{t("history.newCommits")}</span>
          <button
            className="btn small"
            onClick={() => void refreshGitHistory({ reset: true })}
          >
            {t("history.refreshNow")}
          </button>
        </div>
      ) : null}
      {cache.historyPhase === "error" ? (
        <div className="git-inline-state error">{cache.historyError}</div>
      ) : null}
      {!history || history.commits.length === 0 ? (
        <div className="git-panel-state empty">{t("history.empty")}</div>
      ) : (
        <div className="git-history-list">
          {history.commits.map((commit) => (
            <CommitRow
              key={commit.oid}
              commit={commit}
              selected={cache.selectedCommitOid === commit.oid}
            />
          ))}
          {history.nextCursor ? (
            <button
              className="btn ghost git-load-more"
              disabled={cache.historyPhase === "refreshing"}
              onClick={() => void refreshGitHistory()}
            >
              {cache.historyPhase === "refreshing"
                ? t("refreshing")
                : t("actions.loadMore")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
