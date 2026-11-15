// Math placeholder: the KaTeX renderer is loaded lazily in a later layer, so
// the source row stays readable and selectable until then.

export default function MarkdownMath({
  tex,
  display,
  sourceLine,
}: {
  tex: string;
  display: boolean;
  sourceLine?: number;
}) {
  return (
    <span
      className={`md-math ${display ? "md-math-display" : "md-math-inline"}`}
      {...(sourceLine !== undefined ? { "data-source-line": sourceLine } : {})}
      data-search-skip="true"
    >
      <code className="md-math-source">{tex}</code>
    </span>
  );
}
