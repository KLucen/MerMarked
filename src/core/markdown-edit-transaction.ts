export interface MarkdownEditSelection {
  readonly start: number;
  readonly end: number;
}

export interface MarkdownEditSnapshot {
  readonly content: string;
  readonly selection: MarkdownEditSelection;
}

export interface MarkdownEditSession {
  readonly baseline: string;
  readonly revision: number;
  readonly current: MarkdownEditSnapshot;
  readonly past: readonly MarkdownEditSnapshot[];
  readonly future: readonly MarkdownEditSnapshot[];
}

export interface MarkdownTextEdit {
  readonly selection: MarkdownEditSelection;
  readonly replacement: string;
  readonly expectedRevision: number;
}

function validBoundary(content: string, value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= content.length &&
    !(value > 0 && value < content.length && /[\uDC00-\uDFFF]/u.test(content[value]) && /[\uD800-\uDBFF]/u.test(content[value - 1]));
}

function validateSelection(content: string, selection: MarkdownEditSelection): MarkdownEditSelection {
  if (!validBoundary(content, selection.start) || !validBoundary(content, selection.end) || selection.end < selection.start) {
    throw new Error('Markdown 编辑选区已失效，请重新选择。');
  }
  return selection;
}

export function createMarkdownEditSession(content: string): MarkdownEditSession {
  if (typeof content !== 'string') throw new Error('Markdown 编辑内容无效。');
  const current = { content, selection: { start: 0, end: 0 } } satisfies MarkdownEditSnapshot;
  return { baseline: content, revision: 0, current, past: [], future: [] };
}

export function isMarkdownEditDirty(session: MarkdownEditSession): boolean {
  return session.current.content !== session.baseline;
}

export function applyMarkdownTextEdit(session: MarkdownEditSession, edit: MarkdownTextEdit): MarkdownEditSession {
  if (edit.expectedRevision !== session.revision) throw new Error('Markdown 编辑版本已过期，请重新选择。');
  const selection = validateSelection(session.current.content, edit.selection);
  if (typeof edit.replacement !== 'string') throw new Error('Markdown 替换内容无效。');
  const content = session.current.content.slice(0, selection.start) + edit.replacement + session.current.content.slice(selection.end);
  if (content === session.current.content) return session;
  const next: MarkdownEditSnapshot = { content, selection: { start: selection.start, end: selection.start + edit.replacement.length } };
  return { ...session, revision: session.revision + 1, current: next, past: [...session.past, session.current], future: [] };
}

export function undoMarkdownEdit(session: MarkdownEditSession): MarkdownEditSession {
  const previous = session.past.at(-1);
  if (!previous) return session;
  return { ...session, revision: session.revision + 1, current: previous, past: session.past.slice(0, -1), future: [session.current, ...session.future] };
}

export function redoMarkdownEdit(session: MarkdownEditSession): MarkdownEditSession {
  const next = session.future[0];
  if (!next) return session;
  return { ...session, revision: session.revision + 1, current: next, past: [...session.past, session.current], future: session.future.slice(1) };
}
