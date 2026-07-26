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
          <span className="git-context-mark" aria-hidden="true">⌘</span>
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
            className="btn small ghost"
            onClick={() => {
              void refreshGitChanges();
              if (center.view === "history") void refreshGitHistory({ reset: true });
            }}
            disabled={!context || refreshing}
          >
            {refreshing ? t("refreshing") : t("refresh")}
          </button>
          <button
            className="icon-btn"
            onClick={closeGitCenter}
            aria-label={t("close")}
          >
            ✕
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
