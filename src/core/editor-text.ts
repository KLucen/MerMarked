import { countGraphemes } from './reader-navigation.ts';
import type { MarkdownLineEnding } from './markdown-source.ts';

export type EditableMarkdownLineEnding = Exclude<MarkdownLineEnding, 'mixed'>;

export interface EditorSelectionPosition {
  readonly line: number;
  readonly column: number;
  readonly selectedCharacters: number;
}

export interface EditorTextMatch {
  readonly start: number;
  readonly end: number;
}

/** Browsers expose textarea newlines as LF, regardless of source bytes. */
export function markdownToEditorText(content: string): string {
  return content.replace(/\r\n|\r/g, '\n');
}

/** Rebuild the source's established newline form after textarea input. */
export function editorToMarkdownText(
  editorText: string,
  preferredLineEnding: EditableMarkdownLineEnding,
): string {
  const normalized = editorText.replace(/\r\n|\r/g, '\n');
  if (preferredLineEnding === 'crlf') return normalized.replace(/\n/g, '\r\n');
  if (preferredLineEnding === 'cr') return normalized.replace(/\n/g, '\r');
  return normalized;
}

export function editorSelectionPosition(
  editorText: string,
  selectionStart: number,
  selectionEnd: number,
): EditorSelectionPosition {
  const start = Math.max(0, Math.min(editorText.length, selectionStart));
  const end = Math.max(start, Math.min(editorText.length, selectionEnd));
  const lineStart = editorText.lastIndexOf('\n', start - 1) + 1;
  return {
    line: editorText.slice(0, start).split('\n').length,
    column: countGraphemes(editorText.slice(lineStart, start)) + 1,
    selectedCharacters: countGraphemes(editorText.slice(start, end)),
  };
}

export function findEditorTextMatches(
  editorText: string,
  query: string,
  limit = 10_000,
): readonly EditorTextMatch[] {
  if (!query || !Number.isSafeInteger(limit) || limit <= 0) return [];
  const matches: EditorTextMatch[] = [];
  let from = 0;
  while (from <= editorText.length - query.length && matches.length < limit) {
    const start = editorText.indexOf(query, from);
    if (start < 0) break;
    matches.push({ start, end: start + query.length });
    from = start + query.length;
  }
  return matches;
}

export function replaceEditorTextMatch(
  editorText: string,
  match: EditorTextMatch,
  replacement: string,
): string {
  if (
    !Number.isSafeInteger(match.start) ||
    !Number.isSafeInteger(match.end) ||
    match.start < 0 ||
    match.end < match.start ||
    match.end > editorText.length
  ) {
    throw new Error('源码查找结果已失效，请重新查找。');
  }
  return editorText.slice(0, match.start) + replacement + editorText.slice(match.end);
}

export function replaceAllEditorText(
  editorText: string,
  query: string,
  replacement: string,
): { readonly text: string; readonly count: number } {
  if (!query) return { text: editorText, count: 0 };
  let count = 0;
  const text = editorText.replaceAll(query, () => {
    count += 1;
    return replacement;
  });
  return { text, count };
}
