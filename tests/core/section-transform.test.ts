import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applySectionTransform,
  previewSectionTransform,
} from '../../src/core/section-transform.ts';

const document = '# A\nA body\n## B\nB body\n# C\nC body\n## D\nD body\n';

test('moves a complete subtree to the end of the target subtree and reparses it', () => {
  const preview = previewSectionTransform(document, { kind: 'move', sourceIndex: 1, targetIndex: 2 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate, '# A\nA body\n# C\nC body\n## D\nD body\n\n## B\nB body\n');
  assert.deepEqual(
    preview.candidateTree.sections.map(({ title, depth, parentIndex }) => ({ title, depth, parentIndex })),
    [
      { title: 'A', depth: 1, parentIndex: null },
      { title: 'C', depth: 1, parentIndex: null },
      { title: 'D', depth: 2, parentIndex: 1 },
      { title: 'B', depth: 2, parentIndex: 1 },
    ],
  );
  assert.match(preview.summary, /移动/);
});

test('moving a later chapter keeps the target subtree and adjusts all moved heading levels', () => {
  const preview = previewSectionTransform(document, { kind: 'move', sourceIndex: 3, targetIndex: 0 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate, '# A\nA body\n## B\nB body\n\n## D\nD body\n\n# C\nC body\n');
});

test('rejects self, descendant, and current-parent moves without changing source', () => {
  for (const operation of [
    { kind: 'move', sourceIndex: 0, targetIndex: 0 } as const,
    { kind: 'move', sourceIndex: 0, targetIndex: 1 } as const,
    { kind: 'move', sourceIndex: 1, targetIndex: 0 } as const,
  ]) {
    const preview = previewSectionTransform(document, operation);
    assert.notEqual(preview.status, 'ready');
    assert.equal(preview.source, document);
  }
  assert.equal(applySectionTransform(document, { kind: 'move', sourceIndex: 1, targetIndex: 2 }),
    '# A\nA body\n# C\nC body\n## D\nD body\n\n## B\nB body\n');
});

test('promotes a chapter subtree as one undoable candidate', () => {
  const preview = previewSectionTransform(document, { kind: 'promote', sectionIndex: 3, targetDepth: 1 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate, '# A\nA body\n## B\nB body\n# C\nC body\n\n# D\nD body\n');
  assert.equal(preview.candidateTree.sections[3].depth, 1);
});

test('rejects level overflow before making a candidate', () => {
  const source = '# A\n## B\n### C\n#### D\n##### E\n###### F\n# Target\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 6 });
  assert.equal(preview.status, 'rejected');
  if (preview.status === 'rejected') assert.equal(preview.rejection.code, 'depth-overflow');
});

test('updates single-line Setext markers and converts Setext to ATX when needed', () => {
  const source = 'Setext\n---\nbody\n\n# Target\n';
  const move = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(move.status, 'ready');
  if (move.status !== 'ready') return;
  assert.equal(move.candidate, '# Target\n\nSetext\n---\nbody\n\n');

  const promote = previewSectionTransform('Setext\n---\nbody', { kind: 'promote', sectionIndex: 0, targetDepth: 1 });
  assert.equal(promote.status, 'ready');
  if (promote.status === 'ready') assert.equal(promote.candidate, 'Setext\n===\nbody');

  const convert = previewSectionTransform('Setext\n---\nbody\n\n## Target\n', { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(convert.status, 'ready');
  if (convert.status === 'ready') assert.equal(convert.candidate, '## Target\n\n### Setext\nbody\n\n');
});

test('preserves BOM, CRLF and unrelated bytes while changing a Setext heading', () => {
  const source = '\uFEFFIntro\r\n\r\nFoo\r\n---\r\nBody\r\n\r\n# Target\r\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate.startsWith('\uFEFFIntro\r\n\r\n# Target\r\n'), true);
  assert.equal(preview.candidate.endsWith('Foo\r\n---\r\nBody\r\n\r\n'), true);
});

test('blocks malformed multi-line Setext transformations', () => {
  const source = 'Foo\nbar\n---\nbody\n\n## Target\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'rejected');
  if (preview.status === 'rejected') assert.equal(preview.rejection.code, 'unsupported-setext');
});

test('promotion relocates the subtree without capturing following peers', () => {
  const source = '# A\n## B\nB\n### Child\nchild\n## C\nC\n# End\nend';
  const preview = previewSectionTransform(source, { kind: 'promote', sectionIndex: 1, targetDepth: 1 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.deepEqual(preview.sectionOrder, [0, 3, 4, 1, 2]);
  assert.deepEqual(preview.candidateTree.sections.map((entry) => entry.parentIndex), [null, 0, null, null, 3]);
  assert.equal(preview.candidate.endsWith('# B\nB\n## Child\nchild\n'), true);
});

test('promotion within a retained parent preserves skipped-level peers', () => {
  const source = '# A\n## X\n#### B\nbody\n#### C\npeer\n# End\n';
  const preview = previewSectionTransform(source, { kind: 'promote', sectionIndex: 2, targetDepth: 3 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.deepEqual(preview.sectionOrder, [0, 1, 3, 2, 4]);
  assert.deepEqual(preview.candidateTree.sections.map((entry) => entry.parentIndex), [null, 0, 1, 1, null]);
});

test('moving the last descendant to an ancestor handles equal subtree ends', () => {
  const source = '# A\n## B\n### C\nlast';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 2, targetIndex: 0 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate, '# A\n## B\n\n## C\nlast');
  assert.equal(preview.candidateTree.sections[2].parentIndex, 0);
});

test('adds explicit CRLF boundaries around a relocated unterminated final block', () => {
  const source = '\uFEFF# A\r\nbody\r\n# End\r\nlast';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 1, targetIndex: 0 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  assert.equal(preview.candidate, '\uFEFF# A\r\nbody\r\n\r\n## End\r\nlast');
  assert.equal(preview.addedBoundaryLineEndings, 1);
  assert.equal(preview.candidate.replaceAll('\r\n', '').includes('\n'), false);
});

test('rejects demotion and invalid indexes without generating candidates', () => {
  for (const operation of [
    { kind: 'promote', sectionIndex: 1, targetDepth: 3 } as const,
    { kind: 'promote', sectionIndex: 1, targetDepth: 0 } as const,
    { kind: 'move', sourceIndex: -1, targetIndex: 0 } as const,
    { kind: 'move', sourceIndex: 0, targetIndex: Number.NaN } as const,
  ]) assert.equal(previewSectionTransform(document, operation).status, 'rejected');
});

test('rejects moves that change first-definition-wins reference resolution', () => {
  const source = '# A\n[go][id]\n\n[id]: /first\n\n# B\n[id]: /second\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'rejected');
  if (preview.status === 'rejected') assert.equal(preview.rejection.code, 'unsafe-semantics');
});

test('preserves unique references, GFM, nested headings, comments and fenced code verbatim', () => {
  const body = '\n[go][id]\n\n[id]: /target "label"\n\n- [x] task\n  - nested\n\n| A | B |\n| - | - |\n| x | y |\n\n> # Inner\n\n```md\n# Code\n```\n\n<!-- retained -->\n\n';
  const source = `# A${body}# Target\n`;
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'ready');
  if (preview.status === 'ready') assert.equal(preview.candidate.endsWith(`## A${body}`), true);
});

test('rejects changed duplicate heading link identities, including encoded fragments and definitions', () => {
  for (const link of ['[go](#same)', '[go](#%73ame)', '[go][id]\n\n[id]: #same']) {
    const source = `${link}\n\n# Same\nfirst\n# Same\nsecond\n`;
    const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
    assert.equal(preview.status, 'rejected');
    if (preview.status === 'rejected') assert.equal(preview.rejection.code, 'unsafe-semantics');
  }
});

test('allows duplicate headings without links and preserves uniquely linked heading identity', () => {
  for (const source of ['# Same\nfirst\n# Same\nsecond\n', '[go](#a)\n\n# A\nbody\n# B\nbody\n']) {
    assert.equal(previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 }).status, 'ready');
  }
});

test('rejects raw HTML whose cross-block rendering is not proven', () => {
  const source = '# A\n<div>content</div>\n\n# B\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'rejected');
  if (preview.status === 'rejected') assert.equal(preview.rejection.code, 'unsafe-semantics');
});

test('rejects Setext conversion that changes inline closing-marker semantics', () => {
  const source = 'Title #\n---\nbody\n\n## Target\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'rejected');
});

test('moves multiline Setext unchanged when no marker conversion is required', () => {
  const source = 'First\nsecond\n---\nbody\n\n# Target\n';
  const preview = previewSectionTransform(source, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  assert.equal(preview.status, 'ready');
  if (preview.status === 'ready') assert.equal(preview.candidate.endsWith('First\nsecond\n---\nbody\n\n'), true);
});
