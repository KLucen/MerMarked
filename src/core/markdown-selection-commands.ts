import type { AnnotationColor } from './annotations.ts';
import {
  applyMarkdownTextEdit,
  type MarkdownEditSelection,
  type MarkdownEditSession,
} from './markdown-edit-transaction.ts';

/**
 * Commands that change the Markdown source. The selected source is kept as
 * plain Markdown so a caller can place it on the system clipboard.
 */
export type MarkdownSourceSelectionAction =
  | 'cut'
  | 'delete'
  | 'bold'
  | 'italic'
  | 'quote'
  | 'paste';

/** Action names used by lightweight UI adapters. */
export type MarkdownSelectionCommand = MarkdownSourceSelectionAction;

export interface MarkdownSelectionCommandBase {
  readonly selection: MarkdownEditSelection;
  /** Revision captured when the UI obtained the selection. */
  readonly expectedRevision: number;
}

export interface CopyMarkdownSelectionCommand extends MarkdownSelectionCommandBase {
  readonly action: 'copy';
}

export interface SourceMarkdownSelectionCommand extends MarkdownSelectionCommandBase {
  readonly action: MarkdownSourceSelectionAction;
  /** Raw Markdown clipboard text, required only for paste. */
  readonly text?: string;
}

export interface HighlightMarkdownSelectionCommand extends MarkdownSelectionCommandBase {
  readonly action: 'highlight';
  readonly color: AnnotationColor;
}

export type MarkdownSelectionCommandInput =
  | CopyMarkdownSelectionCommand
  | SourceMarkdownSelectionCommand
  | HighlightMarkdownSelectionCommand;

/** A sidecar operation request. It deliberately contains no Markdown mutation. */
export interface MarkdownHighlightIntent {
  readonly storage: 'annotations';
  readonly selection: MarkdownEditSelection;
  /** Exact source slice for the caller's anchor builder. */
  readonly sourceExact: string;
  readonly color: AnnotationColor;
}

export type MarkdownSelectionCommandResult =
  | {
      readonly action: 'copy';
      readonly kind: 'clipboard';
      readonly text: string;
      readonly session: MarkdownEditSession;
      readonly selection: MarkdownEditSelection;
    }
  | {
      readonly action: 'cut';
      readonly kind: 'markdown';
      readonly clipboardText: string;
      readonly session: MarkdownEditSession;
    }
  | {
      readonly action: 'delete' | 'bold' | 'italic' | 'quote' | 'paste';
      readonly kind: 'markdown';
      readonly session: MarkdownEditSession;
    }
  | {
      readonly action: 'highlight';
      readonly kind: 'annotation';
      readonly intent: MarkdownHighlightIntent;
      readonly session: MarkdownEditSession;
    };

const annotationColors = new Set<AnnotationColor>(['amber', 'sage', 'blue', 'rose']);

/**
 * Validate a selection through the same transaction path used for edits.
 * Replacing a range with its existing text is intentionally a no-op, so this
 * does not create a history entry or advance the revision.
 */
function checkedSelection(
  session: MarkdownEditSession,
  selection: MarkdownEditSelection,
  expectedRevision: number,
): { readonly selection: MarkdownEditSelection; readonly text: string } {
  const text = session.current.content.slice(selection.start, selection.end);
  applyMarkdownTextEdit(session, { expectedRevision, selection, replacement: text });
  return { selection, text };
}

function requireNonEmpty(text: string): void {
  if (text.length === 0) throw new Error('当前命令需要先选择 Markdown 文本。');
}

function quoteBlock(content: string, selection: MarkdownEditSelection): {
  readonly selection: MarkdownEditSelection;
  readonly replacement: string;
} {
  // Keep a leading UTF-16 BOM outside the quoted line. It is file metadata,
  // not visible Markdown content, and must remain the first code unit.
  const bomOffset = content.startsWith('\uFEFF') ? 1 : 0;
  const lineStart = content.lastIndexOf('\n', Math.max(bomOffset, selection.start - 1)) + 1;
  const start = Math.max(bomOffset, lineStart);
  const breakAt = content.indexOf('\n', selection.end);
  const end = breakAt < 0 ? content.length : breakAt;
  const block = content.slice(start, end);
  const parts = block.split(/(\r\n|\r|\n)/u);
  const lines = parts.filter((_part, index) => index % 2 === 0);
  const alreadyQuoted = lines.every((line) => line.length === 0 || /^> ?/u.test(line));
  const replacement = parts.map((part, index) => {
    if (index % 2 === 1) return part;
    if (index === parts.length - 1 && part.length === 0 && /(?:\r\n|\r|\n)$/u.test(block)) return part;
    return alreadyQuoted ? part.replace(/^> ?/u, '') : `> ${part}`;
  }).join('');
  return { selection: { start, end }, replacement };
}

function replacementFor(action: MarkdownSourceSelectionAction, text: string, pasted: string | undefined): string {
  switch (action) {
    case 'delete':
    case 'cut':
      return '';
    case 'bold':
      requireNonEmpty(text);
      return `**${text}**`;
    case 'italic':
      requireNonEmpty(text);
      return `*${text}*`;
    case 'quote':
      requireNonEmpty(text);
      return text;
    case 'paste':
      if (pasted === undefined) throw new Error('粘贴内容无效。');
      return pasted;
  }
}

/**
 * Execute one selection command against the shared Markdown transaction.
 *
 * `copy` and `cut` expose raw Markdown clipboard text. `bold`, `italic`,
 * `quote`, `delete`, and `paste` update the source and enter the transaction's
 * undo stack. `highlight` is intentionally sidecar-only: the renderer must
 * map its source selection to a complete AnnotationAnchor before persisting.
 */
export function executeMarkdownSelectionCommand(
  session: MarkdownEditSession,
  command: MarkdownSelectionCommandInput,
): MarkdownSelectionCommandResult {
  const checked = checkedSelection(session, command.selection, command.expectedRevision);

  if (command.action === 'copy') {
    return {
      action: 'copy',
      kind: 'clipboard',
      text: checked.text,
      session,
      selection: checked.selection,
    };
  }

  if (command.action === 'highlight') {
    if (checked.text.length === 0) throw new Error('高亮需要先选择 Markdown 文本。');
    if (!annotationColors.has(command.color)) throw new Error('高亮颜色无效。');
    return {
      action: 'highlight',
      kind: 'annotation',
      intent: {
        storage: 'annotations',
        selection: checked.selection,
        sourceExact: checked.text,
        color: command.color,
      },
      session,
    };
  }

  const quote = command.action === 'quote' ? quoteBlock(session.current.content, checked.selection) : null;
  const effectiveSelection = quote?.selection ?? checked.selection;
  const selectedText = session.current.content.slice(effectiveSelection.start, effectiveSelection.end);
  const replacement = quote?.replacement ?? replacementFor(command.action, selectedText, command.text);
  const next = applyMarkdownTextEdit(session, {
    expectedRevision: command.expectedRevision,
    selection: effectiveSelection,
    replacement,
  });
  if (command.action === 'cut') {
    return { action: 'cut', kind: 'markdown', clipboardText: checked.text, session: next };
  }
  return { action: command.action, kind: 'markdown', session: next };
}

/**
 * Content/selection adapter for a textarea that has not adopted a
 * `MarkdownEditSession` object yet. New integrations should prefer
 * `executeMarkdownSelectionCommand` so revision checks and undo state remain
 * shared; this adapter exists to keep the source command pure at the edge.
 */
export function applyMarkdownSelectionCommand(
  content: string,
  selection: MarkdownEditSelection,
  action: MarkdownSelectionCommand,
): { readonly changed: boolean; readonly content: string; readonly selection: MarkdownEditSelection } {
  const session = {
    baseline: content,
    revision: 0,
    current: { content, selection: { start: 0, end: 0 } },
    past: [],
    future: [],
  } satisfies MarkdownEditSession;
  const result = executeMarkdownSelectionCommand(session, {
    action,
    expectedRevision: 0,
    selection,
  });
  if (result.kind !== 'markdown') {
    throw new Error('该 Markdown 命令不会改写源码。');
  }
  return {
    changed: result.session.current.content !== content,
    content: result.session.current.content,
    selection: result.session.current.selection,
  };
}

