import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mapAnnotationSidecarThroughEdit } from '../../src/core/annotation-edit-map.ts';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { previewSectionTransform } from '../../src/core/section-transform.ts';
import type { AnnotationSidecar } from '../../src/core/annotations.ts';

function source(content: string) {
  const bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(content)]);
  return { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('structural spans map moved, intervening, repeated and heading anchors without quote search', async () => {
  const before = source('# A\r\n重复😀。\r\n## B\r\n重复😀。\r\n### C\r\n后代文字。\r\n# D\r\n间隔文字。\r\n');
  const preview = previewSectionTransform(before.content, { kind: 'move', sourceIndex: 1, targetIndex: 3 });
  assert.equal(preview.status, 'ready'); if (preview.status !== 'ready') return;
  const after = source(preview.candidate);
  const needles = ['重复😀', '重复😀', '后代文字', '间隔文字', 'B'];
  const model: AnnotationSidecar = { schemaVersion: 1, source: { sha256: before.sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
    annotations: needles.map((exact, i) => {
      const start = i === 1 ? before.content.lastIndexOf(exact) : before.content.indexOf(exact);
      const startByte = 3 + Buffer.byteLength(before.content.slice(0, start));
      return { id: `a${i}`, kind: 'note', note: `note${i}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
        anchor: makeAnnotationAnchor(before.content, 3, before.sha256, { startByte, endByte: startByte + Buffer.byteLength(exact), sourceExact: exact, displayQuote: exact }) };
    }) };
  const mapped = await mapAnnotationSidecarThroughEdit(model, before, after, '2026-10-01T01:00:00Z', preview);
  assert.equal(mapped.mappedCount, 5); assert.equal(mapped.unresolvedCount, 0);
  assert.notEqual(mapped.model.annotations[0].anchor.startByte, mapped.model.annotations[1].anchor.startByte);
  assert.ok(mapped.model.annotations[1].anchor.startByte > mapped.model.annotations[3].anchor.startByte);
  for (const item of mapped.model.annotations) {
    assert.equal(item.anchor.basisSha256, after.sha256);
    assert.equal(after.bytes.subarray(item.anchor.startByte, item.anchor.endByte).toString(), item.anchor.sourceExact);
  }
  const oldBasis = { ...model, annotations: [{ ...model.annotations[1], anchor: { ...model.annotations[1].anchor, basisSha256: 'f'.repeat(64) } }] };
  const unresolved = await mapAnnotationSidecarThroughEdit(oldBasis, before, after, '2026-10-01T01:00:00Z', preview);
  assert.strictEqual(unresolved.model.annotations[0], oldBasis.annotations[0]);
  await assert.rejects(mapAnnotationSidecarThroughEdit(model, before, source(before.content + 'x'), '2026-10-01T01:00:00Z', preview));
});

test('Setext conversion maps exact body ranges but keeps rewritten heading ranges unresolved', async () => {
  const before = source('# A\r\n## Target\r\n目标正文。\r\n\r\nText\r\n====\r\n末尾😀');
  const preview = previewSectionTransform(before.content, { kind: 'move', sourceIndex: 2, targetIndex: 1 });
  assert.equal(preview.status, 'ready'); if (preview.status !== 'ready') return;
  assert.ok(preview.preservedSpans.every((span) => before.content.slice(span.before.start, span.before.end) === preview.candidate.slice(span.after.start, span.after.end)));
  assert.ok(preview.preservedSpans.some((span) => before.content.slice(span.before.start, span.before.end).includes('末尾😀')));
});
