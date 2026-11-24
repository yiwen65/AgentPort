import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "../store";

type DiffLineKind = "" | "add" | "del" | "meta";

interface DiffLine {
  text: string;
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function patchClass(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "meta";
  }
  return "";
}

export function parseDiffLines(patch: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  // Untracked-file patches synthesized by the backend omit the @@ header, so
  // count their added lines from 1 after the +++ file header.
  let implicitNewNumber: number | null = null;

  for (const text of patch.split("\n")) {
    if (inHunk && oldRemaining <= 0 && newRemaining <= 0) inHunk = false;

    if (!inHunk) {
      const hunk = HUNK_HEADER.exec(text);
      if (hunk) {
        oldNumber = Number(hunk[1]);
        oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
        newNumber = Number(hunk[3]);
        newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
        inHunk = true;
        implicitNewNumber = null;
        lines.push({ text, kind: "meta", oldNumber: null, newNumber: null });
        continue;
      }
      if (text.startsWith("+++ ")) {
        implicitNewNumber = 1;
        lines.push({ text, kind: "meta", oldNumber: null, newNumber: null });
        continue;
      }
      if (implicitNewNumber !== null && text.startsWith("+")) {
        lines.push({
          text,
          kind: "add",
          oldNumber: null,
          newNumber: implicitNewNumber,
        });
        implicitNewNumber += 1;
        continue;
      }
      if (!text.startsWith("\\")) implicitNewNumber = null;
      lines.push({ text, kind: patchClass(text), oldNumber: null, newNumber: null });
      continue;
    }

    if (text.startsWith("\\")) {
      lines.push({ text, kind: "", oldNumber: null, newNumber: null });
    } else if (text.startsWith("+")) {
      newRemaining -= 1;
      lines.push({ text, kind: "add", oldNumber: null, newNumber });
      newNumber += 1;
    } else if (text.startsWith("-")) {
      oldRemaining -= 1;
      lines.push({ text, kind: "del", oldNumber, newNumber: null });
      oldNumber += 1;
    } else {
      oldRemaining -= 1;
      newRemaining -= 1;
      lines.push({ text, kind: "", oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }
  return lines;
}

const EAGER_RENDER_LIMIT = 500;
const DIFF_LINE_HEIGHT = 18.4;
const VIRTUAL_OVERSCAN = 20;
const DEFAULT_VIEWPORT_ROWS = 80;

function DiffLineView({
  line,
  index,
  virtualized = false,
}: {
  line: DiffLine;
  index: number;
  virtualized?: boolean;
}) {
  return (
    <span
      className={line.kind}
      key={`${index}:${line.text.slice(0, 20)}`}
      style={virtualized
        ? {
          position: "absolute",
          top: `${index * DIFF_LINE_HEIGHT}px`,
          left: 0,
          minWidth: "100%",
        }
        : undefined}
    >
      <span className="git-diff-line-no" aria-hidden="true">
        {line.oldNumber ?? ""}
      </span>
      <span className="git-diff-line-no" aria-hidden="true">
        {line.newNumber ?? ""}
      </span>
      <span className="git-diff-line-text">
        {line.text}
        {"\n"}
      </span>
    </span>
  );
}

function VirtualizedDiffLines({ lines }: { lines: DiffLine[] }) {
  const codeRef = useRef<HTMLPreElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: DEFAULT_VIEWPORT_ROWS });

  const updateRange = (element: HTMLElement) => {
    const viewportRows = Math.ceil(
      (element.clientHeight || DEFAULT_VIEWPORT_ROWS * DIFF_LINE_HEIGHT) / DIFF_LINE_HEIGHT,
    );
    const requestedStart = Math.max(
      0,
      Math.floor(element.scrollTop / DIFF_LINE_HEIGHT) - VIRTUAL_OVERSCAN,
    );
    const start = Math.min(
      requestedStart,
      Math.max(0, lines.length - viewportRows),
    );
    const end = Math.min(lines.length, start + viewportRows + VIRTUAL_OVERSCAN * 2);
    setRange((current) => current.start === start && current.end === end ? current : { start, end });
  };

  useEffect(() => {
    const element = codeRef.current;
    if (!element) return;
    updateRange(element);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => updateRange(element));
    resizeObserver?.observe(element);
    return () => resizeObserver?.disconnect();
  }, [lines.length]);

  return (
    <pre
      ref={codeRef}
      className="git-diff-code git-diff-code-virtualized"
      tabIndex={0}
      onScroll={(event) => updateRange(event.currentTarget)}
    >
      <span
        className="git-diff-virtual-content"
        style={{ height: `${lines.length * DIFF_LINE_HEIGHT}px` }}
      >
        {lines.slice(range.start, range.end).map((line, offset) => (
          <DiffLineView
            line={line}
            index={range.start + offset}
            virtualized
            key={`${range.start + offset}:${line.text.slice(0, 20)}`}
          />
        ))}
      </span>
    </pre>
  );
}

export function DiffText({ patch }: { patch: string }) {
  const lines = useMemo(() => parseDiffLines(patch), [patch]);
  if (lines.length > EAGER_RENDER_LIMIT) {
    return <VirtualizedDiffLines lines={lines} />;
  }
  return (
    <pre className="git-diff-code" tabIndex={0}>
      {lines.map((line, index) => <DiffLineView line={line} index={index} key={`${index}:${line.text.slice(0, 20)}`} />)}
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
          <strong className="mono" title={diff?.displayPath ?? undefined}>
            {diff?.displayPath ?? "…"}
          </strong>
          <span className="git-diff-side">
            {cache.diffSelection.side === "staged"
              ? t("diff.staged")
              : t("diff.unstaged")}
          </span>
        </div>
        {diff ? (
          <div className="git-diff-stats">
            {diff.additions !== null && diff.deletions !== null
              ? (
                <span>
                  {t("diff.stats", {
                    additions: diff.additions,
                    deletions: diff.deletions,
                  })}
                </span>
              )
              : null}
            {diff.fileSize !== null ? (
              <span>{t("diff.size", { size: diff.fileSize })}</span>
            ) : null}
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
