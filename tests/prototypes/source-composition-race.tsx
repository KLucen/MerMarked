import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { EditorView, type MeasureRequest } from '@codemirror/view';
import { MarkdownEditorView } from '../../src/renderer/editor-view';
import { applyMarkdownTextEdit, createMarkdownEditSession, redoMarkdownEdit, undoMarkdownEdit } from '../../src/core/markdown-edit-transaction';

// Uses the real source surface, keyboard owner and shared history core. Only
// browser event ordering and the public measurement scheduler are controlled.
const baseline = '# Source\n\n保留 😀 ';
const trace: unknown[] = [];
const publications: string[] = [];
let activity = 0;
let controller: { reset(): void; state(): unknown; unmount(): void };
const root = createRoot(document.getElementById('root')!);

function Harness() {
  const session = useRef(createMarkdownEditSession(baseline));
  const [rendered, render] = useState(session.current);
  const [documentKey, setDocumentKey] = useState(0);
  controller = {
    reset() {
      flushSync(() => {
        session.current = createMarkdownEditSession(baseline);
        render(session.current); setDocumentKey(key => key + 1);
      });
      publications.length = 0; trace.length = 0;
    },
    state: () => ({ text: session.current.current.content, past: session.current.past.length,
      future: session.current.future.length, activity, publications: [...publications], trace: [...trace] }),
    unmount: () => flushSync(() => root.unmount()),
  };
  return <MarkdownEditorView documentKey={String(documentKey)} documentName="组合输入竞态"
    value={rendered.current.content} sourceFormat={{ bomByteLength: 0, lineEnding: 'lf', hasTrailingLineEnding: false }}
    dirty={rendered.current.content !== baseline} saving={false} sharedEditSession={rendered}
    onActivityChange={(_kind, active) => { activity += active ? 1 : -1; trace.push({ activity }); }}
    onChange={text => {
      publications.push(text); trace.push({ published: text });
      session.current = applyMarkdownTextEdit(session.current, { expectedRevision: session.current.revision,
        selection: { start: 0, end: session.current.current.content.length }, replacement: text });
      render(session.current);
    }}
    onUndo={() => { session.current = undoMarkdownEdit(session.current); render(session.current); return session.current.current.selection; }}
    onRedo={() => { session.current = redoMarkdownEdit(session.current); render(session.current); return session.current.current.selection; }} />;
}
flushSync(() => root.render(<Harness />));

function view() {
  const current = EditorView.findFromDOM(document.querySelector<HTMLElement>('[data-source-editor]')!);
  if (!current) throw Error('Actual SourceSurface EditorView is missing.');
  return current;
}
type Held = { view: EditorView; original: EditorView['requestMeasure']; requests: (MeasureRequest<unknown> | undefined)[] };
let held: Held | undefined;
function restoreMeasurements(runCallbacks = false) {
  const pending = held; held = undefined;
  if (!pending) return;
  pending.view.requestMeasure = pending.original;
  for (const request of pending.requests) {
    if (runCallbacks) {
      if (request) request.write?.(request.read(pending.view), pending.view);
    } else pending.original.call(pending.view, request);
  }
}
Object.assign(window, { sourceCompositionRace: {
  baseline,
  reset: () => { restoreMeasurements(); controller.reset(); view().focus(); },
  state: () => ({ ...(controller.state() as object), local: view().state.doc.toString() }),
  compose(type: 'compositionstart' | 'compositionend', data = '') {
    trace.push({ event: type, data });
    view().contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
  },
  candidate(text: string) {
    const current = view();
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: baseline + text },
      selection: { anchor: baseline.length + text.length }, userEvent: 'input.type.compose' });
    trace.push({ candidate: current.state.doc.toString() });
  },
  mutateDOM(text: string) {
    const current = view();
    // Keep CodeMirror's own line/text nodes and let its MutationObserver read
    // the pending final text when the next ordinary key forces a flush.
    const line = current.contentDOM.querySelector('.cm-line:last-child')!;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node || walker.nextNode()) throw Error('The race fixture must have one text node in its last line.');
    node.nodeValue = '保留 😀 ' + text;
  },
  key(keyCode: number, isComposing = false, key = 'Process', ctrlKey = false) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode, isComposing,
      key, code: ctrlKey ? `Key${key.toUpperCase()}` : 'Unidentified', ctrlKey });
    view().contentDOM.dispatchEvent(event);
    trace.push({ event: 'keydown', keyCode, isComposing, prevented: event.defaultPrevented });
    return event.defaultPrevented;
  },
  holdMeasurements() {
    if (held) throw Error('Measurements are already held.');
    const current = view();
    held = { view: current, original: current.requestMeasure, requests: [] };
    current.requestMeasure = request => { held!.requests.push(request); };
  },
  releaseMeasurements: () => restoreMeasurements(),
  runMeasuredCallbacks: () => restoreMeasurements(true),
  unmount: () => { controller.unmount(); return { activity, publications: [...publications] }; },
} });
