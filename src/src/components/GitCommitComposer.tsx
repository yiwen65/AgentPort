import { useTranslation } from "react-i18next";
import {
  gitCommitEnabled,
  prepareGitCommitReview,
  setGitCommitDraft,
} from "../gitCenter";
import { useStore } from "../store";

export default function GitCommitComposer() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  if (!cache?.changes) return null;
  const staged = cache.changes.counts.staged;
  const subject = cache.commitDraft.split(/\r?\n/, 1)[0] ?? "";
  const messageValid =
    subject.trim().length > 0 &&
    !cache.commitDraft.includes("\0") &&
    new TextEncoder().encode(cache.commitDraft).byteLength <= 64 * 1024;
  const enabled = gitCommitEnabled(cache) && staged > 0 && messageValid;
  const preparing = cache.commitPhase === "refreshing";

  return (
    <section className="git-commit-composer">
      <header>
        <strong>{t("commit.title")}</strong>
        <span className="git-group-count">{staged}</span>
      </header>
      <textarea
        value={cache.commitDraft}
        placeholder={t("commit.placeholder")}
        onChange={(event) => setGitCommitDraft(event.target.value)}
        disabled={cache.commitPhase === "loading"}
        aria-label={t("commit.fullMessage")}
      />
      <p>{t("commit.scopeNote")}</p>
      {cache.commitError ? (
        <div className="git-inline-state error" role="alert">
          <span>{cache.commitError}</span>
          <small>{t("commit.draftPreserved")}</small>
        </div>
      ) : null}
      <button
        className="btn primary"
        disabled={!enabled || preparing}
        onClick={() => void prepareGitCommitReview()}
      >
        {preparing ? t("commit.preparing") : t("actions.reviewCommit")}
      </button>
      {staged === 0 ? <small className="dim">{t("commit.noStaged")}</small> : null}
      {cache.context.detached ? (
        <small className="git-inline-state warn">{t("commit.detachedBlocked")}</small>
      ) : cache.context.ongoingOperation ? (
        <small className="git-inline-state warn">
          {t("commit.operationBlocked", {
            operation: cache.context.ongoingOperation,
          })}
        </small>
      ) : cache.changes.counts.conflict > 0 ? (
        <small className="git-inline-state warn">{t("commit.conflictsBlocked")}</small>
      ) : null}
    </section>
  );
}
