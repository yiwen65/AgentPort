export type DiffLineKind = "" | "add" | "del" | "meta" | "hunk";

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
  oldNumber: number | null;
  newNumber: number | null;
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parses a unified diff into rows with independent old/new line numbers. */
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
  const rawLines = patch.split("\n");
  if (rawLines.at(-1) === "") rawLines.pop();

  for (const text of rawLines) {
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
        lines.push({ text, kind: "hunk", oldNumber: null, newNumber: null });
        continue;
      }
      // In an implicit (header-less) untracked patch every row is prefixed
      // with "+", so content such as "++ x" becomes "+++ x" and must stay an
      // added line, not be mistaken for the next file header.
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
      if (text.startsWith("+++ ")) {
        implicitNewNumber = 1;
        lines.push({ text, kind: "meta", oldNumber: null, newNumber: null });
        continue;
      }
      if (!text.startsWith("\\")) implicitNewNumber = null;
      lines.push({ text, kind: "meta", oldNumber: null, newNumber: null });
      continue;
    }

    if (text.startsWith("\\")) {
      lines.push({ text, kind: "meta", oldNumber: null, newNumber: null });
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
