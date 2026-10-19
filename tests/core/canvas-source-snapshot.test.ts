import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCanvasSourceSnapshot, reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { migrateCanvasStateV1ToV2, reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';

function source(content: string, bom = false) {
  const bytes = Buffer.from((bom ? '\uFEFF' : '') + content);
  return { content, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function ids(prefix = 'card') { let next = 0; return () => `${prefix}-${next++}`; }

test('shared source projections preserve v1/v2 anchors, ambiguity and presentation across representative Markdown', async () => {
  for (const content of ['', 'plain 😀', '---\ntitle: x\n---\n\n前言\n\n# Same\nbody\n## Child\nchild\n# Same\nbody\n',
    '标题\r\n====\r\n\r\n中文é😀\r\n\r\n```md\r\n# not a heading\r\n```\r\n\r\n> # quoted\r\n\r\n# End\r\n[ref][x]\r\n\r\n[x]: /target\r\n']) {
    const snapshot = createCanvasSourceSnapshot(content);
    for (const bom of [false, true, false]) {
      const input = source(content, bom);
      const fresh = await reconcileCanvasState(null, input, ids());
      assert.deepEqual(await reconcileCanvasState(null, input, ids(), snapshot), fresh);
      const v2 = migrateCanvasStateV1ToV2(fresh.model);
      const first = v2.cards[0];
      const state = { ...v2, cards: [...v2.cards.map((card, i) => ({ ...card, position: { x: i * 40, y: -20 }, bodyDisplay: 'full' as const })),
        ...(first ? [{ ...first, id: 'duplicate' }] : [])] };
      const shared = await reconcileCanvasStateV2(state, input, ids('new'), snapshot);
      assert.deepEqual(shared, await reconcileCanvasStateV2(state, input, ids('new')));
      if (first) assert.ok(shared.unresolvedCardIds.includes(first.id), 'duplicate candidates remain unresolved');
    }
  }
});

test('warm projections still reject forged snapshots, stale bytes, wrong text and invalid UTF-8', async () => {
  const input = source('# A\nbody\n');
  const snapshot = createCanvasSourceSnapshot(input.content);
  await reconcileCanvasState(null, input, ids(), snapshot);
  await assert.rejects(reconcileCanvasState(null, input, ids(), { ...snapshot }));
  await assert.rejects(reconcileCanvasState(null, source('# B\nbody\n'), ids(), snapshot));
  await assert.rejects(reconcileCanvasState(null, { ...input, content: '# B\nbody\n' }, ids(), snapshot));
  const changed = Buffer.from(input.bytes); changed[2] = 66;
  await assert.rejects(reconcileCanvasState(null, { ...input, bytes: changed }, ids(), snapshot));
  const invalid = Buffer.from([0xff]);
  await assert.rejects(reconcileCanvasState(null, { ...input, bytes: invalid, sha256: createHash('sha256').update(invalid).digest('hex') }, ids(), snapshot));
  assert.throws(() => Object.assign(snapshot.tree.sections[0].headingRange, { start: 9 }));
  assert.throws(() => Object.assign(snapshot.tree.sections[0].childIndexes, { 0: 9 }));
});

test('caller mutations cannot poison a pending source proof or later cached anchors', async () => {
  const input = source('# Original\nbody😀\n');
  const snapshot = createCanvasSourceSnapshot(input.content);
  const pending = reconcileCanvasState(null, input, ids(), snapshot);
  input.bytes.fill(0);
  const result = await pending;
  const anchor = result.model.cards[0].anchor;
  assert.equal(anchor.kind, 'heading');
  if (anchor.kind !== 'heading') throw Error('expected heading');
  assert.equal(anchor.headingExact, '# Original');
  Object.assign(anchor.titlePath, { 0: 'poison' });
  Object.assign(anchor, { bodySha256: '0'.repeat(64) });
  const fresh = source(input.content);
  assert.deepEqual(await reconcileCanvasState(null, fresh, ids(), snapshot), await reconcileCanvasState(null, fresh, ids()));
});
