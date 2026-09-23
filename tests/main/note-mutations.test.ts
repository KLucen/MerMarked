import assert from 'node:assert/strict';
import test from 'node:test';
import type { AnnotationAnchor, AnnotationRecord, AnnotationSidecar } from '../../src/core/annotations.ts';
import {
  createNoteCandidate,
  deleteNoteCandidate,
  updateNoteCandidate,
} from '../../src/core/annotation-mutations.ts';
import type { NoteTagInput } from '../../src/types/reader-api.d.ts';

const sha = 'b'.repeat(64);
const time = '2026-09-18T00:00:00Z';
const later = '2026-09-18T00:01:00Z';

function anchor(startByte: number, exact: string): AnnotationAnchor {
  return {
    basisSha256: sha,
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    prefix: '前',
    suffix: '后',
    displayQuote: exact,
  };
}

function sidecar(): AnnotationSidecar {
  return {
    schemaVersion: 1,
    source: { sha256: sha, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [
      { id: 'tag-check', name: '检查' },
      { id: 'tag-cafe', name: 'Café' },
    ],
    annotations: [
      { id: 'h1', kind: 'highlight', color: 'amber', anchor: anchor(1, '甲'), createdAt: time, updatedAt: time },
      {
        id: 'n1', kind: 'note', color: 'blue', anchor: anchor(4, '乙'), note: '原便签', tagId: 'tag-check',
        createdAt: time, updatedAt: time,
      },
      { id: 'h2', kind: 'highlight', color: 'rose', anchor: anchor(7, '丙'), createdAt: time, updatedAt: time },
    ],
  };
}

test('create note converts the exact highlight in place and preserves its identity and color', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = createNoteCandidate(
    original, anchor(1, '甲'), '\n  保留首尾换行与空格  \n', { mode: 'existing', id: 'tag-check' },
    'unused-new-id', undefined, later,
  );

  assert.equal(result.id, 'h1');
  assert.deepEqual(result.model.annotations.map((item) => item.id), ['h1', 'n1', 'h2']);
  assert.deepEqual(result.model.annotations[0], {
    ...snapshot.annotations[0],
    kind: 'note',
    note: '\n  保留首尾换行与空格  \n',
    tagId: 'tag-check',
    updatedAt: later,
  });
  assert.deepEqual(result.model.annotations.slice(1), snapshot.annotations.slice(1));
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
});

test('create note appends a direct uncolored note and can explicitly choose no tag', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const nextAnchor = anchor(10, '丁');
  const result = createNoteCandidate(original, nextAnchor, '直接便签', { mode: 'none' }, 'n2', undefined, later);

  assert.equal(result.id, 'n2');
  assert.deepEqual(result.model.annotations.slice(0, 3), snapshot.annotations);
  assert.deepEqual(result.model.annotations[3], {
    id: 'n2', kind: 'note', anchor: nextAnchor, note: '直接便签', createdAt: later, updatedAt: later,
  });
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
});

test('create note appends a new tag and note in one candidate while preserving unrelated order', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = createNoteCandidate(
    original, anchor(10, '丁'), '需要回答', { mode: 'new', name: '  疑问  ' }, 'n2', 'tag-question', later,
  );

  assert.deepEqual(result.model.tags, [...snapshot.tags, { id: 'tag-question', name: '疑问' }]);
  assert.equal(result.model.annotations[3].tagId, 'tag-question');
  assert.deepEqual(result.model.annotations.slice(0, 3), snapshot.annotations);
});

test('new tag reuses an NFC-equivalent exact-case name and does not create a duplicate', () => {
  const original = sidecar();
  const result = createNoteCandidate(
    original, anchor(10, '丁'), '引用已有标签', { mode: 'new', name: '  Cafe\u0301  ' }, 'n2', 'unused-tag', later,
  );

  assert.deepEqual(result.model.tags, original.tags);
  assert.equal(result.model.annotations[3].tagId, 'tag-cafe');

  const distinctCase = createNoteCandidate(
    original, anchor(10, '丁'), '大小写不同', { mode: 'new', name: 'café' }, 'n3', 'tag-lower', later,
  );
  assert.deepEqual(distinctCase.model.tags.at(-1), { id: 'tag-lower', name: 'café' });
});

test('create note refuses an existing note, ambiguous duplicate highlights and duplicate IDs', () => {
  const original = sidecar();
  assert.throws(
    () => createNoteCandidate(original, anchor(4, '乙'), '重复', { mode: 'none' }, 'n2', undefined, later),
    /已有便签/,
  );
  assert.throws(
    () => createNoteCandidate(original, anchor(10, '丁'), '重复 ID', { mode: 'none' }, 'h1', undefined, later),
    /ID 已存在/,
  );
  const duplicate = {
    ...original,
    annotations: [
      ...original.annotations,
      { ...original.annotations[0], id: 'h-duplicate' } as AnnotationRecord,
    ],
  };
  assert.throws(
    () => createNoteCandidate(duplicate, anchor(1, '甲'), '歧义', { mode: 'none' }, 'n2', undefined, later),
    /重复高亮/,
  );
});

test('update note changes text and existing/new/none tag without disturbing other records', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);

  const none = updateNoteCandidate(original, 'n1', '更新正文', { mode: 'none' }, undefined, later);
  const expectedWithoutTag = { ...snapshot.annotations[1], note: '更新正文', updatedAt: later };
  delete expectedWithoutTag.tagId;
  assert.deepEqual(none.model.annotations[1], expectedWithoutTag);
  assert.equal(Object.hasOwn(none.model.annotations[1], 'tagId'), false);
  assert.deepEqual(none.model.annotations[0], snapshot.annotations[0]);
  assert.deepEqual(none.model.annotations[2], snapshot.annotations[2]);
  assert.deepEqual(none.model.tags, snapshot.tags);

  const existing = updateNoteCandidate(none.model, 'n1', '更新正文', { mode: 'existing', id: 'tag-cafe' }, undefined, later);
  assert.equal(existing.model.annotations[1].tagId, 'tag-cafe');

  const added = updateNoteCandidate(existing.model, 'n1', '更新正文', { mode: 'new', name: '结论' }, 'tag-result', later);
  assert.deepEqual(added.model.tags.at(-1), { id: 'tag-result', name: '结论' });
  assert.equal(added.model.annotations[1].tagId, 'tag-result');
});

test('update no-op keeps the original model and timestamp', () => {
  const original = sidecar();
  const result = updateNoteCandidate(original, 'n1', '原便签', { mode: 'existing', id: 'tag-check' }, undefined, later);
  assert.equal(result.changed, false);
  assert.equal(result.model, original);
  assert.equal(result.model.annotations[1].updatedAt, time);
});

test('delete removes only a note and never deletes its tag', () => {
  const original = sidecar();
  const snapshot = structuredClone(original);
  const result = deleteNoteCandidate(original, 'n1');
  assert.deepEqual(result.model.annotations, [snapshot.annotations[0], snapshot.annotations[2]]);
  assert.deepEqual(result.model.tags, snapshot.tags);
  assert.deepEqual(original, snapshot);
  assert.throws(() => deleteNoteCandidate(original, 'h1'), /便签不存在/);
  assert.throws(() => deleteNoteCandidate(original, 'missing'), /便签不存在/);
});

test('note and tag inputs reject blank, oversized, malformed and missing references', () => {
  const original = sidecar();
  const create = (note: string, tag: NoteTagInput, newTagId?: string) =>
    createNoteCandidate(original, anchor(10, '丁'), note, tag, 'n2', newTagId, later);

  assert.throws(() => create(' \n\t ', { mode: 'none' }), /不能为空/);
  assert.throws(() => create('中'.repeat(10_923), { mode: 'none' }), /32768/);
  assert.throws(() => create('\ud800', { mode: 'none' }), /32768/);
  assert.throws(() => create('正文', { mode: 'new', name: '跨\n行' }, 'tag-new'), /不支持的字符/);
  assert.throws(() => create('正文', { mode: 'new', name: '中'.repeat(86) }, 'tag-new'), /256/);
  assert.throws(() => create('正文', { mode: 'new', name: '标签' }, 'bad id'), /新标签 ID 无效/);
  assert.throws(() => create('正文', { mode: 'existing', id: 'missing' }), /标签不存在/);
  assert.throws(
    () => createNoteCandidate(original, anchor(10, '丁'), '正文', { mode: 'none' }, 'bad id', undefined, later),
    /批注 ID 无效/,
  );
  assert.throws(() => updateNoteCandidate(original, 'bad id', '正文', { mode: 'none' }, undefined, later), /便签 ID 无效/);
});

test('new tag creation respects the schema tag-count limit', () => {
  const original = sidecar();
  original.tags = Array.from({ length: 200 }, (_, index) => ({ id: `tag-${index}`, name: `标签 ${index}` }));
  assert.throws(
    () => createNoteCandidate(original, anchor(10, '丁'), '正文', { mode: 'new', name: '额外' }, 'n2', 'tag-extra', later),
    /达到上限/,
  );
});
