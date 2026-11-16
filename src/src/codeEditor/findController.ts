// Bridges the shared document find bar onto CodeMirror: query construction,
// match enumeration, highlight decorations, selection jumps and replacement.
// The app deliberately keeps its own find UI instead of CM's search panel.

import { StateEffect, StateField, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { undo } from "@codemirror/commands";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";

export interface EditorFindOptions {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  /** Requested active match index; clamped to the found range. */
  index: number;
  /** Whether finding should move the editor selection to the active match.
   * Document edits refresh highlights without stealing the caret. */
  moveSelection?: boolean;
}

export interface EditorFindResult {
  count: number;
  index: number;
  invalid: boolean;
}

export interface ReplaceAllResult {
  count: number;
  truncated: boolean;
}

export interface FindMatch {
  from: number;
  to: number;
}

interface FindHighlightState {
  matches: FindMatch[];
  active: number;
}

const MAX_MATCHES = 2000;

const setFindMatches = StateEffect.define<FindHighlightState | null>();

export const findMatchesField = StateField.define<FindHighlightState | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFindMatches)) return effect.value;
    }
    if (!value) return value;
    return transaction.docChanged ? null : value;
  },
});

const matchMark = Decoration.mark({ class: "cm-doc-find-match" });
const activeMatchMark = Decoration.mark({
  class: "cm-doc-find-match cm-doc-find-match-active",
});

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state.field(findMatchesField, false);
  if (!state || state.matches.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of view.visibleRanges) {
    for (const match of state.matches) {
      if (match.to <= match.from) continue;
      if (match.from > range.to) break;
      if (match.to < range.from) continue;
      builder.add(
        match.from,
        match.to,
        state.matches[state.active] === match ? activeMatchMark : matchMark,
      );
    }
  }
  return builder.finish();
}

const findHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(findMatchesField) !== update.state.field(findMatchesField)
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const findExtensions = [findMatchesField, findHighlighter];

function buildQuery(options: EditorFindOptions): {
  query: SearchQuery | null;
  invalid: boolean;
} {
  if (!options.query) return { query: null, invalid: false };
  try {
    const query = new SearchQuery({
      search: options.query,
      caseSensitive: options.caseSensitive,
      regexp: options.regex,
      wholeWord: options.wholeWord,
    });
    return query.valid ? { query, invalid: false } : { query: null, invalid: true };
  } catch {
    return { query: null, invalid: true };
  }
}

function enumerate(state: EditorState, query: SearchQuery): FindMatch[] {
  const matches: FindMatch[] = [];
  const cursor = query.getCursor(state);
  let next = cursor.next();
  while (!next.done) {
    matches.push({ from: next.value.from, to: next.value.to });
    if (matches.length >= MAX_MATCHES) break;
    next = cursor.next();
  }
  return matches;
}

/** Recomputes matches, highlights them and selects the active one. */
export function applyFind(view: EditorView, options: EditorFindOptions): EditorFindResult {
  const { query, invalid } = buildQuery(options);
  if (!query) {
    view.dispatch({ effects: setFindMatches.of(null) });
    return { count: 0, index: 0, invalid };
  }
  const matches = enumerate(view.state, query);
  if (matches.length === 0) {
    view.dispatch({ effects: setFindMatches.of({ matches, active: 0 }) });
    return { count: 0, index: 0, invalid: false };
  }
  const index = Math.min(Math.max(options.index, 0), matches.length - 1);
  const active = matches[index];
  const moveSelection = options.moveSelection !== false;
  view.dispatch({
    effects: [
      setFindMatches.of({ matches, active: index }),
      ...(moveSelection
        ? [EditorView.scrollIntoView(active.from, { y: "center" })]
        : []),
    ],
    ...(moveSelection
      ? { selection: { anchor: active.from, head: active.to } }
      : {}),
  });
  return { count: matches.length, index, invalid: false };
}

/** Clears highlights without touching the editor selection. */
export function clearFind(view: EditorView): void {
  view.dispatch({ effects: setFindMatches.of(null) });
}

/** Replaces the active match; returns the number of remaining matches. */
export function replaceCurrentMatch(
  view: EditorView,
  options: EditorFindOptions,
  replacement: string,
): EditorFindResult {
  const { query, invalid } = buildQuery(options);
  if (!query) return { count: 0, index: 0, invalid };
  const matches = enumerate(view.state, query);
  if (matches.length === 0) return { count: 0, index: 0, invalid: false };
  const index = Math.min(Math.max(options.index, 0), matches.length - 1);
  const active = matches[index];
  view.dispatch({
    changes: { from: active.from, to: active.to, insert: replacement },
    selection: { anchor: active.from + replacement.length },
    scrollIntoView: true,
    userEvent: "input.replace",
  });
  const remaining = enumerate(view.state, query);
  const nextIndex = remaining.length === 0 ? 0 : Math.min(index, remaining.length - 1);
  if (remaining[nextIndex]) {
    view.dispatch({
      effects: [
        setFindMatches.of({ matches: remaining, active: nextIndex }),
        EditorView.scrollIntoView(remaining[nextIndex].from, { y: "center" }),
      ],
      selection: { anchor: remaining[nextIndex].from, head: remaining[nextIndex].to },
    });
  } else {
    view.dispatch({ effects: setFindMatches.of({ matches: remaining, active: 0 }) });
  }
  return { count: remaining.length, index: nextIndex, invalid: false };
}

/** Replaces every match in one undoable transaction. Reports whether the
 * match cap left newer matches untouched. */
export function replaceAllMatches(
  view: EditorView,
  options: EditorFindOptions,
  replacement: string,
): ReplaceAllResult {
  const { query } = buildQuery(options);
  if (!query) return { count: 0, truncated: false };
  const matches = enumerate(view.state, query);
  if (matches.length === 0) return { count: 0, truncated: false };
  const truncated =
    matches.length >= MAX_MATCHES &&
    !query.getCursor(view.state, matches[matches.length - 1].to).next().done;
  view.dispatch({
    changes: matches.map((match) => ({
      from: match.from,
      to: match.to,
      insert: replacement,
    })),
    selection: { anchor: matches[0].from + replacement.length },
    scrollIntoView: true,
    userEvent: "input.replace.all",
  });
  clearFind(view);
  return { count: matches.length, truncated };
}

export function undoReplace(view: EditorView): void {
  undo(view);
}
