import { Compartment, EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, insertNewline } from '@codemirror/commands';

// Independent prototype: no application preload, IPC, filesystem or Markdown rendering.
const host = document.querySelector<HTMLElement>('#source')!;
const readonly = new Compartment();
let view: EditorView | undefined;
let textarea: HTMLTextAreaElement | undefined;
const source = {
  mount(kind: 'textarea' | 'codemirror', text: string) {
    view?.destroy(); view = undefined; textarea = undefined; host.replaceChildren();
    if (kind === 'textarea') {
      textarea = document.createElement('textarea');
      textarea.wrap = 'off'; textarea.spellcheck = false; textarea.value = text;
      textarea.setAttribute('aria-label', 'Markdown 源码'); host.append(textarea);
    } else {
      view = new EditorView({ parent: host, state: EditorState.create({ doc: text, extensions: [
        keymap.of([{ key: 'Enter', run: insertNewline }, ...defaultKeymap]),
        readonly.of(EditorState.readOnly.of(false)),
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown 源码', spellcheck: 'false' }),
        EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'Consolas, monospace', fontSize: '13px', lineHeight: '1.65', overflow: 'auto' },
          '.cm-content': { padding: '18px 0' }, '.cm-line': { padding: '0 20px' } }),
      ] }) });
    }
    this.focus();
  },
  value: () => view ? view.state.doc.toString() : textarea?.value ?? '',
  focus: () => view ? view.focus() : textarea?.focus(),
  select(start: number, end = start) {
    if (view) view.dispatch({ selection: EditorSelection.single(start, end), effects: EditorView.scrollIntoView(start) });
    else textarea?.setSelectionRange(start, end);
    this.focus();
  },
  readonly(value: boolean) {
    if (view) view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(value)) });
    else if (textarea) textarea.readOnly = value;
  },
  stats: () => ({ length: source.value().length, renderedLines: host.querySelectorAll('.cm-line').length,
    text: host.querySelector('.cm-content')?.textContent?.slice(0, 100), selection: view?.state.selection.main.toJSON() }),
};
Object.assign(window, { sourcePrototype: source });
