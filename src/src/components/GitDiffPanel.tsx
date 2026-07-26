import { useTranslation } from "react-i18next";
import { useStore } from "../store";

function patchClass(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  return "";
}

export function DiffText({ patch }: { patch: string }) {
  return (
    <pre className="git-diff-code" tabIndex={0}>
      {patch.split("\n").map((line, index) => (
        <span className={patchClass(line)} key={`${index}:${line.slice(0, 20)}`}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export default function GitDiffPanel() {
  const { t } = useTranslation("git");
  const checkoutId = useStore((state) => state.gitCenter.activeCheckoutId);
  const cache = useStore((state) =>
    checkoutId ? state.gitCenter.caches[checkoutId] : null,
  );
  if (!cache?.diffSelection) {
    return (
      <section className="git-diff-panel">
        <header><strong>{t("diff.title")}</strong></header>
        <div className="git-panel-state empty">{t("diff.empty")}</div>
      </section>
    );
  }
  const diff = cache.diff;
  return (
    <section className="git-diff-panel">
      <header>
        <div>
          <strong className="mono">{diff?.displayPath ?? "…"}</strong>
          <span className="git-diff-side">
            {cache.diffSelection.side === "staged"
              ? t("diff.staged")
              : t("diff.unstaged")}
          </span>
        </div>
        {diff ? (
          <div className="git-diff-stats">
            {diff.additions !== null && diff.deletions !== null
              ? t("diff.stats", {
                additions: diff.additions,
                deletions: diff.deletions,
              })
              : null}
            {diff.fileSize !== null ? t("diff.size", { size: diff.fileSize }) : null}
          </div>
        ) : null}
      </header>
      {cache.diffPhase === "loading" ? (
        <div className="git-panel-state" role="status">{t("states.loading")}</div>
      ) : cache.diffPhase === "error" ? (
        <div className="git-panel-state error" role="alert">{cache.diffError}</div>
      ) : diff?.format === "binary" ? (
        <div className="git-panel-state binary">{t("diff.binary")}</div>
      ) : diff?.format === "summary" ? (
        <div className="git-panel-state warn">
          <strong>{t("diff.summary")}</strong>
          <span>{t("diff.summaryReason", { reason: diff.reason ?? "unknown" })}</span>
        </div>
      ) : diff?.patch !== null && diff?.patch !== undefined ? (
        <>
          {diff.format === "conflict" ? (
            <div className="git-inline-state conflict">
              {t("diff.conflict", { code: diff.conflictCode ?? "unmerged" })}
            </div>
          ) : null}
          {diff.truncated ? (
            <div className="git-inline-state warn">{t("diff.large")}</div>
          ) : null}
          <DiffText patch={diff.patch} />
        </>
      ) : (
        <div className="git-panel-state empty">{t("diff.empty")}</div>
      )}
    </section>
  );
}
