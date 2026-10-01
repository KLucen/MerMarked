import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import {
  relocateAnnotationAnchor,
  relocateAnnotationSidecarCandidate,
  type AnnotationRelocationSource,
} from '../../src/core/annotation-relocation.ts';
import { parseAnnotationYaml, serializeAnnotationYaml, type AnnotationAnchor, type AnnotationSidecar } from '../../src/core/annotations.ts';

function source(content: string, bom = false): AnnotationRelocationSource {
  const bytes = bom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')])
    : Buffer.from(content, 'utf8');
  return {
    bytes,
    content,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function anchorFor(
  current: AnnotationRelocationSource,
  exact: string,
  displayQuote = exact,
  sectionHint = '',
): AnnotationAnchor {
  const start = current.content.indexOf(exact);
  assert.notEqual(start, -1);
  const bomByteLength = current.bytes[0] === 0xef ? 3 : 0;
  const startByte = bomByteLength + Buffer.byteLength(current.content.slice(0, start));
  return makeAnnotationAnchor(current.content, bomByteLength, current.sha256, {
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    displayQuote,
  }, sectionHint);
}

test('keeps a verified anchor unchanged when the complete source digest is unchanged', async () => {
  const current = source('# 标题\r\n中文 😀 结论。\r\n', true);
  const anchor = anchorFor(current, '中文 😀', '中文 😀', '标题');

  const result = await relocateAnnotationAnchor(anchor, current);
  assert.equal(result.status, 'unchanged');
  assert.strictEqual(result.anchor, anchor);
});

test('relocates one exact high-confidence candidate with BOM, CRLF, Chinese, and emoji byte offsets', async () => {
  const stablePrefix = '前文'.repeat(30);
  const oldSource = source(`# 标题\r\n${stablePrefix}目标 😀 后文内容保持不变。\r\n`, true);
  const anchor = anchorFor(oldSource, '目标 😀', '目标 😀', '标题');
  const current = source(`新增说明\r\n# 标题\r\n${stablePrefix}目标 😀 后文内容保持不变。\r\n`, true);

  const result = await relocateAnnotationAnchor(anchor, current);
  assert.equal(result.status, 'relocated');
  if (result.status !== 'relocated') return;
  const expectedStart = current.bytes.indexOf(Buffer.from('目标 😀'));
  assert.equal(result.anchor.startByte, expectedStart);
  assert.equal(result.anchor.endByte, expectedStart + Buffer.byteLength('目标 😀'));
  assert.equal(Buffer.from(current.bytes).subarray(result.anchor.startByte, result.anchor.endByte).toString('utf8'), '目标 😀');
  assert.equal(result.anchor.basisSha256, current.sha256);
  assert.equal(result.anchor.displayQuote, '目标 😀');
  assert.equal(result.anchor.sectionHint, '标题');
  assert.equal(Array.from(result.anchor.prefix).length, 48);
});

test('rejects one-sided context even under the same section and never guesses from the old offset', async () => {
  const oldSource = source('# 章节\n前缀文字 目标文本 后缀文字\n');
  const anchor = anchorFor(oldSource, '目标文本', '目标文本', '章节');
  const current = source('# 章节\n前缀文字 新插入 目标文本 后缀文字\n');

  const result = await relocateAnnotationAnchor(anchor, current);
  assert.deepEqual(result, { status: 'unresolved', anchor, reason: 'context-mismatch' });
});

test('updates a section hint after a uniquely matched paragraph moves with both contexts intact', async () => {
  const before = '左'.repeat(60);
  const after = '右'.repeat(60);
  const paragraph = `${before}独特结论${after}\n`;
  const oldSource = source(`# 旧章节\n${paragraph}# 新章节\n其他\n`);
  const anchor = anchorFor(oldSource, '独特结论', '独特结论', '旧章节');
  const current = source(`# 旧章节\n其他\n# 新章节\n${paragraph}`);

  const result = await relocateAnnotationAnchor(anchor, current);
  assert.equal(result.status, 'relocated');
  if (result.status === 'relocated') assert.equal(result.anchor.sectionHint, '新章节');
});

test('leaves deleted, repeated, and context-free candidates unresolved', async () => {
  const oldSource = source('# A\n左侧上下文 目标 右侧上下文\n');
  const anchor = anchorFor(oldSource, '目标', '目标', 'A');

  const deleted = await relocateAnnotationAnchor(anchor, source('# A\n左侧上下文 已删除 右侧上下文\n'));
  assert.deepEqual(deleted, { status: 'unresolved', anchor, reason: 'source-exact-missing' });

  const repeated = await relocateAnnotationAnchor(
    anchor,
    source('# A\n左侧上下文 目标 右侧上下文\n复制的目标\n'),
  );
  assert.deepEqual(repeated, { status: 'unresolved', anchor, reason: 'source-exact-repeated' });

  const unrelated = await relocateAnnotationAnchor(anchor, source('# B\n完全不同但含有目标的段落\n'));
  assert.deepEqual(unrelated, { status: 'unresolved', anchor, reason: 'context-mismatch' });
});

test('does not repair an invalid byte range when its basis already claims the current digest', async () => {
  const current = source('中文目标\n');
  const valid = anchorFor(current, '目标');
  const anchor = { ...valid, startByte: valid.startByte - 1, endByte: valid.endByte - 1 };

  assert.deepEqual(await relocateAnnotationAnchor(anchor, current), {
    status: 'unresolved', anchor, reason: 'current-range-mismatch',
  });
});

test('a current-basis anchor is resolved only when its visible quote also roundtrips', async () => {
  const current = source('# 标题\n正文目标\n');
  const valid = anchorFor(current, '目标', '目标', '标题');
  const brokenQuote = { ...valid, displayQuote: '别处' };

  assert.deepEqual(await relocateAnnotationAnchor(brokenQuote, current), {
    status: 'unresolved', anchor: brokenQuote, reason: 'rendered-range-unresolved',
  });
});

test('rejects an otherwise exact candidate that moved into a non-rendered Markdown region', async () => {
  const left = '左侧'.repeat(30);
  const right = '右侧'.repeat(30);
  const oldSource = source(`# A\n${left}独特结论${right}\n`);
  const anchor = anchorFor(oldSource, '独特结论', '独特结论', 'A');
  const fenced = source(`# A\n\`\`\`text\n${left}独特结论${right}\n\`\`\`\n`);

  assert.deepEqual(await relocateAnnotationAnchor(anchor, fenced), {
    status: 'unresolved', anchor, reason: 'rendered-range-unresolved',
  });
});

test('rejects inconsistent UTF-8 text views and caller-provided hashes', async () => {
  const current = source('正文');
  const anchor = anchorFor(current, '正文');
  await assert.rejects(
    relocateAnnotationAnchor(anchor, { ...current, content: '其他' }),
    /字节与文本视图不一致/,
  );
  await assert.rejects(
    relocateAnnotationAnchor(anchor, { ...current, sha256: '0'.repeat(64) }),
    /摘要与字节不一致/,
  );
});

function record(id: string, anchor: AnnotationAnchor, updatedAt: string, note = `便签 ${id}`) {
  return {
    id,
    kind: 'note' as const,
    color: 'amber' as const,
    anchor,
    note,
    tagId: 'tag-1',
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt,
  };
}

test('builds a mixed-basis sidecar candidate and updates only successfully relocated records', async () => {
  const stableLeftContext = '左侧内容'.repeat(20);
  const stableRightContext = '右侧内容'.repeat(20);
  const oldSource = source(`# A\n${stableLeftContext} 唯一甲 ${stableRightContext}\n删除项 唯一乙 尾部\n`);
  const current = source(`新增\n# A\n${stableLeftContext} 唯一甲 ${stableRightContext}\n删除项已消失\n当前锚点\n`);
  const currentAnchor = anchorFor(current, '当前锚点', '当前锚点', 'A');
  const oldA = anchorFor(oldSource, '唯一甲', '唯一甲', 'A');
  const oldB = anchorFor(oldSource, '唯一乙', '唯一乙', 'A');
  const sidecar: AnnotationSidecar = {
    schemaVersion: 1,
    source: { sha256: oldSource.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [{ id: 'tag-1', name: '疑问' }],
    annotations: [
      record('a', oldA, '2026-09-21T00:00:00Z'),
      record('b', oldB, '2026-09-21T01:00:00Z'),
      record('c', currentAnchor, '2026-09-21T02:00:00Z'),
    ],
  };

  const result = await relocateAnnotationSidecarCandidate(sidecar, current, '2026-09-23T08:00:00Z');
  assert.equal(result.changed, true);
  assert.equal(result.relocatedCount, 1);
  assert.equal(result.unresolvedCount, 1);
  assert.deepEqual(result.items, [
    { id: 'a', status: 'relocated' },
    { id: 'b', status: 'unresolved', reason: 'source-exact-missing' },
    { id: 'c', status: 'unchanged' },
  ]);
  assert.equal(result.model.source.sha256, current.sha256);
  assert.deepEqual(result.model.tags, sidecar.tags);
  assert.deepEqual(result.model.annotations.map((item) => item.id), ['a', 'b', 'c']);

  const relocated = result.model.annotations[0];
  assert.equal(relocated.anchor.basisSha256, current.sha256);
  assert.equal(relocated.updatedAt, '2026-09-23T08:00:00Z');
  assert.equal(relocated.note, '便签 a');
  assert.equal(relocated.tagId, 'tag-1');
  assert.equal(relocated.color, 'amber');
  assert.equal(relocated.createdAt, '2026-09-20T00:00:00Z');

  assert.strictEqual(result.model.annotations[1], sidecar.annotations[1]);
  assert.equal(result.model.annotations[1].anchor.basisSha256, oldSource.sha256);
  assert.equal(result.model.annotations[1].updatedAt, '2026-09-21T01:00:00Z');
  assert.strictEqual(result.model.annotations[2], sidecar.annotations[2]);
  assert.equal(result.model.annotations[2].updatedAt, '2026-09-21T02:00:00Z');

  const roundtrip = parseAnnotationYaml(serializeAnnotationYaml(result.model));
  assert.equal(roundtrip.source.sha256, current.sha256);
  assert.equal(roundtrip.annotations[0].anchor.basisSha256, current.sha256);
  assert.equal(roundtrip.annotations[1].anchor.basisSha256, oldSource.sha256);
});

test('updates the checked source hash even when no stale anchor can be relocated', async () => {
  const oldSource = source('前缀 目标 后缀');
  const current = source('目标 已被复制，另一个目标');
  const anchor = anchorFor(oldSource, '目标');
  const sidecar: AnnotationSidecar = {
    schemaVersion: 1,
    source: { sha256: oldSource.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [{
      id: 'highlight-1', kind: 'highlight', color: 'blue', anchor,
      createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
    }],
  };

  const result = await relocateAnnotationSidecarCandidate(sidecar, current, '2026-09-23T08:00:00Z');
  assert.equal(result.changed, true);
  assert.equal(result.relocatedCount, 0);
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.model.source.sha256, current.sha256);
  assert.strictEqual(result.model.annotations[0], sidecar.annotations[0]);
  assert.equal(result.model.annotations[0].anchor.basisSha256, oldSource.sha256);

  const repeated = await relocateAnnotationSidecarCandidate(result.model, current, '2026-09-23T09:00:00Z');
  assert.equal(repeated.changed, false);
  assert.strictEqual(repeated.model, result.model);
  assert.equal(repeated.items[0].status, 'unresolved');
});

test('rejects every new relocation that collides with another record at the current range', async () => {
  const left = '左'.repeat(60);
  const right = '右'.repeat(60);
  const oldSource = source(`# A\n${left}唯一目标${right}\n`);
  const current = source(`新增前言\n# A\n${left}唯一目标${right}\n`);
  const oldAnchor = anchorFor(oldSource, '唯一目标', '唯一目标', 'A');
  const currentAnchor = anchorFor(current, '唯一目标', '唯一目标', 'A');
  const sidecar: AnnotationSidecar = {
    schemaVersion: 1,
    source: { sha256: oldSource.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [
      {
        id: 'old-1', kind: 'highlight', color: 'amber', anchor: oldAnchor,
        createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
      },
      {
        id: 'old-2', kind: 'note', anchor: oldAnchor, note: '保留这条便签',
        createdAt: '2026-09-20T01:00:00Z', updatedAt: '2026-09-20T01:00:00Z',
      },
      {
        id: 'current-1', kind: 'highlight', color: 'blue', anchor: currentAnchor,
        createdAt: '2026-09-20T02:00:00Z', updatedAt: '2026-09-20T02:00:00Z',
      },
    ],
  };

  const result = await relocateAnnotationSidecarCandidate(sidecar, current, '2026-09-23T08:00:00Z');
  assert.equal(result.relocatedCount, 0);
  assert.equal(result.unresolvedCount, 2);
  assert.deepEqual(result.items, [
    { id: 'old-1', status: 'unresolved', reason: 'target-range-collision' },
    { id: 'old-2', status: 'unresolved', reason: 'target-range-collision' },
    { id: 'current-1', status: 'unchanged' },
  ]);
  assert.strictEqual(result.model.annotations[0], sidecar.annotations[0]);
  assert.strictEqual(result.model.annotations[1], sidecar.annotations[1]);
  assert.strictEqual(result.model.annotations[2], sidecar.annotations[2]);
  assert.equal(result.model.annotations[0].anchor.basisSha256, oldSource.sha256);
  assert.equal(result.model.annotations[1].anchor.basisSha256, oldSource.sha256);
});

test('rejects two stale records that independently converge on the same new range', async () => {
  const left = '稳定左文'.repeat(20);
  const right = '稳定右文'.repeat(20);
  const oldSource = source(`# A\n${left}同一选区${right}\n`);
  const current = source(`文档前言\n# A\n${left}同一选区${right}\n`);
  const oldAnchor = anchorFor(oldSource, '同一选区', '同一选区', 'A');
  const sidecar: AnnotationSidecar = {
    schemaVersion: 1,
    source: { sha256: oldSource.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [
      {
        id: 'stale-1', kind: 'highlight', color: 'rose', anchor: oldAnchor,
        createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
      },
      {
        id: 'stale-2', kind: 'note', anchor: oldAnchor, note: '另一条记录',
        createdAt: '2026-09-20T01:00:00Z', updatedAt: '2026-09-20T01:00:00Z',
      },
    ],
  };

  const result = await relocateAnnotationSidecarCandidate(sidecar, current, '2026-09-23T08:00:00Z');
  assert.equal(result.relocatedCount, 0);
  assert.equal(result.unresolvedCount, 2);
  assert.deepEqual(result.items.map((item) => item.status === 'unresolved' ? item.reason : item.status), [
    'target-range-collision', 'target-range-collision',
  ]);
  assert.deepEqual(result.model.annotations, sidecar.annotations);
});
