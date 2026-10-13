import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarkdownTextEdit, createMarkdownEditSession, isMarkdownEditDirty, markMarkdownEditSaved, redoMarkdownEdit, undoMarkdownEdit } from '../../src/core/markdown-edit-transaction.ts';

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

test('saving preserves undo/redo while advancing the persisted baseline', () => {
  const initial = createMarkdownEditSession('原文😀');
  const edited = applyMarkdownTextEdit(initial, { expectedRevision: 0, selection: { start: 0, end: 2 }, replacement: '修改' });
  const saved = markMarkdownEditSaved(edited, edited.current.content);
  assert.equal(isMarkdownEditDirty(saved), false);
  assert.equal(saved.past, edited.past);
  const undone = undoMarkdownEdit(saved);
  assert.equal(undone.current.content, initial.current.content);
  assert.equal(isMarkdownEditDirty(undone), true);
  const redone = redoMarkdownEdit(undone);
  assert.equal(redone.current.content, saved.current.content);
  assert.equal(isMarkdownEditDirty(redone), false);
  const savedUndo = markMarkdownEditSaved(undone, undone.current.content);
  assert.equal(savedUndo.future, undone.future);
  assert.equal(isMarkdownEditDirty(redoMarkdownEdit(savedUndo)), true);
  assert.throws(() => markMarkdownEditSaved(edited, '另一个版本'));
});
