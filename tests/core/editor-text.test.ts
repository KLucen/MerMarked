import assert from 'node:assert/strict';
import test from 'node:test';
import {
  editorSelectionPosition,
  editorToMarkdownText,
  findEditorTextMatches,
  markdownToEditorText,
  replaceAllEditorText,
  replaceEditorTextMatch,
} from '../../src/core/editor-text.ts';

test('textarea adaptation round-trips LF, CRLF, CR, and no trailing newline', () => {
  for (const [source, lineEnding] of [
    ['甲\n乙\n', 'lf'],
    ['甲\r\n乙\r\n', 'crlf'],
    ['甲\r乙', 'cr'],
    ['甲乙', 'none'],
  ] as const) {
    assert.equal(editorToMarkdownText(markdownToEditorText(source), lineEnding), source);
  }
});

test('new textarea lines use the established source newline form', () => {
  assert.equal(editorToMarkdownText('甲\n新增\n乙', 'crlf'), '甲\r\n新增\r\n乙');
  assert.equal(editorToMarkdownText('甲\n新增', 'none'), '甲\n新增');
});

test('line, column, and selection length count graphemes', () => {
  const text = '甲😀\ne\u0301文';
  assert.deepEqual(editorSelectionPosition(text, 3, text.length), {
    line: 1,
    column: 3,
    selectedCharacters: 3,
  });
  assert.deepEqual(editorSelectionPosition(text, text.length, text.length), {
    line: 2,
    column: 3,
    selectedCharacters: 0,
  });
});

test('literal source search is ordered, non-overlapping, and bounded', () => {
  assert.deepEqual(findEditorTextMatches('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(findEditorTextMatches('aaaa', 'a', 2), [
    { start: 0, end: 1 },
    { start: 1, end: 2 },
  ]);
  assert.deepEqual(findEditorTextMatches('abc', ''), []);
});

test('single and all replacements change only literal source matches', () => {
  assert.equal(replaceEditorTextMatch('a **a** a', { start: 4, end: 5 }, '中'), 'a **中** a');
  assert.deepEqual(replaceAllEditorText('a **a** a', 'a', '中'), {
    text: '中 **中** 中',
    count: 3,
  });
  assert.deepEqual(replaceAllEditorText('aa', 'a', '$&'), {
    text: '$&$&',
    count: 2,
  });
  const overVisibleMatchLimit = 'a'.repeat(10_001);
  assert.deepEqual(replaceAllEditorText(overVisibleMatchLimit, 'a', 'b'), {
    text: 'b'.repeat(10_001),
    count: 10_001,
  });
  assert.throws(
    () => replaceEditorTextMatch('abc', { start: 0, end: 4 }, 'x'),
    /查找结果已失效/,
  );
});
