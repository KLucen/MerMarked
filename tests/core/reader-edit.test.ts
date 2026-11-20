import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSelectionMap } from '../../src/core/selection-map.ts';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../../src/core/markdown-source.ts';
import {
  applyReaderMappedTextEdit,
  applyReaderPlainTextEdit,
  escapeReaderPlainText,
  isReaderPlainTextPaste,
  resolveReaderMappedSelection,
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

test('decoded BOM metadata supports reading edits without inserting a second BOM', () => {
  const bytes = Buffer.from('\uFEFF# 标题\r\n\r\n中文 😀 正文\r\n');
  const { content, format } = decodeMarkdownBytes(bytes);
  const block = buildSelectionMap(content, format.bomByteLength).blocks.find(item => item.kind === 'paragraph')!;
  for (const edit of [applyReaderPlainTextEdit, applyReaderMappedTextEdit]) {
    const result = edit(content, format.bomByteLength, {
      blockStart: block.blockStart, sourceText: block.visibleText, replacement: '中文 😀 修改',
    });
    assert.ok(result.ok);
    assert.equal(result.content.startsWith('\uFEFF'), false);
    assert.deepEqual(Buffer.from(encodeMarkdownBytes(result.content, format.bomByteLength)),
      Buffer.from('\uFEFF# 标题\r\n\r\n中文 😀 修改\r\n'));
  }
  const selection = resolveReaderMappedSelection(content, format.bomByteLength,
    { blockStart: block.blockStart, visibleStart: 0, visibleEnd: 2 });
  assert.ok(selection.ok);
  assert.equal(selection.sourceExact, '中文');
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

test('supports consecutive reader edits against the current unsaved buffer', () => {
  const first = applyReaderMappedTextEdit('第一段\n\n第二段', 0, {
    blockStart: 0,
    sourceText: '第一段',
    replacement: '更新一',
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The second command receives the rendered text and source map rebuilt from
  // the dirty buffer. It must not require the persisted document to be saved.
  const secondBlockStart = first.content.indexOf('第二段');
  const second = applyReaderMappedTextEdit(first.content, 0, {
    blockStart: secondBlockStart,
    sourceText: '第二段',
    replacement: '更新二',
  });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.content, '更新一\n\n更新二');
});

test('maps insertion next to complete graphemes without changing BOM, CRLF or surrounding bytes', () => {
  for (const grapheme of ['😀', 'e\u0301', '👩‍💻', '👍🏽', '🇨🇳']) {
    for (const placement of ['prepend', 'append'] as const) {
      const before = grapheme;
      const after = placement === 'prepend' ? '新' + before : before + '新';
      const original = Buffer.from(`\uFEFF# ${before}\r\n\r\n保持 **格式** 与 [链接](https://example.test)`);
      const { content, format } = decodeMarkdownBytes(original);
      const result = applyReaderMappedTextEdit(content, format.bomByteLength,
        { blockStart: 0, sourceText: before, replacement: after });
      assert.ok(result.ok, `${placement} ${grapheme}`);
      const insertion = 2 + (placement === 'prepend' ? 0 : before.length);
      assert.equal(result.sourceStart, insertion);
      assert.equal(result.sourceEnd, insertion);
      assert.equal(result.sourceExact, '');
      assert.deepEqual(Buffer.from(encodeMarkdownBytes(result.content, format.bomByteLength)),
        Buffer.from(`\uFEFF# ${after}\r\n\r\n保持 **格式** 与 [链接](https://example.test)`));
      assert.deepEqual(original, Buffer.from(`\uFEFF# ${before}\r\n\r\n保持 **格式** 与 [链接](https://example.test)`));
    }
  }
});

test('replaces whole graphemes even when old and new text share surrogate or combining units', () => {
  for (const [before, after] of [
    ['😀', '😃'], // shared high surrogate
    ['😀', '🈀'], // shared low surrogate
    ['e\u0301', 'e\u0300'],
    ['e\u0301', 'a\u0301'], // shared combining suffix is inside both graphemes
    ['👩‍💻', '👩‍🔬'],
    ['👩‍💻', '👨‍💻'], // shared ZWJ suffix is inside both graphemes
    ['👍🏽', '👍🏻'],
    ['🇨🇳', '🇨🇦'],
  ]) {
    const source = `## 前${before}后\n\n保留正文`;
    const result = applyReaderMappedTextEdit(source, 0,
      { blockStart: 0, sourceText: `前${before}后`, replacement: `前${after}后` });
    assert.ok(result.ok, `${before} → ${after}`);
    assert.equal(result.content, `## 前${after}后\n\n保留正文`);
    assert.equal(result.sourceStart, 4);
    assert.equal(result.sourceEnd, 4 + before.length);
    assert.equal(result.sourceExact, before);
  }
});

test('expands the edit when inserted text changes grapheme boundaries on the new side', () => {
  for (const [before, after] of [
    ['e', 'e\u0301'], ['👩', '👩‍💻'], ['🇨', '🇨🇳'], ['👍', '👍🏽'],
    ['🇨🇳', '🇦🇨🇳'], ['🇦🇨🇳', '🇨🇳'], // a regional indicator shifts the suffix's pairing
  ]) {
    const result = applyReaderMappedTextEdit(`前${before}后`, 0,
      { blockStart: 0, sourceText: `前${before}后`, replacement: `前${after}后` });
    assert.ok(result.ok, `${before} → ${after}`);
    assert.equal(result.content, `前${after}后`);
    assert.equal(result.sourceStart, 1);
    assert.equal(result.sourceEnd, 1 + before.length);
    assert.equal(result.sourceExact, before, 'Replace the old grapheme; do not insert inside the new one');
  }
});

test('deletes a complete grapheme and preserves exact inline leaf syntax', () => {
  for (const grapheme of ['😀', 'e\u0301', '👩‍💻', '👍🏽', '🇨🇳']) {
    const removed = applyReaderMappedTextEdit(`前${grapheme}后`, 0,
      { blockStart: 0, sourceText: `前${grapheme}后`, replacement: '前后' });
    assert.ok(removed.ok);
    assert.equal(removed.content, '前后');
    assert.equal(removed.sourceExact, grapheme);
    for (const [source, expected] of [
      [`**${grapheme}**`, `**${grapheme}新**`],
      [`[${grapheme}](https://example.test)`, `[${grapheme}新](https://example.test)`],
    ]) {
      const appended = applyReaderMappedTextEdit(source, 0,
        { blockStart: 0, sourceText: grapheme, replacement: grapheme + '新' });
      assert.ok(appended.ok);
      assert.equal(appended.content, expected);
      assert.equal(appended.sourceExact, '');
      assert.equal(appended.sourceStart, source.indexOf(grapheme) + grapheme.length);
      assert.equal(appended.sourceEnd, appended.sourceStart);
    }
  }
});

test('rejects grapheme expansion across exact Markdown leaves or encoded text', () => {
  for (const [source, replacement] of [
    ['**e**\u0301', 'e\u0300'],
    ['**👩**‍💻', '👩‍🔬'],
    ['**🇨**🇳', '🇨🇦'],
    ['**😀** 😃', '😄 😅'],
    ['&#x1f600;', '😀新'],
  ]) {
    const block = buildSelectionMap(source, 0).blocks[0];
    const result = applyReaderMappedTextEdit(source, 0,
      { blockStart: block.blockStart, sourceText: block.visibleText, replacement });
    assert.equal(result.ok, false, source);
  }
});

test('rejects unpaired surrogate input instead of publishing replacement bytes', () => {
  for (const replacement of ['\ud83d', '\ude00', '前\ud83d后', '😀\ude00', '\ud83d\ud83d\ude00']) {
    const result = applyReaderMappedTextEdit('# 正文', 0, { blockStart: 0, sourceText: '正文', replacement });
    assert.equal(result.ok, false);
  }
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

test('maps a BOM and CRLF inline leaf without crossing neighboring leaves', () => {
  const source = '\uFEFF# 标题\r\n\r\n这是 **重点** 与 [链接](https://example.test)。\r\n';
  const blockStart = source.slice(1).indexOf('这是');
  const mapped = resolveReaderMappedSelection(source, 3, {
    blockStart,
    visibleStart: 3,
    visibleEnd: 5,
  });
  assert.equal(mapped.ok, true);
  if (mapped.ok) {
    assert.equal(mapped.sourceExact, '重点');
    assert.equal(source.slice(1 + mapped.sourceStart, 1 + mapped.sourceEnd), '重点');
  }
  const crossLeaf = resolveReaderMappedSelection(source, 3, {
    blockStart,
    visibleStart: 0,
    visibleEnd: 5,
  });
  assert.equal(crossLeaf.ok, false);
});

test('escapes reader paste markers while preserving the visible plain text', () => {
  const plainText = '**加粗** &copy; [链接](url)';
  const escaped = escapeReaderPlainText(plainText);
  assert.equal(escaped, '\\*\\*加粗\\*\\* \\&copy; \\[链接\\](url)');
  assert.equal(buildSelectionMap(escaped, 0).blocks[0]?.visibleText, plainText);
  const angleText = '<http://a>';
  const escapedAngleText = escapeReaderPlainText(angleText);
  assert.equal(buildSelectionMap(escapedAngleText, 0).blocks[0]?.visibleText, angleText);
  assert.equal(escapeReaderPlainText('# 标题'), '\\# 标题');
  assert.equal(escapeReaderPlainText('1. 项目'), '1\\. 项目');
  assert.equal(escapeReaderPlainText('- 项目'), '\\- 项目');
  assert.equal(escapeReaderPlainText('---'), '\\---');

  const pasted = applyReaderMappedTextEdit('旧文本', 0, {
    blockStart: 0,
    sourceText: '旧文本',
    replacement: escapeReaderPlainText('**加粗**'),
  });
  assert.equal(pasted.ok, true);
  if (pasted.ok) assert.equal(pasted.content, '\\*\\*加粗\\*\\*');
  assert.equal(isReaderPlainTextPaste('普通文本'), true);
  assert.equal(isReaderPlainTextPaste(''), false);
  assert.equal(isReaderPlainTextPaste('第一行\n第二行'), false);
  assert.equal(isReaderPlainTextPaste('  开头空格'), false);
  assert.equal(isReaderPlainTextPaste('\t缩进'), false);
});
