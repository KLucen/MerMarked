import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, insertNewline } from '@codemirror/commands';
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

export interface SourceSelection {
  readonly start: number;
  readonly end: number;
  readonly direction: 'forward' | 'backward' | 'none';
}
export interface SourceSurfaceHandle {
  focus(): void;
  text(): string;
  lineCount(): number;
  offsetForLine(line: number): number | null;
  selection(): SourceSelection;
  select(selection: SourceSelection, reveal?: boolean): void;
}
interface Props {
  readonly documentKey: string;
  readonly documentName: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly softWrap?: boolean;
  readonly onChange: (value: string, selection: SourceSelection) => void;
  readonly onSelect: (selection: SourceSelection) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}
function selection(view: EditorView): SourceSelection {
  const { anchor, head, from, to } = view.state.selection.main;
  return { start: from, end: to, direction: anchor === head ? 'none' : anchor < head ? 'forward' : 'backward' };
}

// The full LF source stays in EditorState. Only its visible lines are mounted;
// Markdown interpretation and all persistence remain outside this component.
export const SourceSurface = forwardRef<SourceSurfaceHandle, Props>(function SourceSurface(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const text = useRef(props.value);
  const readonly = useRef(new Compartment());
  const wrapping = useRef(new Compartment());
  const wrapped = useRef(Boolean(props.softWrap));
  const syncing = useRef(false);
  useImperativeHandle(ref, () => ({
    focus: () => editor.current?.focus(),
    text: () => text.current,
    lineCount: () => editor.current?.state.doc.lines ?? 1,
    offsetForLine: line => {
      const document = editor.current?.state.doc;
      return document && Number.isSafeInteger(line) && line >= 1 && line <= document.lines ? document.line(line).from : null;
    },
    selection: () => editor.current ? selection(editor.current) : { start: 0, end: 0, direction: 'none' },
    select: (next, reveal) => {
      const view = editor.current;
      if (!view) return;
      const start = Math.min(Math.max(0, next.start), view.state.doc.length);
      const end = Math.min(Math.max(start, next.end), view.state.doc.length);
      view.dispatch({ selection: EditorSelection.single(next.direction === 'backward' ? end : start, next.direction === 'backward' ? start : end),
        ...(reveal ? { effects: EditorView.scrollIntoView(start, { y: 'center' }) } : {}) });
    },
  }), []);

  useLayoutEffect(() => {
    const current = latest.current;
    text.current = current.value;
    wrapped.current = Boolean(current.softWrap);
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: current.value, extensions: [
      // No local history: all modes use the owner's single transaction history.
      keymap.of([{ key: 'Enter', run: insertNewline }, ...defaultKeymap]),
      EditorState.tabSize.of(4), readonly.current.of(EditorState.readOnly.of(current.readOnly)),
      wrapping.current.of(current.softWrap ? EditorView.lineWrapping : []),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', 'data-source-input': 'true', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      EditorView.updateListener.of(update => {
        if (syncing.current) return;
        if (update.docChanged) {
          text.current = update.state.doc.toString();
          latest.current.onChange(text.current, selection(update.view));
        } else if (update.selectionSet) latest.current.onSelect(selection(update.view));
      }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'inherit', fontSize: 'inherit', lineHeight: '1.65', overflow: 'auto' },
        '.cm-content': { padding: '18px 0' }, '.cm-line': { padding: '0 20px' }, '&.cm-focused': { outline: 'none' } }),
    ] }) });
    editor.current = view;
    return () => { editor.current = null; view.destroy(); };
  }, [props.documentKey]);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view) return;
    syncing.current = true;
    try {
      const effects = view.state.facet(EditorState.readOnly) !== props.readOnly
        ? readonly.current.reconfigure(EditorState.readOnly.of(props.readOnly)) : [];
      if (text.current !== props.value) {
        const { anchor, head } = view.state.selection.main;
        text.current = props.value;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, effects,
          selection: EditorSelection.single(Math.min(anchor, props.value.length), Math.min(head, props.value.length)) });
      } else if (!Array.isArray(effects)) view.dispatch({ effects });
      view.contentDOM.setAttribute('aria-readonly', String(props.readOnly));
    } finally { syncing.current = false; }
  }, [props.value, props.readOnly, props.documentKey]);

  useLayoutEffect(() => {
    const next = Boolean(props.softWrap);
    if (!editor.current || wrapped.current === next) return;
    wrapped.current = next;
    editor.current.dispatch({ effects: wrapping.current.reconfigure(next ? EditorView.lineWrapping : []) });
  }, [props.softWrap, props.documentKey]);

  return <div ref={host} className="source-editor-surface" data-source-editor="true" data-source-wrap={Boolean(props.softWrap)} title={props.documentName}
    onKeyDown={props.onKeyDown} onContextMenu={props.onContextMenu} />;
});
