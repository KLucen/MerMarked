import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mapCanvasThroughSectionTransform, parseCanvasJson, reconcileCanvasState, serializeCanvasJson, validateCanvasState } from '../../src/core/canvas-state.ts';
import { previewSectionTransform } from '../../src/core/section-transform.ts';

function source(content: string, bom = false) {
  const bytes = Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(content)]);
  return { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function ids(prefix = 'card') { let next = 0; return () => `${prefix}-${next++}`; }

test('canvas schema roundtrips separate layouts, folds, links and source anchors', async () => {
  const input = source('# A\n\nbody\n\n# B\n\nbody\n\n');
  const created = await reconcileCanvasState(null, input, ids());
  const state = { ...created.model, cards: created.model.cards.map((card) => ({ ...card, position: { x: -20, y: 12 }, collapsed: true })),
    links: [{ id: 'link', from: 'card-0', to: 'card-1', label: 'relation' }] };
  assert.deepEqual(parseCanvasJson(serializeCanvasJson(state)), state);
  assert.deepEqual((await reconcileCanvasState(state, input, ids('unused'))).model, state);
  assert.equal(input.content, '# A\n\nbody\n\n# B\n\nbody\n\n');
});

test('same-hash duplicate headings retain their distinct exact byte identities', async () => {
  const input = source('# Same\nbody\n\n# Same\nbody\n\n');
  const created = await reconcileCanvasState(null, input, ids());
  const loaded = await reconcileCanvasState(created.model, input, ids('new'));
  assert.deepEqual(loaded.unresolvedCardIds, []);
  assert.deepEqual(loaded.bindings.map((item) => item.id), ['card-0', 'card-1']);
});

test('external duplicate copies remain unresolved and never rewire existing arrows', async () => {
  const before = source('# Same\nbody\n\n');
  const initial = await reconcileCanvasState(null, before, ids());
  const state = { ...initial.model, links: [{ id: 'loop', from: 'card-0', to: 'card-0', label: '' }] };
  const after = source('# Same\nbody\n\n# Same\nbody\n\n');
  const loaded = await reconcileCanvasState(state, after, ids('new'));
  assert.deepEqual(loaded.unresolvedCardIds, ['card-0']);
  assert.deepEqual(loaded.unresolvedLinkIds, ['loop']);
  assert.deepEqual(loaded.model.links, state.links);
  assert.equal(loaded.model.cards[0].anchor.basisSha256, before.sha256);
  assert.equal(loaded.model.source.sha256, after.sha256);
});

test('external reordering preserves only unique exact path and body matches', async () => {
  const before = source('# A\nfirst\n\n# B\nsecond\n\n');
  const initial = await reconcileCanvasState(null, before, ids());
  const after = source('# B\nsecond\n\n# A\nfirst\n\n');
  const loaded = await reconcileCanvasState(initial.model, after, ids('new'));
  assert.deepEqual(loaded.bindings.map(({ id, sectionIndex }) => [id, sectionIndex]), [['card-0', 1], ['card-1', 0]]);
  assert.deepEqual(loaded.unresolvedCardIds, []);
});

test('renames, changed bodies and changed parent paths retain old endpoints as unresolved', async () => {
  const before = source('# A\n\n## B\nbody\n\n');
  const initial = await reconcileCanvasState(null, before, ids());
  for (const content of ['# Renamed\n\n## B\nbody\n\n', '# A\n\n## B\nchanged\n\n', '# A\n\n# B\nbody\n\n']) {
    const loaded = await reconcileCanvasState(initial.model, source(content), ids('new'));
    assert.ok(loaded.unresolvedCardIds.includes('card-1'));
    assert.deepEqual(loaded.model.cards.find((card) => card.id === 'card-1'), initial.model.cards[1]);
  }
});

test('verified structural moves preserve IDs, coordinates, folds and arrows through changed paths', async () => {
  const before = source('# A\r\n\r\n## B\r\nbody\r\n\r\n# Target\r\n', true);
  const initial = await reconcileCanvasState(null, before, ids());
  const state = { ...initial.model, cards: initial.model.cards.map((card) => ({ ...card, position: { x: 10, y: 50 }, collapsed: true })),
    links: [{ id: 'edge', from: 'card-1', to: 'card-0', label: '中文 relation' }] };
  const preview = previewSectionTransform(before.content, { kind: 'move', sourceIndex: 1, targetIndex: 2 });
  assert.equal(preview.status, 'ready');
  if (preview.status !== 'ready') return;
  const after = source(preview.candidate, true);
  const loaded = await mapCanvasThroughSectionTransform(state, before, after, preview, ids('new'));
  assert.deepEqual(loaded.bindings.map(({ id, sectionIndex }) => [id, sectionIndex]), [['card-0', 0], ['card-1', 2], ['card-2', 1]]);
  assert.deepEqual(loaded.unresolvedCardIds, []);
  assert.deepEqual(loaded.model.links, state.links);
  assert.deepEqual(loaded.model.cards[1].position, state.cards[1].position);
  assert.equal(loaded.model.cards[1].collapsed, true);
});

test('BOM and UTF-8 anchors include CRLF and multibyte headings in exact byte coordinates', async () => {
  const input = source('# 中文😀\r\n\r\n## B\r\n', true);
  const initial = await reconcileCanvasState(null, input, ids());
  for (const card of initial.model.cards) {
    if (card.anchor.kind !== 'heading') continue;
    assert.equal(input.bytes.subarray(card.anchor.startByte, card.anchor.endByte).toString('utf8'), card.anchor.headingExact);
  }
  assert.equal(initial.model.cards[0].anchor.kind === 'heading' && initial.model.cards[0].anchor.startByte, 3);
});

test('virtual preamble and whole-document cards do not invent Markdown headings', async () => {
  for (const [content, kind] of [['', 'whole-document'], ['plain text', 'whole-document'], ['Intro\n\n# A\n', 'preamble']] as const) {
    const initial = await reconcileCanvasState(null, source(content), ids());
    assert.equal(initial.bindings.at(-1)?.kind, kind);
    assert.equal(initial.bindings.at(-1)?.sectionIndex, null);
  }
  const metadata = await reconcileCanvasState(null, source('---\na: b\n---\n# A\n'), ids());
  assert.equal(metadata.model.cards.length, 1);
});

test('schema rejects unknown versions, fields, duplicate IDs, missing endpoints and nonfinite positions', async () => {
  const initial = await reconcileCanvasState(null, source('# A\n'), ids());
  for (const state of [
    { ...initial.model, schemaVersion: 2 }, { ...initial.model, extra: true },
    { ...initial.model, cards: [...initial.model.cards, initial.model.cards[0]] },
    { ...initial.model, links: [{ id: 'edge', from: 'card-0', to: 'missing', label: '' }] },
    { ...initial.model, viewport: { x: 0, y: 0, zoom: 0 } },
    { ...initial.model, cards: [{ ...initial.model.cards[0], position: { x: Number.NaN, y: 0 } }] },
  ]) assert.throws(() => validateCanvasState(state));
  assert.throws(() => parseCanvasJson('not json'));
});

test('colliding claims for one chapter remain unresolved rather than choosing the first', async () => {
  const input = source('# A\nbody\n');
  const initial = await reconcileCanvasState(null, input, ids());
  const state = { ...initial.model, cards: [initial.model.cards[0], { ...initial.model.cards[0], id: 'other' }] };
  const loaded = await reconcileCanvasState(state, input, ids('new'));
  assert.deepEqual(loaded.unresolvedCardIds, ['card-0', 'other']);
});

test('source mismatches and forged structural identity mappings are rejected', async () => {
  const before = source('# A\n\n# B\n');
  const initial = await reconcileCanvasState(null, before, ids());
  await assert.rejects(reconcileCanvasState(initial.model, { ...before, content: 'different' }, ids('new')));
  const preview = previewSectionTransform(before.content, { kind: 'move', sourceIndex: 0, targetIndex: 1 });
  if (preview.status !== 'ready') throw new Error('fixture transform failed');
  await assert.rejects(mapCanvasThroughSectionTransform(initial.model, before, source(preview.candidate),
    { ...preview, sectionOrder: [0, 1] }, ids('new')));
});
