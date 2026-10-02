import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMarkdownSelectionCommand,
  executeMarkdownSelectionCommand,
} from '../../src/core/markdown-selection-commands.ts';
import { createMarkdownEditSession, undoMarkdownEdit } from '../../src/core/markdown-edit-transaction.ts';

test('copy returns raw Markdown without changing the transaction', () => {
  const session = createMarkdownEditSession('# 标题\n正文');
  const result = executeMarkdownSelectionCommand(session, {
    action: 'copy',
    expectedRevision: 0,
    selection: { start: 5, end: 7 },
  });
  assert.equal(result.kind, 'clipboard');
  assert.equal(result.text, '正文');
  assert.equal(result.session, session);
  assert.equal(session.revision, 0);
});

test('cut and paste carry raw clipboard text and share undo state', () => {
  const source = createMarkdownEditSession('甲乙');
  const cut = executeMarkdownSelectionCommand(source, {
    action: 'cut',
    expectedRevision: 0,
    selection: { start: 0, end: 1 },
  });
  assert.equal(cut.clipboardText, '甲');
  assert.equal(cut.session.current.content, '乙');
  const pasted = executeMarkdownSelectionCommand(cut.session, {
    action: 'paste',
    expectedRevision: 1,
    selection: { start: 0, end: 0 },
    text: cut.clipboardText,
  });
  assert.equal(pasted.session.current.content, '甲乙');
  assert.equal(undoMarkdownEdit(pasted.session).current.content, '乙');
});

test('bold, italic, delete, and quote edit only the selected source span', () => {
  const source = createMarkdownEditSession('前 文\n第二行 后');
  const bold = executeMarkdownSelectionCommand(source, {
    action: 'bold', expectedRevision: 0, selection: { start: 2, end: 3 },
  });
  assert.equal(bold.session.current.content, '前 **文**\n第二行 后');

  const italicStart = bold.session.current.content.indexOf('文');
  const italic = executeMarkdownSelectionCommand(bold.session, {
    action: 'italic', expectedRevision: 1, selection: { start: italicStart, end: italicStart + 1 },
  });
  assert.equal(italic.session.current.content, '前 ***文***\n第二行 后');

  const quoted = executeMarkdownSelectionCommand(createMarkdownEditSession('a\r\nb\r\n'), {
    action: 'quote', expectedRevision: 0, selection: { start: 0, end: 6 },
  });
  assert.equal(quoted.session.current.content, '> a\r\n> b\r\n');

  const deleted = executeMarkdownSelectionCommand(createMarkdownEditSession('keep remove tail'), {
    action: 'delete', expectedRevision: 0, selection: { start: 5, end: 11 },
  });
  assert.equal(deleted.session.current.content, 'keep  tail');
});

test('quote keeps a leading BOM before the Markdown marker', () => {
  const source = '\uFEFF首行\n第二行';
  const result = executeMarkdownSelectionCommand(createMarkdownEditSession(source), {
    action: 'quote',
    expectedRevision: 0,
    selection: { start: 1, end: 3 },
  });
  assert.equal(result.session.current.content, '\uFEFF> 首行\n第二行');
});

test('highlight returns an annotation intent and never changes Markdown', () => {
  const source = createMarkdownEditSession('需要标记');
  const result = executeMarkdownSelectionCommand(source, {
    action: 'highlight',
    color: 'amber',
    expectedRevision: 0,
    selection: { start: 0, end: 4 },
  });
  assert.equal(result.kind, 'annotation');
  assert.equal(result.intent.storage, 'annotations');
  assert.equal(result.intent.sourceExact, '需要标记');
  assert.equal(result.session, source);
  assert.equal(source.current.content, '需要标记');
  assert.equal(source.revision, 0);
});

test('the textarea adapter returns a focused source patch without owning history', () => {
  assert.deepEqual(applyMarkdownSelectionCommand('前后', { start: 1, end: 2 }, 'bold'), {
    changed: true,
    content: '前**后**',
    selection: { start: 1, end: 6 },
  });
});

test('stale revisions, surrogate splits, empty formatting, and missing paste text are rejected', () => {
  const source = createMarkdownEditSession('😀 text');
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'copy', expectedRevision: 1, selection: { start: 0, end: 2 },
  }), /版本已过期/);
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'bold', expectedRevision: 0, selection: { start: 1, end: 2 },
  }), /选区已失效/);
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'italic', expectedRevision: 0, selection: { start: 0, end: 0 },
  }), /需要先选择/);
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'quote', expectedRevision: 0, selection: { start: 0, end: 0 },
  }), /需要先选择/);
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'paste', expectedRevision: 0, selection: { start: 0, end: 0 },
  }), /粘贴内容无效/);
  assert.throws(() => executeMarkdownSelectionCommand(source, {
    action: 'paste', expectedRevision: 0, selection: { start: 0, end: 2 }, text: '',
  }), /粘贴内容无效/);
});

