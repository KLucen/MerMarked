import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationAnchor, AnnotationSidecar } from '../../src/core/annotations.ts';
import {
  createHighlightCandidate,
  deleteHighlightCandidate,
  recolorHighlightCandidate,
} from '../../src/main/highlight-mutations.ts';

const sha = 'a'.repeat(64);
const time = '2026-09-18T00:00:00Z';
const later = '2026-09-18T00:01:00Z';

function anchor(startByte: number, exact: string): AnnotationAnchor {
  return {
    basisSha256: sha,
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    prefix: '',
    suffix: '',
    displayQuote: exact,
  };
}

function sidecar(): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: sha, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [{ id: 'tag-1', name: '检查' }],
    annotations: [
      { id: 'h1', kind: 'highlight', color: 'amber', anchor: anchor(1, '甲'), createdAt: time, updatedAt: time },
      { id: 'n1', kind: 'note', color: 'blue', anchor: anchor(4, '乙'), note: '保留正文', tagId: 'tag-1', createdAt: time, updatedAt: time },
      { id: 'h2', kind: 'highlight', color: 'rose', anchor: anchor(7, '丙'), createdAt: time, updatedAt: time },
    ],
  };
}

test('create appends a stable highlight while preserving existing note, tag and order', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = createHighlightCandidate(original, anchor(10, '丁'), 'sage', 'h3', later);
  assert.equal(result.changed, true);
  assert.deepEqual(result.model.annotations.map((item) => item.id), ['h1', 'n1', 'h2', 'h3']);
  assert.deepEqual(result.model.annotations.slice(0, 3), snapshot.annotations);
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
  assert.equal(result.model.annotations[3].color, 'sage');
  assert.throws(() => createHighlightCandidate(original, anchor(1, '甲'), 'blue', 'h3', later), /已有高亮或便签/);
  assert.throws(() => createHighlightCandidate(original, anchor(4, '乙'), 'blue', 'h3', later), /已有高亮或便签/);
});

test('recolor updates only one highlight and same color leaves YAML model untouched', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = recolorHighlightCandidate(original, 'h1', 'blue', later);
  assert.deepEqual(result.model.annotations.map((item) => item.id), ['h1', 'n1', 'h2']);
  assert.deepEqual(result.model.annotations[0], { ...snapshot.annotations[0], color: 'blue', updatedAt: later });
  assert.deepEqual(result.model.annotations.slice(1), snapshot.annotations.slice(1));
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
  const noop = recolorHighlightCandidate(result.model, 'h1', 'blue', later);
  assert.equal(noop.changed, false);
  assert.equal(noop.model, result.model);
  assert.throws(() => recolorHighlightCandidate(original, 'n1', 'rose', later), /不存在或已变为便签/);
});

test('delete removes only the selected highlight and cannot delete a note', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = deleteHighlightCandidate(original, 'h1');
  assert.deepEqual(result.model.annotations, snapshot.annotations.slice(1));
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
  assert.throws(() => deleteHighlightCandidate(original, 'n1'), /不存在或已变为便签/);
  assert.throws(() => deleteHighlightCandidate(original, 'missing'), /不存在或已变为便签/);
});
