import { EditorView } from '@codemirror/view';

// Test-only bridge through CodeMirror's public API. No hooks are shipped by
// the product and no textarea is retained to stand in for the real editor.
function control() {
  const host = document.querySelector<HTMLElement>('[data-source-editor]');
  const view = host && EditorView.findFromDOM(host);
  if (!host || !view) return document.querySelector<HTMLTextAreaElement>('[data-editor-textarea]');
  return {
    element: view.contentDOM,
    get value() { return view.state.doc.toString(); },
    set value(value: string) {
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } });
    },
    get selectionStart() { return view.state.selection.main.from; },
    get selectionEnd() { return view.state.selection.main.to; },
    get selectionDirection() { const {anchor,head}=view.state.selection.main; return anchor===head?'none':anchor<head?'forward':'backward'; },
    get readOnly() { return view.state.readOnly; },
    get scrollTop() { return view.scrollDOM.scrollTop; },
    get scrollLeft() { return view.scrollDOM.scrollLeft; },
    get clientHeight() { return view.scrollDOM.clientHeight; },
    focus() { view.focus(); },
    setSelectionRange(start: number, end: number, direction = 'none') {
      view.dispatch({ selection: { anchor: direction === 'backward' ? end : start, head: direction === 'backward' ? start : end } });
    },
    dispatchEvent(event: Event) { return host.dispatchEvent(event); },
    addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) { host.addEventListener(type, listener, options); },
    removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions) { host.removeEventListener(type, listener, options); },
    closest(selectors: string) { return host.closest(selectors); },
    getClientRects() { return host.getClientRects(); },
    getBoundingClientRect() { return host.getBoundingClientRect(); },
  };
}
Object.assign(window, {
  __sourceControl: control,
  __sourceControlElement: () => { const value = control(); return value && ('element' in value ? value.element : value); },
  __setSourceControlValue: function(this: ReturnType<typeof control>, value: string) {
    if (this instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(this, value);
    else if (this) this.value = value;
  },
});
