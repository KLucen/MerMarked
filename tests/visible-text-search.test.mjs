import assert from 'node:assert/strict';
import test from 'node:test';
import { findVisibleTextMatches, scanVisibleTextMatches } from '../src/core/visible-text-search.ts';

function reference(text, query, limit = Infinity) {
  if (!query || limit <= 0) return [];
  const boundaries = new Set([0, text.length]);
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) boundaries.add(part.index);
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches = [];
  for (const match of text.matchAll(expression)) {
    const end = match.index + match[0].length;
    if (boundaries.has(match.index) && boundaries.has(end)) matches.push({ start: match.index, end });
    if (matches.length >= limit) break;
  }
  return matches;
}

test('candidate boundary checks match complete grapheme segmentation for Unicode and literal searches', () => {
  const parts = ['中文', 'A.a', 'á', '🇨🇳🇯🇵', '👨‍👩‍👧‍👦', '👍🏽', '\r\n', 'क्‍ष', 'İiı', 'ſsKk', 'a\u0000b', '[a] (b) + .*'];
  const queries = [...parts, 'a', 'A', '.', '́', '🇨', '👩', '🏽', '\n', 's', 'k', '中', '', 'missing'];
  for (let i = 0; i < parts.length; i++) for (let j = 0; j < parts.length; j++) {
    const text = parts[i] + parts[j] + ' ' + parts[i];
    for (const query of queries) assert.deepEqual(findVisibleTextMatches(text, query, 3), reference(text, query, 3), JSON.stringify({text,query}));
  }
});

test('scan exposes rejected candidates so long partial-emoji searches can be interrupted', () => {
  const scan = scanVisibleTextMatches('👍🏽'.repeat(10000), '👍');
  assert.deepEqual(scan.next(), { value: null, done: false });
  scan.return();
  assert.equal(scan.next().done, true);
});

test('literal matching retains non-overlap, limits and exact UTF-16 positions', () => {
  assert.deepEqual(findVisibleTextMatches('😀 AaAaAa END', 'aa', 2), [{ start: 3, end: 5 }, { start: 5, end: 7 }]);
  assert.deepEqual(findVisibleTextMatches('x', 'x', 0), []);
  assert.deepEqual(findVisibleTextMatches('a.*b A.*B', '.*'), [{ start: 1, end: 3 }, { start: 6, end: 8 }]);
  const text = 'plain content '.repeat(400000) + '中文😀target';
  assert.deepEqual(findVisibleTextMatches(text, 'target'), [{start:text.length-6,end:text.length}]);
  assert.deepEqual(findVisibleTextMatches(text, 'missing'), []);
});
