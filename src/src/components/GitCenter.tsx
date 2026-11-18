import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  openGitCenter,
  refreshGitChanges,
  setGitCenterView,
} from "../gitCenter";
import { useStore } from "../store";
import GitChangesPanel from "./GitChangesPanel";
import GitCommitComposer from "./GitCommitComposer";
import GitCommitDetailPanel from "./GitCommitDetailPanel";
import GitCommitReviewDialog from "./GitCommitReviewDialog";
import GitContextHeader from "./GitContextHeader";
import GitDiffPanel from "./GitDiffPanel";
import GitHistoryPanel from "./GitHistoryPanel";

const VISIBLE_REFRESH_MS = 12_000;

export default function GitCenter() {
  const { t } = useTranslation("git");
  const center = useStore((state) => state.gitCenter);

  useEffect(() => {
    if (!center.open || !center.activeCheckoutId) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshGitChanges();
    }, VISIBLE_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [center.activeCheckoutId, center.open]);

  if (!center.open) return null;
  const cache = center.activeCheckoutId
    ? center.caches[center.activeCheckoutId]
    : null;
  const locator = center.locator;
  return (
    <section
      className="workspace git-center"
      aria-label={t("title")}
      data-checkout-id={center.activeCheckoutId ?? undefined}
    >
      <GitContextHeader />
      {center.resolvePhase === "loading" ? (
        <div className="git-panel-state git-resolving" role="status">
          <span className="spin" aria-hidden="true" />
          {t("states.loading")}
        </div>
      ) : center.resolvePhase === "error" ? (
        center.resolveNotRepository ? (
          <div className="git-panel-state not-repository" role="status">
            <strong>{t("states.notRepository")}</strong>
            <span>{t("states.notRepositoryBody")}</span>
            <span className="git-panel-state-hint">
              {t("states.notRepositoryHint")}
            </span>
            {locator ? (
              <button
                className="btn small"
                onClick={() => void openGitCenter(locator)}
              >
                {t("retry")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="git-panel-state error" role="alert">
            <strong>{t("states.error")}</strong>
            <span>{center.resolveError}</span>
            {locator ? (
              <button
                className="btn small"
                onClick={() => void openGitCenter(locator)}
              >
                {t("retry")}
              </button>
            ) : null}
          </div>
        )
      ) : cache ? (
        <>
          <nav className="git-center-tabs" aria-label={t("title")}>
            <button
              className={center.view === "changes" ? "active" : ""}
              aria-current={center.view === "changes" ? "page" : undefined}
              onClick={() => setGitCenterView("changes")}
            >
              {t("tabs.changes")}
              <span>
                {cache.changes
                  ? cache.changes.counts.staged +
                    cache.changes.counts.unstaged +
                    cache.changes.counts.untracked +
                    cache.changes.counts.conflict
                  : 0}
              </span>
            </button>
            <button
              className={center.view === "history" ? "active" : ""}
              aria-current={center.view === "history" ? "page" : undefined}
              onClick={() => setGitCenterView("history")}
            >
              {t("tabs.history")}
            </button>
          </nav>
          {center.view === "changes" ? (
            <div className="git-center-body changes">
              <div className="git-center-left">
                <GitChangesPanel />
                <GitCommitComposer />
              </div>
              <GitDiffPanel />
            </div>
          ) : (
            <div className="git-center-body history">
              <GitHistoryPanel />
              <GitCommitDetailPanel />
            </div>
          )}
          <GitCommitReviewDialog />
        </>
      ) : null}
    </section>
  );
}
