import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  closeGitCommitReview,
  confirmGitCommit,
  gitCommitEnabled,
} from "../gitCenter";
import { useStore } from "../store";
import Modal from "./Modal";

export default function GitCommitReviewDialog() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  const review = cache?.commitReview;
  const open = Boolean(review && cache?.commitReviewOpen);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [review?.commitToken, open]);
  if (!open || !review || !cache) return null;
  const committing = cache.commitPhase === "loading";
  const writeEnabled = gitCommitEnabled(cache);
  const context = review.context;

  return (
    <Modal
      title={t("commit.reviewTitle")}
      onClose={committing ? () => undefined : closeGitCommitReview}
      wide
      workspaceCentered
      footer={
        <>
          <button
            className="btn ghost"
            onClick={closeGitCommitReview}
            disabled={committing}
          >
            {t("commit.cancel")}
          </button>
          <button
            className="btn primary"
            onClick={() => void confirmGitCommit()}
            disabled={!confirmed || committing || !writeEnabled}
          >
            {committing ? t("commit.committing") : t("commit.confirm")}
          </button>
        </>
      }
    >
      <div className="git-review">
        <div className="git-review-warning" role="alert">
          {t("commit.reviewWarning")}
        </div>
        <dl className="git-review-context">
          <div>
            <dt>{t("commit.project")}</dt>
            <dd>{context.projectName}</dd>
          </div>
          <div>
            <dt>{t("commit.checkout")}</dt>
            <dd>
              {context.target.kind === "worktree"
                ? t("context.worktree")
                : t("context.main")}
            </dd>
          </div>
          <div className="wide">
            <dt>{t("context.canonicalPath")}</dt>
            <dd className="mono">{context.checkoutRoot}</dd>
          </div>
          <div>
            <dt>{t("context.branch")}</dt>
            <dd className="mono">
              {context.actualBranch ?? t("context.detached")}
            </dd>
          </div>
          <div>
            <dt>{t("context.head")}</dt>
            <dd className="mono">{review.beforeHead ?? t("context.unborn")}</dd>
          </div>
        </dl>
        {context.liveSessionIds.length > 0 ? (
          <div className="git-inline-state warn">
            {t("commit.activeSessionWarning")}
          </div>
        ) : null}
        {review.subjectOver72 ? (
          <div className="git-inline-state warn">{t("commit.subjectOver72")}</div>
        ) : null}
        {review.warnings
          .filter(
            (warning) =>
              !["active_sessions", "subject_over_72", "outside_project_scope"].includes(
                warning,
              ),
          )
          .map((warning) => (
            <div className="git-inline-state warn" key={warning}>{warning}</div>
          ))}
        {review.outsideProjectPaths.length > 0 ? (
          <div className="git-inline-state danger" role="alert">
            <strong>{t("commit.outsideProject")}</strong>
            {review.outsideProjectPaths.map((path) => (
              <span className="mono" key={path}>{path}</span>
            ))}
          </div>
        ) : null}
        <section className="git-review-message">
          <h3>{t("commit.fullMessage")}</h3>
          <pre>{review.message}</pre>
        </section>
        <section className="git-review-scope">
          <h3>{t("commit.scope", { count: review.files.length })}</h3>
          <div className="git-review-files" role="table">
            {review.files.map((file) => (
              <div
                className={`git-review-file${file.outsideProject ? " outside" : ""}`}
                role="row"
                key={`${file.status}:${file.pathToken}`}
              >
                <span className="git-change-kind">{file.status}</span>
                <span className="mono">
                  {file.displayOldPath
                    ? `${file.displayOldPath} → ${file.displayPath}`
                    : file.displayPath}
                </span>
                <span className="spacer" />
                <span>
                  {file.binary
                    ? t("diff.binary")
                    : `+${file.additions ?? 0} −${file.deletions ?? 0}`}
                </span>
              </div>
            ))}
          </div>
        </section>
        <label className="git-review-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={committing}
          />
          <span>{t("commit.confirm")}</span>
        </label>
      </div>
    </Modal>
  );
}
