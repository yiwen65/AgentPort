import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadGitCommitPatch } from "../gitCenter";
import { useStore } from "../store";
import type { GitCommitFile } from "../types";

const FILE_EAGER_RENDER_LIMIT = 500;
const FILE_ROW_HEIGHT = 34;
const FILE_VIEWPORT_HEIGHT = 340;
const FILE_OVERSCAN = 12;

function CommitFileButton({
  file,
  active,
  onSelect,
  binaryLabel,
  index,
  virtualized = false,
}: {
  file: GitCommitFile;
  active: boolean;
  onSelect: () => void;
  binaryLabel: string;
  index?: number;
  virtualized?: boolean;
}) {
  return (
    <button
      className={active ? "active" : ""}
      onClick={onSelect}
      style={virtualized
        ? {
          position: "absolute",
          top: `${(index ?? 0) * FILE_ROW_HEIGHT}px`,
          left: 0,
          right: 0,
          height: `${FILE_ROW_HEIGHT - 2}px`,
        }
        : undefined}
    >
      <span className="git-change-kind">{file.status}</span>
      <span className="mono">
        {file.displayOldPath
          ? `${file.displayOldPath} → ${file.displayPath}`
          : file.displayPath}
      </span>
      <span className="spacer" />
      {file.binary
        ? binaryLabel
        : `+${file.additions ?? 0} −${file.deletions ?? 0}`}
    </button>
  );
}

function CommitFileList({
  files,
  selectedPathToken,
  onSelect,
  binaryLabel,
}: {
  files: GitCommitFile[];
  selectedPathToken: string | null | undefined;
  onSelect: (file: GitCommitFile) => void;
  binaryLabel: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: FILE_EAGER_RENDER_LIMIT });
  const virtualized = files.length > FILE_EAGER_RENDER_LIMIT;

  useEffect(() => {
    if (!virtualized) return;
    const element = listRef.current;
    if (!element) return;
    const updateRange = () => {
      const visible = Math.ceil((element.clientHeight || FILE_VIEWPORT_HEIGHT) / FILE_ROW_HEIGHT);
      const requestedStart = Math.max(0, Math.floor(element.scrollTop / FILE_ROW_HEIGHT) - FILE_OVERSCAN);
      const start = Math.min(requestedStart, Math.max(0, files.length - visible));
      const end = Math.min(files.length, start + visible + FILE_OVERSCAN * 2);
      setRange((current) => current.start === start && current.end === end ? current : { start, end });
    };
    updateRange();
    element.addEventListener("scroll", updateRange, { passive: true });
    return () => element.removeEventListener("scroll", updateRange);
  }, [files.length, virtualized]);

  const visibleFiles = virtualized ? files.slice(range.start, range.end) : files;
  if (!virtualized) {
    return (
      <>
        {visibleFiles.map((file) => (
          <CommitFileButton
            key={`${file.status}:${file.pathToken}`}
            file={file}
            active={selectedPathToken === file.pathToken}
            onSelect={() => onSelect(file)}
            binaryLabel={binaryLabel}
          />
        ))}
      </>
    );
  }
  return (
    <div
      ref={listRef}
      className="git-commit-file-list-virtualized"
      style={{ height: `${FILE_VIEWPORT_HEIGHT}px` }}
    >
      <div
        className="git-commit-file-list-content"
        style={{ height: `${files.length * FILE_ROW_HEIGHT}px` }}
      >
        {visibleFiles.map((file, offset) => (
          <CommitFileButton
            key={`${file.status}:${file.pathToken}`}
            file={file}
            index={range.start + offset}
            active={selectedPathToken === file.pathToken}
            onSelect={() => onSelect(file)}
            binaryLabel={binaryLabel}
            virtualized
          />
        ))}
      </div>
    </div>
  );
}

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
        <CommitFileList
          files={detail.files}
          selectedPathToken={patch?.pathToken}
          binaryLabel={t("diff.binary")}
          onSelect={(file) =>
            void loadGitCommitPatch(
              detail.commit.oid,
              selectedParent,
              file.pathToken,
            )
          }
        />
      </div>
    </section>
  );
}
