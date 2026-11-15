// Git gutter for the code editor. Line marks come from an unstaged unified
// diff; the editor hides them while the draft is dirty because the line
// numbers no longer match the saved file.

import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { GitLineMark, GitLineMarkType } from "./gitPatch";

export type { GitLineMark, GitLineMarkType } from "./gitPatch";

export const setGitMarks = StateEffect.define<GitLineMark[] | null>();

const gitMarksField = StateField.define<GitLineMark[] | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setGitMarks)) return effect.value;
    }
    return transaction.docChanged ? null : value;
  },
});

class GitMarker extends GutterMarker {
  constructor(readonly type: GitLineMarkType) {
    super();
  }

  eq(other: GitMarker): boolean {
    return other.type === this.type;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("div");
    marker.className = `cm-git-mark cm-git-mark-${this.type}`;
    return marker;
  }
}

const MARKERS: Record<GitLineMarkType, GitMarker> = {
  added: new GitMarker("added"),
  modified: new GitMarker("modified"),
  deleted: new GitMarker("deleted"),
};

const MARK_PRIORITY: Record<GitLineMarkType, number> = {
  modified: 3,
  added: 2,
  deleted: 1,
};

function markerRangeSet(view: EditorView) {
  const marks = view.state.field(gitMarksField, false);
  const builder = new RangeSetBuilder<GutterMarker>();
  if (!marks || marks.length === 0) return builder.finish();
  const byLine = new Map<number, GitLineMarkType>();
  for (const mark of marks) {
    const current = byLine.get(mark.line);
    if (!current || MARK_PRIORITY[mark.type] > MARK_PRIORITY[current]) {
      byLine.set(mark.line, mark.type);
    }
  }
  for (const [line, type] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    if (line < 1 || line > view.state.doc.lines) continue;
    const position = view.state.doc.line(line).from;
    builder.add(position, position, MARKERS[type]);
  }
  return builder.finish();
}

const gitGutterExtension = gutter({
  class: "cm-git-gutter",
  markers: (view) => markerRangeSet(view),
});

export function createGitGutter(): Extension {
  return [gitMarksField, gitGutterExtension];
}
