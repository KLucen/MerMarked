import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RECENT_DOCUMENT_LIMIT,
  filterRecentDocuments,
  isAbsoluteDocumentPath,
  normalizeRecentDocuments,
  parseRecentDocuments,
  recordRecentDocument,
  removeRecentDocument,
  serializeRecentDocuments,
} from '../../src/core/recent-documents.ts';

test('normalization de-duplicates by path, sorts newest first, and keeps ties stable', () => {
  const records = normalizeRecentDocuments([
    { path: 'C:\\Notes\\a.md', openedAt: 100 },
    { path: 'C:/Notes/b.md', openedAt: 300 },
    { path: 'c:\\notes\\A.md', openedAt: 200 },
    { path: 'C:\\Notes\\c.md', openedAt: 300 },
  ]);
  assert.deepEqual(records, [
    { path: 'C:/Notes/b.md', openedAt: 300 },
    { path: 'C:\\Notes\\c.md', openedAt: 300 },
    { path: 'c:\\notes\\A.md', openedAt: 200 },
  ]);
});

test('recording an existing path updates its time and applies the upper bound', () => {
  const records = recordRecentDocument([
    { path: '/docs/a.md', openedAt: 10 },
    { path: '/docs/b.md', openedAt: 20 },
  ], '/DOCS/A.md', 30, { maxEntries: 2 });
  assert.deepEqual(records, [
    { path: '/DOCS/A.md', openedAt: 30 },
    { path: '/docs/b.md', openedAt: 20 },
  ]);
  assert.equal(DEFAULT_RECENT_DOCUMENT_LIMIT > 0, true);
});

test('removal and caller-owned availability filtering never inspect the filesystem', () => {
  const source = [
    { path: '/docs/a.md', openedAt: 10 },
    { path: '/docs/b.md', openedAt: 20 },
  ];
  assert.deepEqual(removeRecentDocument(source, '/docs/a.md'), [{ path: '/docs/b.md', openedAt: 20 }]);
  assert.deepEqual(filterRecentDocuments(source, (entry) => entry.path.endsWith('b.md')), [{ path: '/docs/b.md', openedAt: 20 }]);
});

test('JSON roundtrip stores only absolute path and open time', () => {
  const serialized = serializeRecentDocuments([{ path: '/docs/a.md', openedAt: 42 }]);
  assert.equal(serialized, '[{"path":"/docs/a.md","openedAt":42}]\n');
  assert.deepEqual(parseRecentDocuments(serialized), [{ path: '/docs/a.md', openedAt: 42 }]);
  assert.throws(() => parseRecentDocuments('[{"path":"/docs/a.md","openedAt":42,"name":"a.md"}]'));
});

test('invalid relative paths, timestamps, limits, and UTF-16 boundaries are rejected', () => {
  assert.equal(isAbsoluteDocumentPath('relative.md'), false);
  assert.equal(isAbsoluteDocumentPath('C:relative.md'), false);
  assert.equal(isAbsoluteDocumentPath('C:\\absolute.md'), true);
  assert.equal(isAbsoluteDocumentPath('\\\\server\\share\\absolute.md'), true);
  assert.throws(() => recordRecentDocument([], 'relative.md', 1));
  assert.throws(() => recordRecentDocument([], '/docs/a.md', -1));
  assert.throws(() => normalizeRecentDocuments([{ path: '/docs/a.md', openedAt: 1 }], { maxEntries: -1 }));
  assert.throws(() => normalizeRecentDocuments([{ path: '/docs/\uD800.md', openedAt: 1 }]));
});

test('normalization returns fresh records and does not mutate input', () => {
  const source = [{ path: '/docs/a.md', openedAt: 1 }];
  const result = normalizeRecentDocuments(source);
  assert.notEqual(result, source);
  assert.notEqual(result[0], source[0]);
  assert.deepEqual(source, [{ path: '/docs/a.md', openedAt: 1 }]);
});
