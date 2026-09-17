import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSections } from '../../src/core/sections.ts';

test('builds a section tree with exact half-open source ranges', () => {
  const source = '# A\nA body\n## B\nB body\n### C\nC body\n# D\nD body';
  const tree = extractSections(source);

  assert.deepEqual(tree.rootIndexes, [0, 3]);
  assert.deepEqual(
    tree.sections.map(({ title, depth, parentIndex, childIndexes }) => ({
      title,
      depth,
      parentIndex,
      childIndexes,
    })),
    [
      { title: 'A', depth: 1, parentIndex: null, childIndexes: [1] },
      { title: 'B', depth: 2, parentIndex: 0, childIndexes: [2] },
      { title: 'C', depth: 3, parentIndex: 1, childIndexes: [] },
      { title: 'D', depth: 1, parentIndex: null, childIndexes: [] },
    ],
  );
  assert.equal(tree.virtualCard, null);
  assert.equal(source.slice(tree.sections[0].headingRange.start, tree.sections[0].headingRange.end), '# A');
  assert.equal(source.slice(tree.sections[0].directContentRange.start, tree.sections[0].directContentRange.end), '\nA body\n');
  assert.equal(source.slice(tree.sections[0].subtreeRange.start, tree.sections[0].subtreeRange.end), '# A\nA body\n## B\nB body\n### C\nC body\n');
  assert.equal(source.slice(tree.sections[3].subtreeRange.start, tree.sections[3].subtreeRange.end), '# D\nD body');
});

test('keeps heading depth and duplicate titles exactly as parsed', () => {
  const source = '## Same\n### Same\n###### Same\n## Same\n';
  const tree = extractSections(source);

  assert.deepEqual(tree.rootIndexes, [0, 3]);
  assert.deepEqual(tree.sections.map((section) => section.depth), [2, 3, 6, 2]);
  assert.deepEqual(tree.sections.map((section) => section.parentIndex), [null, 0, 1, null]);
  assert.deepEqual(tree.sections.map((section) => section.title), ['Same', 'Same', 'Same', 'Same']);
  assert.deepEqual(tree.sections.map((section) => section.index), [0, 1, 2, 3]);
});

test('creates a preamble card for content before the first heading', () => {
  const source = 'Opening paragraph.\n\n# Chapter\nText';
  const tree = extractSections(source);

  assert.deepEqual(tree.virtualCard, {
    kind: 'preamble',
    sourceRange: { start: 0, end: source.indexOf('# Chapter') },
  });
  assert.equal(source.slice(tree.preambleRange.start, tree.preambleRange.end), 'Opening paragraph.\n\n');
});

test('uses a whole-document virtual card when no heading exists, including an empty file', () => {
  for (const source of ['', 'Only body text.\n', '---\ntitle: Example\n---\n']) {
    const tree = extractSections(source);
    assert.deepEqual(tree.sections, []);
    assert.deepEqual(tree.rootIndexes, []);
    assert.deepEqual(tree.virtualCard, {
      kind: 'whole-document',
      sourceRange: { start: 0, end: source.length },
    });
  }
});

test('recognizes YAML frontmatter without making it a section or a preamble card', () => {
  const source = '---\ntitle: Example\n---\n\n# Actual\n';
  const tree = extractSections(source);

  assert.equal(tree.sections.length, 1);
  assert.equal(tree.sections[0].title, 'Actual');
  assert.equal(tree.virtualCard, null);
  assert.equal(source.slice(tree.preambleRange.start, tree.preambleRange.end), '---\ntitle: Example\n---\n\n');
});

test('does not show a preamble card for only whitespace, but keeps text after YAML metadata', () => {
  assert.equal(extractSections('\n\n# Heading').virtualCard, null);

  const source = '---\ntitle: Example\n---\n\nIntroduction.\n\n# Heading';
  const tree = extractSections(source);
  assert.equal(tree.virtualCard?.kind, 'preamble');
  assert.equal(tree.virtualCard?.sourceRange.end, source.indexOf('# Heading'));
});

test('keeps multiline Setext syntax and CRLF/BOM offsets in the original source', () => {
  const source = '\uFEFFFoo *bar\r\nbaz*\r\n====\r\nBody\r\n\r\n## Next\r\n';
  const tree = extractSections(source);

  assert.deepEqual(tree.sections.map((section) => section.syntax), ['setext', 'atx']);
  assert.equal(tree.sections[0].depth, 1);
  assert.equal(tree.sections[0].title, 'Foo bar\nbaz');
  assert.equal(tree.sections[0].headingRange.start, source.indexOf('Foo *bar'));
  assert.equal(source.slice(tree.sections[0].headingRange.start, tree.sections[0].headingRange.end), 'Foo *bar\r\nbaz*\r\n====');
  assert.equal(source.slice(tree.sections[0].directContentRange.start, tree.sections[0].directContentRange.end), '\r\nBody\r\n\r\n');
  assert.equal(tree.sections[1].headingRange.start, source.indexOf('## Next'));
  assert.equal(tree.sections[1].parentIndex, 0);
  assert.equal(tree.sections[0].subtreeRange.end, source.length);
  assert.equal(tree.virtualCard, null);
});

test('ignores headings inside fenced code, indented code, block quotes, and lists', () => {
  const source = [
    '```md',
    '# fenced',
    '```',
    '',
    '    # indented',
    '',
    '> # quoted',
    '',
    '- # listed',
    '',
    '# Root',
    '> ## nested quote',
    '- ## nested list',
    '',
    '## Child',
  ].join('\n');
  const tree = extractSections(source);

  assert.deepEqual(tree.sections.map((section) => section.title), ['Root', 'Child']);
  assert.deepEqual(tree.sections.map((section) => section.parentIndex), [null, 0]);
  assert.equal(tree.virtualCard?.kind, 'preamble');
  assert.match(source.slice(tree.sections[0].directContentRange.start, tree.sections[0].directContentRange.end), /nested quote/);
});

test('does not mistake GFM table cells or emoji offsets for heading boundaries', () => {
  const source = '😀 intro\n\n# A\n| label | value |\n| --- | --- |\n| # cell | x |\n\n## B\n';
  const tree = extractSections(source);

  assert.deepEqual(tree.sections.map((section) => section.title), ['A', 'B']);
  assert.equal(tree.sections[0].headingRange.start, source.indexOf('# A'));
  assert.equal(tree.sections[1].headingRange.start, source.indexOf('## B'));
  assert.equal(tree.sections[0].directContentRange.end, tree.sections[1].headingRange.start);
});
