import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarkdownTextEdit, createMarkdownEditSession, isMarkdownEditDirty, redoMarkdownEdit, undoMarkdownEdit } from '../../src/core/markdown-edit-transaction.ts';

test('local Markdown edits preserve surrounding BOM/CRLF content and share undo/redo state', () => {
  const session = createMarkdownEditSession('# 中文😀\r\n\r\n正文\r\n');
  const start = session.current.content.indexOf('正文');
  const edited = applyMarkdownTextEdit(session, { expectedRevision: 0, selection: { start, end: start + 2 }, replacement: '新正文' });
  assert.equal(edited.current.content, '# 中文😀\r\n\r\n新正文\r\n');
  assert.equal(edited.current.selection.start, start);
  assert.equal(isMarkdownEditDirty(edited), true);
  const undone = undoMarkdownEdit(edited);
  assert.equal(undone.current.content, session.current.content);
  const redone = redoMarkdownEdit(undone);
  assert.equal(redone.current.content, edited.current.content);
  assert.equal(redone.current.content.includes('\r\n'), true);
});

test('stale revisions, surrogate splits and invalid selections are rejected', () => {
  const session = createMarkdownEditSession('😀 text');
  assert.throws(() => applyMarkdownTextEdit(session, { expectedRevision: 1, selection: { start: 0, end: 0 }, replacement: 'x' }));
  assert.throws(() => applyMarkdownTextEdit(session, { expectedRevision: 0, selection: { start: 1, end: 1 }, replacement: 'x' }));
  assert.throws(() => applyMarkdownTextEdit(session, { expectedRevision: 0, selection: { start: 4, end: 2 }, replacement: 'x' }));
});

test('a new edit after undo clears the redo branch', () => {
  const session = createMarkdownEditSession('abc');
  const first = applyMarkdownTextEdit(session, { expectedRevision: 0, selection: { start: 0, end: 1 }, replacement: 'x' });
  const undone = undoMarkdownEdit(first);
  const second = applyMarkdownTextEdit(undone, { expectedRevision: undone.revision, selection: { start: 1, end: 2 }, replacement: 'y' });
  assert.equal(second.current.content, 'ayc');
  assert.equal(redoMarkdownEdit(second), second);
});
