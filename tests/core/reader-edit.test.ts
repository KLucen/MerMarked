import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyReaderMappedTextEdit,
  applyReaderPlainTextEdit,
  resolveReaderInlineFormatSelection,
} from '../../src/core/reader-edit.ts';

test('edits a plain paragraph while preserving BOM and CRLF bytes', () => {
  const source = '\uFEFF# 标题\r\n\r\n原始正文\r\n';
  const blockStart = source.indexOf('原始正文') - 1;
  const result = applyReaderPlainTextEdit(source, 3, { blockStart, sourceText: '原始正文', replacement: '修改后的正文' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, '\uFEFF# 标题\r\n\r\n修改后的正文\r\n');
});

test('edits heading text without touching its Markdown marker', () => {
  const source = '# 原标题\n\n正文';
  const result = applyReaderPlainTextEdit(source, 0, { blockStart: 0, sourceText: '原标题', replacement: '新标题' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, '# 新标题\n\n正文');
});

test('rejects inline syntax and line breaks until a reversible mapping exists', () => {
  const formatted = applyReaderPlainTextEdit('**加粗**', 0, { blockStart: 0, sourceText: '加粗', replacement: '普通' });
  assert.equal(formatted.ok, false);
  const multiline = applyReaderPlainTextEdit('普通', 0, { blockStart: 0, sourceText: '普通', replacement: '第一行\n第二行' });
  assert.equal(multiline.ok, false);
});

test('rejects a stale block identity even when its parser offset still exists', () => {
  const result = applyReaderPlainTextEdit('第一段\n\n第二段', 0, {
    blockStart: 0,
    sourceText: '旧段落',
    replacement: '新的正文',
  });
  assert.equal(result.ok, false);
});

test('edits one exact inline leaf while preserving emphasis and link syntax', () => {
  const bold = applyReaderMappedTextEdit('这是 **重点**。', 0, {
    blockStart: 0,
    sourceText: '这是 重点。',
    replacement: '这是 核心。',
  });
  assert.equal(bold.ok, true);
  if (bold.ok) assert.equal(bold.content, '这是 **核心**。');

  const link = applyReaderMappedTextEdit('[旧文字](https://example.test)', 0, {
    blockStart: 0,
    sourceText: '旧文字',
    replacement: '新文字',
  });
  assert.equal(link.ok, true);
  if (link.ok) assert.equal(link.content, '[新文字](https://example.test)');
});

test('rejects encoded text and edits spanning multiple inline leaves', () => {
  const entity = applyReaderMappedTextEdit('A &amp; B', 0, {
    blockStart: 0,
    sourceText: 'A & B',
    replacement: 'A 和 B',
  });
  assert.equal(entity.ok, false);
  const leaves = applyReaderMappedTextEdit('**粗体** 普通', 0, {
    blockStart: 0,
    sourceText: '粗体 普通',
    replacement: '核心内容',
  });
  assert.equal(leaves.ok, false);
});

test('allows formatting one exact inline leaf and returns source offsets', () => {
  const source = '前 **重点** 与 [链接](https://example.test)。';
  const map = resolveReaderInlineFormatSelection(source, 0, 'bold', {
    blockStart: 0,
    visibleStart: 2,
    visibleEnd: 4,
  });
  assert.equal(map.ok, true);
  if (map.ok) {
    assert.equal(source.slice(map.sourceStart, map.sourceEnd), '重点');
    assert.equal(map.sourceExact, '重点');
  }

  const quote = resolveReaderInlineFormatSelection(source, 0, 'quote', {
    blockStart: 0,
    visibleStart: 0,
    visibleEnd: 1,
  });
  assert.equal(quote.ok, true);
});

test('keeps reader formatting read-only for cross-leaf, encoded, and heading quote selections', () => {
  const crossLeaf = resolveReaderInlineFormatSelection('**粗体** 普通', 0, 'italic', {
    blockStart: 0,
    visibleStart: 0,
    visibleEnd: 5,
  });
  assert.equal(crossLeaf.ok, false);

  const encoded = resolveReaderInlineFormatSelection('A &amp; B', 0, 'bold', {
    blockStart: 0,
    visibleStart: 0,
    visibleEnd: 3,
  });
  assert.equal(encoded.ok, false);

  const headingQuote = resolveReaderInlineFormatSelection('# 标题', 0, 'quote', {
    blockStart: 0,
    visibleStart: 0,
    visibleEnd: 2,
  });
  assert.equal(headingQuote.ok, false);
});
