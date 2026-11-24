import { useTranslation } from "react-i18next";
import { useStore } from "../store";
import { DiffText } from "./GitDiffPanel";

export default function GitCommitPatchPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  const patch = cache?.commitPatch;
  const selectedFile = patch?.pathToken
    ? cache?.commitDetail?.files.find((file) => file.pathToken === patch.pathToken)
    : null;

  if (!cache?.selectedCommitOid) {
    return (
      <section className="git-commit-patch-panel" aria-label={t("history.diffPreview")}>
        <div className="git-panel-state empty">{t("history.select")}</div>
      </section>
    );
  }
  if (cache.commitDetailPhase === "loading" && !cache.commitDetail) {
    return (
      <section className="git-commit-patch-panel" aria-label={t("history.diffPreview")}>
        <div className="git-panel-state" role="status">{t("states.loading")}</div>
      </section>
    );
  }
  if (cache.commitDetailPhase === "error" && !cache.commitDetail) {
    return (
      <section className="git-commit-patch-panel" aria-label={t("history.diffPreview")}>
        <div className="git-panel-state error" role="alert">
          {cache.commitDetailError}
        </div>
      </section>
    );
  }

  return (
    <section className="git-commit-patch-panel" aria-label={t("history.diffPreview")}>
      <header className="git-commit-patch-head">
        <div>
          <span className="eyebrow">{t("history.diffPreview")}</span>
          <strong title={selectedFile?.displayPath ?? t("history.allFiles")}>
            {selectedFile?.displayPath ?? t("history.allFiles")}
          </strong>
        </div>
        {patch?.truncated ? (
          <span className="git-patch-badge">{t("diff.large")}</span>
        ) : null}
      </header>
      <div className="git-commit-patch">
        {cache.commitDetailPhase === "refreshing" ? (
          <div className="git-panel-state" role="status">{t("states.loading")}</div>
        ) : cache.commitDetailPhase === "error" ? (
          <div className="git-panel-state error">{cache.commitDetailError}</div>
        ) : patch?.format === "binary" ? (
          <div className="git-panel-state binary">{t("diff.binary")}</div>
        ) : patch?.patch !== null && patch?.patch !== undefined ? (
          <DiffText patch={patch.patch} />
        ) : (
          <div className="git-patch-empty">
            <span className="git-patch-empty-mark" aria-hidden="true">↗</span>
            <strong>{t("history.patchHint")}</strong>
            <span>{t("history.patchHintBody")}</span>
          </div>
        )}
      </div>
    </section>
  );
}
