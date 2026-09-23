import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  makeAnnotationAnchor, sectionHintForSelection, sectionLocationForSelection,
} from '../../src/core/annotation-anchor.ts';

test('builds a BOM-aware source anchor from an exact selected byte span', () => {
  const content = '# 标题\r\n这里有 **加粗** 和 emoji 😀。\r\n';
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  const sourceExact = '**加粗**';
  const startByte = bytes.indexOf(Buffer.from(sourceExact));
  const anchor = makeAnnotationAnchor(
    content,
    3,
    createHash('sha256').update(bytes).digest('hex'),
    { startByte, endByte: startByte + Buffer.byteLength(sourceExact), sourceExact, displayQuote: '加粗' },
    '标题',
  );

  assert.equal(anchor.startByte, startByte);
  assert.equal(anchor.sourceExact, '**加粗**');
  assert.equal(anchor.displayQuote, '加粗');
  assert.equal(anchor.prefix, '# 标题\r\n这里有 ');
  assert.equal(anchor.suffix, ' 和 emoji 😀。\r\n');
  assert.equal(anchor.sectionHint, '标题');
});

test('rejects stale text and a byte offset inside a multibyte character', () => {
  const content = '中文';
  const hash = 'a'.repeat(64);
  assert.throws(() => makeAnnotationAnchor(content, 0, hash, {
    startByte: 0, endByte: 3, sourceExact: '其他', displayQuote: '中',
  }), /不一致/);
  assert.throws(() => makeAnnotationAnchor(content, 0, hash, {
    startByte: 1, endByte: 3, sourceExact: '中', displayQuote: '中',
  }), /字符边界/);
});

test('derives the deepest containing section from UTF-8 byte offsets', () => {
  const content = '# 父章节\r\n引言\r\n## 子章节\r\n中文 😀 结论\r\n';
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  const startByte = bytes.indexOf(Buffer.from('中文 😀'));
  assert.equal(sectionHintForSelection(content, 3, {
    startByte,
    endByte: startByte + Buffer.byteLength('中文 😀'),
  }), '子章节');
  assert.deepEqual(sectionLocationForSelection(content, 3, {
    startByte,
    endByte: startByte + Buffer.byteLength('中文 😀'),
  }), { index: 1, path: ['父章节', '子章节'] });
});
