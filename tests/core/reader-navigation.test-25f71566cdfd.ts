import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSectionAtMarker, countGraphemes } from '../../src/core/reader-navigation.ts';

test('active section stays empty before the first heading and advances in document order', () => {
  const positions = [
    { index: 0, top: 220 },
    { index: 1, top: 480 },
    { index: 2, top: 760 },
  ];

  assert.equal(activeSectionAtMarker(positions, 140), null);
  assert.equal(activeSectionAtMarker(positions, 220), 0);
  assert.equal(activeSectionAtMarker(positions, 650), 1);
  assert.equal(activeSectionAtMarker(positions, 900), 2);
});

test('active section ignores invalid trailing measurements', () => {
  assert.equal(activeSectionAtMarker([
    { index: 0, top: 80 },
    { index: 1, top: Number.NaN },
  ], 140), 0);
});

test('grapheme count treats emoji and combining marks as visible characters', () => {
  assert.equal(countGraphemes('中文 A😀 e\u0301'), 7);
  assert.equal(countGraphemes('👨‍👩‍👧‍👦'), 1);
});
