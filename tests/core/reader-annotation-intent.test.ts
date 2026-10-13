import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSelectionMap, resolveSelection } from '../../src/core/selection-map.ts';
import { resolveReaderAnnotationIntent, type ReaderAnnotationIntent } from '../../src/core/reader-annotation-intent.ts';

function intentFor(content: string, occurrence = 0): ReaderAnnotationIntent {
  const bomByteLength = content.startsWith('\uFEFF') ? 3 : 0;
  const map = buildSelectionMap(content, bomByteLength);
  const block = map.blocks.filter((entry) => entry.kind === 'paragraph')[occurrence];
  const probe = resolveSelection(map, block.blockStart, 0, block.visibleText.length);
  assert.ok(probe.ok);
  return { ...probe, documentKey: 'document-a', contentSnapshot: content, bomByteLength };
}

test('saved BOM/CRLF Chinese and cross-format selection rebuilds exact byte coordinates', () => {
  const content = '\uFEFF# 笔记\r\n\r\n中文 **重点😀** 与[链接](https://example.com)。\r\n';
  const intent = intentFor(content);
  const mapped = resolveReaderAnnotationIntent(intent, 'document-a', content, 3);
  assert.ok(mapped.ok);
  assert.equal(Buffer.from(content).subarray(mapped.startByte, mapped.endByte).toString(), intent.sourceExact);
  assert.equal(mapped.displayQuote, '中文 重点😀 与链接。');
  const decoded = content.slice(1);
  const decodedIntent = { ...intent, contentSnapshot: decoded };
  const afterSave = resolveReaderAnnotationIntent(decodedIntent, 'document-a', decoded, 3);
  assert.ok(afterSave.ok);
  assert.equal(afterSave.startByte, mapped.startByte);
  assert.equal(afterSave.endByte, mapped.endByte);
});

test('document identity and changed source reject even if the same quote remains', () => {
  const content = '# A\n\n重复选文\n\n重复选文\n';
  const intent = intentFor(content, 1);
  assert.equal(resolveReaderAnnotationIntent(intent, 'document-b', content, 0).ok, false);
  for (const next of [content.replace('重复选文\n\n', ''), content + '\n其他文字', content.replace('# A', '# B')]) {
    assert.equal(resolveReaderAnnotationIntent(intent, 'document-a', next, 0).ok, false);
  }
});

test('stale coordinates, changed quotes and invalid BOM cannot produce an annotation', () => {
  const content = '第一段\n\n第二段';
  const intent = intentFor(content);
  for (const stale of [{ ...intent, blockStart: 5 }, { ...intent, visibleEnd: 100 },
    { ...intent, sourceExact: '第二段' }, { ...intent, displayQuote: '另一段' }]) {
    assert.equal(resolveReaderAnnotationIntent(stale, 'document-a', content, 0).ok, false);
  }
  assert.equal(resolveReaderAnnotationIntent(intent, 'document-a', content, 3).ok, false);
});
