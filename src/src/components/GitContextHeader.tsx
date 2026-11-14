import { useTranslation } from "react-i18next";
import {
  closeGitCenter,
  keepFrozenGitTarget,
  refreshGitChanges,
  refreshGitHistory,
  switchGitCenterToPendingSession,
} from "../gitCenter";
import { useStore } from "../store";

function shortOid(oid: string | null) {
  return oid ? oid.slice(0, 12) : "—";
}

export default function GitContextHeader() {
  const { t } = useTranslation("git");
  const center = useStore((state) => state.gitCenter);
  const cache = center.activeCheckoutId
    ? center.caches[center.activeCheckoutId]
    : null;
  const context = cache?.context;
  const refreshing =
    cache?.changesPhase === "refreshing" ||
    cache?.historyPhase === "refreshing";

  return (
    <>
      <header className="git-context-header">
        <div className="git-context-title">
          <span className="git-context-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="5" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="13" cy="14" r="2" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M5 6v6M7 4h2a4 4 0 0 1 4 4v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <div>
            <strong>{t("title")}</strong>
            {context ? (
              <div className="git-context-identity">
                <span>{context.projectName}</span>
                <span aria-hidden="true">/</span>
                <span>
                  {context.target.kind === "worktree"
                    ? t("context.worktree")
                    : t("context.main")}
                </span>
                <span className="mono">
                  {context.actualBranch ??
                    (context.detached
                      ? t("context.detached")
                      : t("context.unborn"))}
                </span>
              </div>
            ) : null}
          </div>
        </div>
        {context ? (
          <div className="git-context-facts">
            <span
              className={`git-write-badge ${context.writable ? "writable" : "readonly"}`}
            >
              {context.writable ? t("context.writable") : t("context.readOnly")}
            </span>
            <span className="mono" title={`${t("context.head")}: ${context.headOid ?? "—"}`}>
              {shortOid(context.headOid)}
            </span>
            <span className="git-context-path" title={context.checkoutRoot}>
              {context.checkoutRoot}
            </span>
          </div>
        ) : null}
        <div className="git-context-actions">
          <button
            className="btn small"
            onClick={() => {
              void refreshGitChanges();
              if (center.view === "history") void refreshGitHistory({ reset: true });
            }}
            disabled={!context || refreshing}
          >
            {refreshing ? t("refreshing") : t("refresh")}
          </button>
          <button
            className="icon-btn git-context-close"
            onClick={closeGitCenter}
            aria-label={t("close")}
          >
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
              <path
                d="M2 2l7 7M9 2l-7 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>
      {center.pendingSessionLocator ? (
        <div className="git-context-notice" role="status">
          <span>{t("sessionSwitch.message")}</span>
          <span className="spacer" />
          <button
            className="btn small"
            onClick={() => void switchGitCenterToPendingSession()}
          >
            {t("sessionSwitch.switch")}
          </button>
          <button className="btn small ghost" onClick={keepFrozenGitTarget}>
            {t("sessionSwitch.keep")}
          </button>
        </div>
      ) : null}
      {context?.liveSessionIds.length ? (
        <div className="git-context-notice warn" role="status">
          {t("context.activeSessions", { count: context.liveSessionIds.length })}
        </div>
      ) : null}
      {context?.ongoingOperation ? (
        <div className="git-context-notice danger" role="alert">
          {t("context.operationBlocked", {
            operation: context.ongoingOperation,
          })}
        </div>
      ) : null}
    </>
  );
}
