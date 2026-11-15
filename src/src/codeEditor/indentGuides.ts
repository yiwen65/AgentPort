// Lightweight indentation guides. A line decoration carries the line's
// visual indent level and CSS paints one guide per indent step.

import { RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

function visualIndent(text: string, tabSize: number): number {
  let column = 0;
  for (const character of text) {
    if (character === " ") {
      column += 1;
    } else if (character === "\t") {
      column += tabSize - (column % tabSize);
    } else {
      break;
    }
  }
  return column;
}

const lineDecorations = new Map<number, Decoration>();

function guideDecoration(level: number): Decoration {
  let decoration = lineDecorations.get(level);
  if (!decoration) {
    decoration = Decoration.line({
      class: "cm-indent-guide-line",
      attributes: { style: `--cm-indent-level: ${level}` },
    });
    lineDecorations.set(level, decoration);
  }
  return decoration;
}

function buildGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const seen = new Set<number>();
  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      if (!seen.has(line.from)) {
        seen.add(line.from);
        const level = Math.floor(visualIndent(line.text, view.state.tabSize));
        if (level > 0) builder.add(line.from, line.from, guideDecoration(level));
      }
      if (line.to >= view.state.doc.length) break;
      position = line.to + 1;
    }
  }
  return builder.finish();
}

const guidePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildGuides(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = buildGuides(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function indentationGuides(): Extension {
  return guidePlugin;
}
