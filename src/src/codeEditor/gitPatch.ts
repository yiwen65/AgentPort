// Unified-diff parsing for the git gutter. Pure data helpers so callers can
// fetch and parse marks without importing the CodeMirror editor bundle.

export type GitLineMarkType = "added" | "modified" | "deleted";

export interface GitLineMark {
  /** 1-based line in the working-tree file. */
  line: number;
  type: GitLineMarkType;
}

interface Hunk {
  newStart: number;
  addedLines: number[];
  deletedCount: number;
}

/** Parses unified-diff hunks into working-tree line marks. */
export function parseGitPatch(patch: string): GitLineMark[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let newLine = 0;
  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      current = { newStart: Number(header[1]), addedLines: [], deletedCount: 0 };
      hunks.push(current);
      newLine = Number(header[1]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("\\ No newline")) continue;
    if (raw.startsWith("+")) {
      current.addedLines.push(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      current.deletedCount += 1;
    } else if (raw.startsWith(" ")) {
      newLine += 1;
    }
  }

  const marks: GitLineMark[] = [];
  const seen = new Set<string>();
  const push = (line: number, type: GitLineMarkType) => {
    const key = `${line}:${type}`;
    if (seen.has(key)) return;
    seen.add(key);
    marks.push({ line, type });
  };
  for (const hunk of hunks) {
    const type: GitLineMarkType = hunk.deletedCount > 0 ? "modified" : "added";
    for (const line of hunk.addedLines) push(line, type);
    if (hunk.deletedCount > 0) {
      const boundary = hunk.addedLines.length > 0 ? hunk.addedLines[0] : hunk.newStart;
      push(Math.max(1, boundary), "deleted");
    }
  }
  return marks.sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));
}
