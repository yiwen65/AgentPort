// CodeMirror-backed document editor. The editor state is uncontrolled; the
// parent mirrors drafts through onDocChange and pushes external replacements
// (reload, undo-replace, find replacement) back through the `text` prop.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Annotation, Compartment, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  highlightTrailingWhitespace,
  highlightWhitespace,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { selectNextOccurrence } from "@codemirror/search";
import type { CodeThemeName } from "../markdownReader/codeThemeName";
import { editorThemeExtensions } from "./themes";
import { indentationGuides } from "./indentGuides";
import {
  applyFind,
  clearFind,
  findExtensions,
  replaceAllMatches,
  replaceCurrentMatch,
  undoReplace,
  type EditorFindOptions,
  type EditorFindResult,
} from "./findController";
import { createGitGutter, setGitMarks, type GitLineMark } from "./gitGutter";
import { loadLanguage, type CodeLanguageId } from "./languages";

export interface CodeSelection {
  text: string;
  startLine: number | null;
  endLine: number | null;
}

export interface CodeEditorProps {
  text: string;
  readOnly: boolean;
  language: CodeLanguageId | null;
  themeName: CodeThemeName;
  wrap: boolean;
  whitespace: boolean;
  indentWidth: number;
  useSpaces: boolean;
  visible: boolean;
  ariaLabel: string;
  enableFolding: boolean;
  enableGitGutter: boolean;
  enableIndentGuides: boolean;
  onDocChange: (text: string) => void;
  onSelectionChange: (selection: CodeSelection | null) => void;
  onSave: () => void;
  onReady?: () => void;
}

export interface CodeEditorHandle {
  focus(): void;
  revealLine(line: number): void;
  requestMeasure(): void;
  find(options: EditorFindOptions): EditorFindResult;
  clearFind(): void;
  replaceCurrent(options: EditorFindOptions, replacement: string): EditorFindResult;
  replaceAll(options: EditorFindOptions, replacement: string): number;
  undoReplace(): void;
  setGitMarks(marks: GitLineMark[] | null): void;
  getView(): EditorView | null;
}

const externalSync = Annotation.define<boolean>();

function indentExtension(width: number, useSpaces: boolean): Extension {
  return [
    indentUnit.of(useSpaces ? " ".repeat(width) : "\t"),
    EditorState.tabSize.of(width),
  ];
}

const EMPTY_FIND_RESULT: EditorFindResult = { count: 0, index: 0, invalid: false };

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastEmitted = useRef(props.text);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [ready, setReady] = useState(false);

  const compartments = useMemo(
    () => ({
      language: new Compartment(),
      theme: new Compartment(),
      wrap: new Compartment(),
      whitespace: new Compartment(),
      indent: new Compartment(),
      readOnly: new Compartment(),
      folding: new Compartment(),
      git: new Compartment(),
      guides: new Compartment(),
    }),
    [],
  );

  useEffect(() => {
    if (!props.visible || viewRef.current || !hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: props.text,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          EditorView.clickAddsSelectionRange.of((event) => event.altKey),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          history(),
          bracketMatching(),
          closeBrackets(),
          indentOnInput(),
          findExtensions,
          compartments.theme.of(editorThemeExtensions(props.themeName)),
          compartments.wrap.of(props.wrap ? EditorView.lineWrapping : []),
          compartments.whitespace.of(
            props.whitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : [],
          ),
          compartments.indent.of(indentExtension(props.indentWidth, props.useSpaces)),
          compartments.readOnly.of(props.readOnly ? EditorState.readOnly.of(true) : []),
          compartments.folding.of(props.enableFolding ? [codeFolding(), foldGutter()] : []),
          compartments.git.of(props.enableGitGutter ? createGitGutter() : []),
          compartments.guides.of(props.enableIndentGuides ? indentationGuides() : []),
          compartments.language.of([]),
          EditorView.contentAttributes.of({
            "aria-label": props.ariaLabel,
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  callbacks.current.onSave();
                  return true;
                },
              },
              { key: "Mod-d", run: selectNextOccurrence },
              { key: "Mod-Alt-ArrowUp", run: addCursorAbove },
              { key: "Mod-Alt-ArrowDown", run: addCursorBelow },
            ]),
          ),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const external = update.transactions.some((transaction) =>
                transaction.annotation(externalSync),
              );
              if (!external) {
                const next = update.state.doc.toString();
                lastEmitted.current = next;
                callbacks.current.onDocChange(next);
              }
            }
            if (update.selectionSet || update.docChanged) {
              const range = update.state.selection.main;
              const text = update.state.doc.sliceString(range.from, range.to);
              callbacks.current.onSelectionChange(
                text
                  ? {
                      text,
                      startLine: update.state.doc.lineAt(range.from).number,
                      endLine: update.state.doc.lineAt(range.to).number,
                    }
                  : null,
              );
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    lastEmitted.current = props.text;
    setReady(true);
    callbacks.current.onReady?.();
    // Creation is intentionally tied to the first visible render only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible]);

  useEffect(
    () => () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.theme.reconfigure(editorThemeExtensions(props.themeName)),
    });
  }, [ready, props.themeName, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.wrap.reconfigure(props.wrap ? EditorView.lineWrapping : []),
    });
  }, [ready, props.wrap, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.whitespace.reconfigure(
        props.whitespace ? [highlightWhitespace(), highlightTrailingWhitespace()] : [],
      ),
    });
  }, [ready, props.whitespace, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.indent.reconfigure(
        indentExtension(props.indentWidth, props.useSpaces),
      ),
    });
  }, [ready, props.indentWidth, props.useSpaces, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.readOnly.reconfigure(
        props.readOnly ? EditorState.readOnly.of(true) : [],
      ),
    });
  }, [ready, props.readOnly, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.folding.reconfigure(
        props.enableFolding ? [codeFolding(), foldGutter()] : [],
      ),
    });
  }, [ready, props.enableFolding, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.git.reconfigure(
        props.enableGitGutter ? createGitGutter() : [],
      ),
    });
  }, [ready, props.enableGitGutter, compartments]);

  useEffect(() => {
    if (!ready) return;
    viewRef.current?.dispatch({
      effects: compartments.guides.reconfigure(
        props.enableIndentGuides ? indentationGuides() : [],
      ),
    });
  }, [ready, props.enableIndentGuides, compartments]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void loadLanguage(props.language).then((extension) => {
      if (cancelled) return;
      viewRef.current?.dispatch({
        effects: compartments.language.reconfigure(extension ?? []),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [ready, props.language, compartments]);

  useEffect(() => {
    if (!ready) return;
    const view = viewRef.current;
    if (!view) return;
    if (props.text === lastEmitted.current) return;
    const current = view.state.doc.toString();
    if (current === props.text) {
      lastEmitted.current = props.text;
      return;
    }
    view.dispatch({
      changes: { from: 0, to: current.length, insert: props.text },
      annotations: [externalSync.of(true), Transaction.addToHistory.of(false)],
    });
    lastEmitted.current = props.text;
  }, [ready, props.text]);

  useEffect(() => {
    if (!props.visible) return;
    const frame = requestAnimationFrame(() => viewRef.current?.requestMeasure());
    return () => cancelAnimationFrame(frame);
  }, [props.visible]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      revealLine: (line) => {
        const view = viewRef.current;
        if (!view) return;
        const target = Math.min(Math.max(1, Math.round(line)), view.state.doc.lines);
        const position = view.state.doc.line(target).from;
        view.dispatch({
          selection: { anchor: position },
          effects: EditorView.scrollIntoView(position, { y: "center" }),
        });
        view.focus();
      },
      requestMeasure: () => viewRef.current?.requestMeasure(),
      find: (options) =>
        viewRef.current ? applyFind(viewRef.current, options) : EMPTY_FIND_RESULT,
      clearFind: () => {
        if (viewRef.current) clearFind(viewRef.current);
      },
      replaceCurrent: (options, replacement) =>
        viewRef.current
          ? replaceCurrentMatch(viewRef.current, options, replacement)
          : EMPTY_FIND_RESULT,
      replaceAll: (options, replacement) =>
        viewRef.current ? replaceAllMatches(viewRef.current, options, replacement) : 0,
      undoReplace: () => {
        if (viewRef.current) undoReplace(viewRef.current);
      },
      setGitMarks: (marks) => {
        viewRef.current?.dispatch({ effects: setGitMarks.of(marks) });
      },
      getView: () => viewRef.current,
    }),
    [],
  );

  const style = useMemo(
    () => ({ "--cm-indent-step": `${props.indentWidth}ch` }) as CSSProperties,
    [props.indentWidth],
  );

  return <div ref={hostRef} className="doc-code-editor" style={style} />;
});

export default CodeEditor;
