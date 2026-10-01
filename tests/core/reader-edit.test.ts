import assert from 'node:assert/strict';
import test from 'node:test';
import { applyReaderPlainTextEdit } from '../../src/core/reader-edit.ts';

test('edits a plain paragraph while preserving BOM and CRLF bytes', () => {
  const source = '\uFEFF# 标题\r\n\r\n原始正文\r\n';
  const blockStart = source.indexOf('原始正文') - 1;
  const result = applyReaderPlainTextEdit(source, 3, { blockStart, replacement: '修改后的正文' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, '\uFEFF# 标题\r\n\r\n修改后的正文\r\n');
});

test('edits heading text without touching its Markdown marker', () => {
  const source = '# 原标题\n\n正文';
  const result = applyReaderPlainTextEdit(source, 0, { blockStart: 0, replacement: '新标题' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, '# 新标题\n\n正文');
});

test('rejects inline syntax and line breaks until a reversible mapping exists', () => {
  const formatted = applyReaderPlainTextEdit('**加粗**', 0, { blockStart: 0, replacement: '普通' });
  assert.equal(formatted.ok, false);
  const multiline = applyReaderPlainTextEdit('普通', 0, { blockStart: 0, replacement: '第一行\n第二行' });
  assert.equal(multiline.ok, false);
});
