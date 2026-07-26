import { useTranslation } from "react-i18next";
import { loadGitCommitPatch } from "../gitCenter";
import { useStore } from "../store";
import { DiffText } from "./GitDiffPanel";

export default function GitCommitDetailPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  if (!cache?.selectedCommitOid) {
    return (
      <section className="git-commit-detail-panel">
        <div className="git-panel-state empty">{t("history.select")}</div>
      </section>
    );
  }
  if (cache.commitDetailPhase === "loading" && !cache.commitDetail) {
    return (
      <section className="git-commit-detail-panel">
        <div className="git-panel-state" role="status">{t("states.loading")}</div>
      </section>
    );
  }
  if (cache.commitDetailPhase === "error" && !cache.commitDetail) {
    return (
      <section className="git-commit-detail-panel">
        <div className="git-panel-state error" role="alert">
          {cache.commitDetailError}
        </div>
      </section>
    );
  }
  const detail = cache.commitDetail;
  if (!detail) return null;
  const patch = cache.commitPatch;
  const selectedParent = patch?.parentOid ?? detail.selectedParentOid;
  return (
    <section className="git-commit-detail-panel">
      <header className="git-commit-detail-head">
        <div>
          <h3>{detail.commit.subject || detail.commit.shortOid}</h3>
          <span className="mono">{detail.commit.oid}</span>
        </div>
        {detail.commit.parentOids.length > 0 ? (
          <label>
            <span>{t("history.parent")}</span>
            <select
              value={selectedParent ?? ""}
              onChange={(event) =>
                void loadGitCommitPatch(
                  detail.commit.oid,
                  event.target.value || null,
                  null,
                )
              }
            >
              {detail.commit.parentOids.map((parent, index) => (
                <option value={parent} key={parent}>
                  {index === 0
                    ? t("history.firstParent")
                    : t("history.otherParent", { count: index + 1 })} · {parent.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>
      <div className="git-commit-meta">
        <span>{detail.commit.authorName}</span>
        <span>{detail.commit.authorEmail}</span>
        <span>{new Date(detail.commit.committedAt).toLocaleString()}</span>
      </div>
      <details className="git-commit-message" open>
        <summary>{t("history.message")}</summary>
        <pre>{detail.message}</pre>
      </details>
      <div className="git-commit-files">
        <strong>{t("history.files", { count: detail.files.length })}</strong>
        <button
          className={!patch?.pathToken ? "active" : ""}
          onClick={() =>
            void loadGitCommitPatch(detail.commit.oid, selectedParent, null)
          }
        >
          {t("history.allFiles")}
        </button>
        {detail.files.map((file) => (
          <button
            key={`${file.status}:${file.pathToken}`}
            className={patch?.pathToken === file.pathToken ? "active" : ""}
            onClick={() =>
              void loadGitCommitPatch(
                detail.commit.oid,
                selectedParent,
                file.pathToken,
              )
            }
          >
            <span className="git-change-kind">{file.status}</span>
            <span className="mono">
              {file.displayOldPath
                ? `${file.displayOldPath} → ${file.displayPath}`
                : file.displayPath}
            </span>
            <span className="spacer" />
            {file.binary
              ? t("diff.binary")
              : `+${file.additions ?? 0} −${file.deletions ?? 0}`}
          </button>
        ))}
      </div>
      <div className="git-commit-patch">
        {cache.commitDetailPhase === "refreshing" ? (
          <div className="git-panel-state" role="status">{t("states.loading")}</div>
        ) : cache.commitDetailPhase === "error" ? (
          <div className="git-panel-state error">{cache.commitDetailError}</div>
        ) : patch?.format === "binary" ? (
          <div className="git-panel-state binary">{t("diff.binary")}</div>
        ) : patch?.patch !== null && patch?.patch !== undefined ? (
          <>
            {patch.truncated ? (
              <div className="git-inline-state warn">{t("diff.large")}</div>
            ) : null}
            <DiffText patch={patch.patch} />
          </>
        ) : null}
      </div>
    </section>
  );
}
