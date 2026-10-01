import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { mapAnnotationSidecarThroughEdit } from '../../src/core/annotation-edit-map.ts';
import type { AnnotationRelocationSource } from '../../src/core/annotation-relocation.ts';
import type { AnnotationAnchor, AnnotationSidecar } from '../../src/core/annotations.ts';

function source(content: string, bom = false): AnnotationRelocationSource {
  const bytes = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')])
    : Buffer.from(content, 'utf8');
  return { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function anchorFor(current: AnnotationRelocationSource, exact: string, occurrence = 0): AnnotationAnchor {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    start = current.content.indexOf(exact, from);
    assert.notEqual(start, -1);
    from = start + exact.length;
  }
  const bomByteLength = current.bytes[0] === 0xef ? 3 : 0;
  const startByte = bomByteLength + Buffer.byteLength(current.content.slice(0, start));
  return makeAnnotationAnchor(current.content, bomByteLength, current.sha256, {
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    displayQuote: exact,
  }, '章节');
}

function record(id: string, anchor: AnnotationAnchor) {
  return {
    id,
    kind: 'highlight' as const,
    color: 'amber' as const,
    anchor,
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
  };
}

function sidecar(current: AnnotationRelocationSource, anchors: readonly [string, AnnotationAnchor][]): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: current.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: anchors.map(([id, anchor]) => record(id, anchor)),
  };
}

test('maps repeated anchors outside one edit without searching by quote', async () => {
  const before = source('# 章节\r\n重复文字。\r\n中间内容。\r\n重复文字。\r\n', true);
  const after = source('# 章节\r\n新增说明。\r\n重复文字。\r\n中间内容。\r\n重复文字。\r\n', true);
  const first = anchorFor(before, '重复文字', 0);
  const second = anchorFor(before, '重复文字', 1);

  const result = await mapAnnotationSidecarThroughEdit(
    sidecar(before, [['first', first], ['second', second]]),
    before,
    after,
    '2026-09-29T01:00:00Z',
  );

  assert.equal(result.mappedCount, 2);
  assert.equal(result.unresolvedCount, 0);
  assert.deepEqual(result.items.map((item) => item.status), ['mapped', 'mapped']);
  assert.equal(result.model.source.sha256, after.sha256);
  assert.equal(result.model.annotations[0].anchor.startByte, after.bytes.indexOf(Buffer.from('重复文字')));
  assert.equal(result.model.annotations[1].anchor.startByte, after.bytes.lastIndexOf(Buffer.from('重复文字')));
  assert.ok(result.model.annotations.every((item) => item.anchor.basisSha256 === after.sha256));
});

test('keeps an intersecting anchor on its old basis while mapping unaffected neighbours', async () => {
  const before = source('# 章节\n前方锚点。\n需要修改的锚点。\n后方锚点。\n');
  const after = source('# 章节\n前方锚点。\n已经改写。\n后方锚点。\n');
  const model = sidecar(before, [
    ['before', anchorFor(before, '前方锚点')],
    ['inside', anchorFor(before, '需要修改的锚点')],
    ['after', anchorFor(before, '后方锚点')],
  ]);

  const result = await mapAnnotationSidecarThroughEdit(model, before, after, '2026-09-29T01:00:00Z');

  assert.equal(result.mappedCount, 2);
  assert.equal(result.unresolvedCount, 1);
  assert.deepEqual(result.items, [
    { id: 'before', status: 'mapped' },
    { id: 'inside', status: 'unresolved', reason: 'edit-overlap' },
    { id: 'after', status: 'mapped' },
  ]);
  assert.equal(result.model.annotations[1].anchor.basisSha256, before.sha256);
  assert.strictEqual(result.model.annotations[1], model.annotations[1]);
  assert.equal(result.model.annotations[2].anchor.startByte, after.bytes.indexOf(Buffer.from('后方锚点')));
});

test('treats insertion boundaries deterministically and preserves Unicode byte boundaries', async () => {
  const before = source('# 章节\r\n甲😀乙\r\n', true);
  const after = source('# 章节\r\n新增😀\r\n甲😀乙\r\n', true);
  const target = anchorFor(before, '甲😀乙');
  const result = await mapAnnotationSidecarThroughEdit(
    sidecar(before, [['unicode', target]]), before, after, '2026-09-29T01:00:00Z',
  );

  assert.equal(result.items[0].status, 'mapped');
  const mapped = result.model.annotations[0].anchor;
  assert.equal(mapped.startByte, after.bytes.indexOf(Buffer.from('甲😀乙')));
  assert.equal(Buffer.from(after.bytes).subarray(mapped.startByte, mapped.endByte).toString('utf8'), '甲😀乙');
  assert.ok(result.patch.beforeStartByte <= result.patch.beforeEndByte);
});

test('treats an insertion at start as preceding the anchor and one at end as following it', async () => {
  const original = source('# 章节\n甲目标乙\n');
  const target = anchorFor(original, '目标');

  const beforeStart = source('# 章节\n甲新增目标乙\n');
  const shifted = await mapAnnotationSidecarThroughEdit(
    sidecar(original, [['start', target]]), original, beforeStart, '2026-09-29T01:00:00Z',
  );
  assert.equal(shifted.items[0].status, 'mapped');
  assert.equal(shifted.model.annotations[0].anchor.startByte, beforeStart.bytes.indexOf(Buffer.from('目标')));

  const afterEnd = source('# 章节\n甲目标新增乙\n');
  const unchangedRange = await mapAnnotationSidecarThroughEdit(
    sidecar(original, [['end', target]]), original, afterEnd, '2026-09-29T01:00:00Z',
  );
  assert.equal(unchangedRange.items[0].status, 'mapped');
  assert.equal(unchangedRange.model.annotations[0].anchor.startByte, target.startByte);
  assert.equal(unchangedRange.model.annotations[0].anchor.endByte, target.endByte);
});

test('rebuilds context and section hint for an anchor outside the edit', async () => {
  const before = source('# 旧标题\n前文。\n目标文字。\n');
  const after = source('# 新标题更长\n前文。\n目标文字。\n');
  const target = anchorFor(before, '目标文字');

  const result = await mapAnnotationSidecarThroughEdit(
    sidecar(before, [['context', target]]), before, after, '2026-09-29T01:00:00Z',
  );

  assert.equal(result.items[0].status, 'mapped');
  const mapped = result.model.annotations[0].anchor;
  assert.equal(mapped.sectionHint, '新标题更长');
  assert.ok(mapped.prefix.includes('新标题更长'));
  assert.equal(mapped.suffix, '。\n');
});

test('rejects a preserved source range that no longer appears in the reading result', async () => {
  const before = source('# 章节\n目标文字\n');
  const after = source('# 章节\n<!--目标文字\n');
  const target = anchorFor(before, '目标文字');
  const model = sidecar(before, [['hidden', target]]);

  const result = await mapAnnotationSidecarThroughEdit(
    model, before, after, '2026-09-29T01:00:00Z',
  );

  assert.deepEqual(result.items, [
    { id: 'hidden', status: 'unresolved', reason: 'rendered-range-unresolved' },
  ]);
  assert.strictEqual(result.model.annotations[0], model.annotations[0]);
});

test('returns the original sidecar for a no-op source transition', async () => {
  const current = source('# 章节\n目标文字\n');
  const model = sidecar(current, [['same', anchorFor(current, '目标文字')]]);

  const result = await mapAnnotationSidecarThroughEdit(
    model, current, current, '2026-09-29T01:00:00Z',
  );

  assert.equal(result.changed, false);
  assert.equal(result.mappedCount, 0);
  assert.equal(result.unresolvedCount, 0);
  assert.strictEqual(result.model, model);
  assert.deepEqual(result.items, [{ id: 'same', status: 'unchanged' }]);
});

test('does not adopt an anchor from an unrelated older basis', async () => {
  const older = source('# 章节\n旧文字。\n');
  const before = source('# 章节\n当前文字。\n');
  const after = source('# 章节\n新增。\n当前文字。\n');
  const oldAnchor = anchorFor(older, '旧文字');
  const model = sidecar(before, [['old', oldAnchor]]);

  const result = await mapAnnotationSidecarThroughEdit(model, before, after, '2026-09-29T01:00:00Z');
  assert.deepEqual(result.items, [{ id: 'old', status: 'unresolved', reason: 'basis-mismatch' }]);
  assert.equal(result.model.annotations[0].anchor.basisSha256, older.sha256);
  assert.equal(result.model.source.sha256, after.sha256);
});

test('expands a repeated deletion across every equally minimal alignment', async () => {
  const repeated = '左 TARGET 右\n';
  const before = source(`# 章节\n开头锚点\n${repeated}${repeated}结尾锚点\n`);
  const after = source(`# 章节\n开头锚点\n${repeated}结尾锚点\n`);
  const model = sidecar(before, [
    ['head', anchorFor(before, '开头锚点')],
    ['first', anchorFor(before, 'TARGET', 0)],
    ['second', anchorFor(before, 'TARGET', 1)],
    ['tail', anchorFor(before, '结尾锚点')],
  ]);

  const result = await mapAnnotationSidecarThroughEdit(model, before, after, '2026-09-29T01:00:00Z');
  assert.deepEqual(result.items, [
    { id: 'head', status: 'mapped' },
    { id: 'first', status: 'unresolved', reason: 'edit-overlap' },
    { id: 'second', status: 'unresolved', reason: 'edit-overlap' },
    { id: 'tail', status: 'mapped' },
  ]);
  assert.equal(result.model.annotations[3].anchor.startByte, after.bytes.indexOf(Buffer.from('结尾锚点')));
});

test('rejects inconsistent source views and an older mapping timestamp', async () => {
  const before = source('# 章节\n锚点\n');
  const after = source('# 章节\n新增\n锚点\n');
  const model = sidecar(before, [['a', anchorFor(before, '锚点')]]);
  model.annotations[0] = { ...model.annotations[0], updatedAt: '2026-09-29T02:00:00Z' };

  await assert.rejects(
    mapAnnotationSidecarThroughEdit(model, { ...before, content: '不一致' }, after, '2026-09-29T03:00:00Z'),
    /字节与文本视图不一致/,
  );
  await assert.rejects(
    mapAnnotationSidecarThroughEdit(model, before, after, '2026-09-29T01:00:00Z'),
    /早于批注现有更新时间/,
  );
  await assert.rejects(
    mapAnnotationSidecarThroughEdit(
      { ...model, source: { ...model.source, sha256: after.sha256 } },
      before,
      after,
      '2026-09-29T03:00:00Z',
    ),
    /未绑定保存前的 Markdown/,
  );
});
