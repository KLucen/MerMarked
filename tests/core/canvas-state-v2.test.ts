import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { migrateCanvasStateV1ToV2, parseCanvasStateV2Json, serializeCanvasStateV2Json, validateCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { parseCanvasJson, reconcileCanvasState } from '../../src/core/canvas-state.ts';

function source(content: string) {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  return { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('v1 migration preserves IDs, links, viewport and group coordinates while splitting fold state', async () => {
  const input = source('# 中文😀\r\n\r\n## 子章节\r\n正文\r\n');
  const v1 = await reconcileCanvasState(null, input, (() => { let next = 0; return () => `card-${next++}`; })());
  const state = { ...v1.model, cards: v1.model.cards.map((card, index) => ({ ...card, position: { x: index * 80, y: -20 }, collapsed: index === 0 })),
    links: [{ id: 'edge', from: 'card-0', to: 'card-1', label: '关系' }] };
  const migrated = migrateCanvasStateV1ToV2(state);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.cards.map((card) => card.id), state.cards.map((card) => card.id));
  assert.deepEqual(migrated.cards.map((card) => card.position), state.cards.map((card) => card.position));
  assert.deepEqual(migrated.cards.map((card) => card.contentPosition), state.cards.map(() => ({ x: 0, y: 0 })));
  assert.deepEqual(migrated.cards.map((card) => card.bodyDisplay), state.cards.map(() => 'preview'));
  assert.deepEqual(migrated.cards.map((card) => card.descendantsCollapsed), state.cards.map((card) => card.collapsed));
  assert.deepEqual(migrated.links, state.links);
  assert.deepEqual(migrated.viewport, state.viewport);
});

test('v2 serialization roundtrips independent content position and body display', async () => {
  const input = source('# A\nbody\n');
  const v1 = await reconcileCanvasState(null, input, () => 'card-a');
  const migrated = migrateCanvasStateV1ToV2(v1.model);
  const changed = { ...migrated, cards: migrated.cards.map((card) => ({ ...card, contentPosition: { x: 180, y: 64 }, bodyDisplay: 'full' as const })) };
  assert.deepEqual(parseCanvasStateV2Json(serializeCanvasStateV2Json(changed)), changed);
});

test('v2 roundtrips adjustable card dimensions and keeps older cards without size readable', async () => {
  const input = source('# A\nbody\n');
  const v1 = await reconcileCanvasState(null, input, () => 'card-a');
  const migrated = migrateCanvasStateV1ToV2(v1.model);
  const resized = { ...migrated, cards: migrated.cards.map((card) => ({ ...card, size: { width: 520, height: 260 } })) };
  assert.deepEqual(parseCanvasStateV2Json(serializeCanvasStateV2Json(resized)), resized);
  const legacy = { ...resized, cards: resized.cards.map(({ size: _size, ...card }) => card) };
  assert.equal(parseCanvasStateV2Json(serializeCanvasStateV2Json(legacy)).cards[0].size, undefined);
  assert.throws(() => validateCanvasStateV2({ ...resized, cards: [{ ...resized.cards[0], size: { width: 100, height: 260 } }] }));
});

test('v2 validation rejects old collapsed field, unknown fields and invalid display values', async () => {
  const input = source('# A\n');
  const v1 = await reconcileCanvasState(null, input, () => 'card-a');
  const migrated = migrateCanvasStateV1ToV2(v1.model);
  assert.throws(() => validateCanvasStateV2({ ...migrated, cards: [{ ...migrated.cards[0], collapsed: false }] }));
  assert.throws(() => validateCanvasStateV2({ ...migrated, extra: true }));
  assert.throws(() => validateCanvasStateV2({ ...migrated, cards: [{ ...migrated.cards[0], bodyDisplay: 'summary' }] }));
});

test('migration is deterministic, does not mutate v1 input, and old v1 parser rejects v2 bytes', async () => {
  const input = source('# A\n\n## B\n');
  const v1 = await reconcileCanvasState(null, input, (() => { let next = 0; return () => `card-${next++}`; })());
  const snapshot = structuredClone(v1.model);
  const first = migrateCanvasStateV1ToV2(v1.model);
  const second = migrateCanvasStateV1ToV2(v1.model);
  assert.deepEqual(v1.model, snapshot);
  assert.deepEqual(first, second);
  assert.throws(() => parseCanvasJson(serializeCanvasStateV2Json(first)));
});

test('v2 rejects lone UTF-16 surrogates instead of letting TextEncoder replace them', async () => {
  const input = source('# A\n');
  const v1 = await reconcileCanvasState(null, input, () => 'card-a');
  const migrated = migrateCanvasStateV1ToV2(v1.model);
  assert.throws(() => validateCanvasStateV2({ ...migrated, links: [{ id: 'edge', from: 'card-a', to: 'card-a', label: '\uD800' }] }));
});
