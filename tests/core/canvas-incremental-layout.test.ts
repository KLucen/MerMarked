import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { placeNewCanvasCardsV2 } from '../../src/core/canvas-incremental-layout.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { migrateCanvasStateV1ToV2, reconcileCanvasStateV2, validateCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import type { CanvasStateV2, ReconciledCanvasV2 } from '../../src/core/canvas-state-v2.ts';
import { reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { extractSections } from '../../src/core/sections.ts';

function source(content: string) {
  const bytes = Buffer.from(content);
  return { content, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function ids(prefix: string) { let index = 0; return () => `${prefix}-${index++}`; }
function noOverlap(left: { position: { x: number; y: number }; width: number; height: number },
  right: { position: { x: number; y: number }; width: number; height: number }) {
  assert.ok(left.position.x + left.width <= right.position.x || right.position.x + right.width <= left.position.x ||
    left.position.y + left.height <= right.position.y || right.position.y + right.height <= left.position.y,
  'new sibling groups do not overlap');
}
function assertRetained(previous: CanvasStateV2, before: ReconciledCanvasV2, after: CanvasStateV2) {
  for (const known of previous.cards) {
    assert.strictEqual(after.cards.find(card => card.id === known.id), before.model.cards.find(card => card.id === known.id));
  }
  assert.strictEqual(after.links, before.model.links);
  assert.strictEqual(after.viewport, before.model.viewport);
}

test('new root chapters preserve negative and intentionally overlapping saved cards, preferences, links and viewport', async () => {
  const input = source('# 第一章\n正文一\n\n# 第二章\n正文二\n\n');
  const first = await reconcileCanvasStateV2(null, input, ids('old'));
  const saved: CanvasStateV2 = { ...first.model,
    cards: first.model.cards.map(card => ({ ...card, position: { x: -410, y: -60 }, contentPosition: { x: 220, y: 90 },
      size: { width: 640, height: 320 }, bodyDisplay: 'full', descendantsCollapsed: true })),
    links: [{ id: 'arrow', from: 'old-0', to: 'old-1', label: '保留关系' }], viewport: { x: 341, y: 219, zoom: 0.7 } };
  const next = source(input.content + '# 新章一\n新增正文\n\n# 新章二\n新增正文二\n');
  const reconciled = await reconcileCanvasStateV2(saved, next, ids('new'));
  assert.deepEqual(reconciled.unresolvedCardIds, []);
  const before = structuredClone(reconciled.model);
  const tree = extractSections(next.content), known = new Set(saved.cards.map(card => card.id));
  const placed = placeNewCanvasCardsV2(next.content, tree, reconciled.model, reconciled.bindings, known);
  assert.deepEqual(reconciled.model, before);
  assertRetained(saved, reconciled, placed);
  assert.deepEqual(placed, placeNewCanvasCardsV2(next.content, tree, reconciled.model, reconciled.bindings, known));
  assert.deepEqual(next.bytes, Buffer.from(next.content));
  const scene = buildCanvasSceneV2(next.content, tree, placed, reconciled.bindings);
  for (const added of scene.cards.filter(card => !known.has(card.id))) {
    for (const other of scene.cards.filter(card => card.id !== added.id)) noOverlap(added, other);
  }
  assert.deepEqual(validateCanvasStateV2(placed), placed);
});

test('nested insertions reserve full new subtrees and measured parent bodies while keeping known relative coordinates', async () => {
  const input = source('# Parent\nparent body\n\n## Existing\nold child\n\n# Peer\npeer body\n\n');
  const first = await reconcileCanvasStateV2(null, input, ids('old'));
  const saved: CanvasStateV2 = { ...first.model, cards: first.model.cards.map((card, index) => ({ ...card,
    position: index === 1 ? { x: 60, y: 480 } : { x: 200 + index * 900, y: -200 },
    contentPosition: { x: 70, y: 64 }, size: { width: 520, height: 260 } })) };
  const next = source(input.content.replace('# Peer', '## Added\nnew child\n\n### Grandchild\nnew grandchild\n\n## Sibling\nnew sibling\n\n# Peer'));
  const reconciled = await reconcileCanvasStateV2(saved, next, ids('new'));
  assert.deepEqual(reconciled.unresolvedCardIds, []);
  const tree = extractSections(next.content), known = new Set(saved.cards.map(card => card.id));
  const placed = placeNewCanvasCardsV2(next.content, tree, reconciled.model, reconciled.bindings, known, { 'old-0': 900, 'new-0': 640 });
  assertRetained(saved, reconciled, placed);
  const scene = buildCanvasSceneV2(next.content, tree, placed, reconciled.bindings);
  const children = scene.cards.filter(card => card.parentId === 'old-0');
  for (const added of children.filter(card => !known.has(card.id))) {
    assert.ok(added.position.y >= 900, 'new child clears actual measured parent body');
    for (const other of children.filter(card => card.id !== added.id)) noOverlap(added, other);
  }
  const grandchild = scene.cards.find(card => card.parentId === 'new-0')!;
  assert.ok(grandchild.position.y >= 640, 'new grandchild clears measured new-parent body');
  assert.deepEqual(placed.cards.find(card => card.id === 'old-1')?.position, { x: 60, y: 480 });
});

test('folded descendants receive durable non-overlapping positions without hidden DOM measurements', async () => {
  const input = source('# Parent\nparent body\n\n## Existing\nold child\n\n# Peer\npeer body\n\n');
  const first = await reconcileCanvasStateV2(null, input, ids('old'));
  const saved: CanvasStateV2 = { ...first.model, cards: first.model.cards.map((card, index) => ({ ...card,
    position: { x: 40 + index * 400, y: 280 }, descendantsCollapsed: index === 0 })) };
  const next = source(input.content.replace('# Peer', '## Added\nnew child\n\n### Grandchild\nnew grandchild\n\n# Peer'));
  const reconciled = await reconcileCanvasStateV2(saved, next, ids('new'));
  assert.deepEqual(reconciled.unresolvedCardIds, []);
  const tree = extractSections(next.content), known = new Set(saved.cards.map(card => card.id));
  const placed = placeNewCanvasCardsV2(next.content, tree, reconciled.model, reconciled.bindings, known, { 'old-0': 192, 'old-2': 192 });
  assertRetained(saved, reconciled, placed);
  const folded = buildCanvasSceneV2(next.content, tree, placed, reconciled.bindings);
  assert.ok(folded.cards.filter(card => card.parentId === 'old-0' || card.parentId === 'new-0').every(card => card.hidden));
  const unfolded = buildCanvasSceneV2(next.content, tree, { ...placed,
    cards: placed.cards.map(card => ({ ...card, descendantsCollapsed: false })) }, reconciled.bindings);
  const oldChild = unfolded.cards.find(card => card.id === 'old-1')!;
  const newChild = unfolded.cards.find(card => card.id === 'new-0')!;
  noOverlap(oldChild, newChild);
  assert.ok(newChild.width >= 360 + 24, 'new subtree is reserved before its hidden descendant is mounted');
});

test('migrated v1 presentation and known coordinates remain unchanged after adding a root', async () => {
  const input = source('# Old\nold body\n\n');
  const first = await reconcileCanvasState(null, input, () => 'old');
  const saved = migrateCanvasStateV1ToV2({ ...first.model, cards: first.model.cards.map(card => ({ ...card,
    position: { x: -75, y: 0 }, collapsed: true })), links: [{ id: 'self', from: 'old', to: 'old', label: 'loop' }] });
  const next = source(input.content + '# Added\nnew\n');
  const reconciled = await reconcileCanvasStateV2(saved, next, ids('new'));
  const placed = placeNewCanvasCardsV2(next.content, extractSections(next.content), reconciled.model, reconciled.bindings, new Set(['old']));
  assertRetained(saved, reconciled, placed);
  assert.deepEqual(placed.cards[0].contentPosition, { x: 0, y: 0 });
  assert.deepEqual(placed.cards[0].position, { x: -75, y: 0 });
});

test('unresolved old identities and their arrows are retained rather than reinterpreted as new cards', async () => {
  const input = source('# Stable\nfirst\n\n# Last\nlast body\n');
  const first = await reconcileCanvasStateV2(null, input, ids('old'));
  const saved: CanvasStateV2 = { ...first.model, cards: first.model.cards.map((card, index) => ({ ...card,
    position: { x: -800 + index * 500, y: -130 } })), links: [{ id: 'orphan-arrow', from: 'old-0', to: 'old-1', label: 'unresolved remains' }] };
  // Adding a separator also changes the old last body fingerprint. Its old
  // identity must stay unresolved; the newly bound replacement is independent.
  const next = source(input.content + '\n# Added\nnew\n');
  const reconciled = await reconcileCanvasStateV2(saved, next, ids('new'));
  assert.deepEqual(reconciled.unresolvedCardIds, ['old-1']);
  assert.deepEqual(reconciled.unresolvedLinkIds, ['orphan-arrow']);
  const placed = placeNewCanvasCardsV2(next.content, extractSections(next.content), reconciled.model, reconciled.bindings,
    new Set(saved.cards.map(card => card.id)));
  assertRetained(saved, reconciled, placed);
  assert.deepEqual(placed.cards.find(card => card.id === 'old-1')?.position, { x: -300, y: -130 });
  assert.ok(reconciled.bindings.every(binding => binding.id !== 'old-1'));
});

test('a right-edge layout uses another bounded direction without clamping known coordinates', async () => {
  const input = source('# Old\nbody\n\n');
  const first = await reconcileCanvasStateV2(null, input, () => 'old');
  const saved: CanvasStateV2 = { ...first.model, cards: first.model.cards.map(card => ({ ...card,
    position: { x: 999_900, y: 0 }, size: { width: 1_200, height: 400 } })) };
  const next = source(input.content + '# Added\nnew\n');
  const reconciled = await reconcileCanvasStateV2(saved, next, () => 'added');
  const placed = placeNewCanvasCardsV2(next.content, extractSections(next.content), reconciled.model, reconciled.bindings, new Set(['old']));
  assertRetained(saved, reconciled, placed);
  const scene = buildCanvasSceneV2(next.content, extractSections(next.content), placed, reconciled.bindings);
  const added = scene.cards.find(card => card.id === 'added')!;
  assert.ok(added.position.y >= 480);
  assert.ok(added.position.x <= 1_000_000);
  noOverlap(added, scene.cards.find(card => card.id === 'old')!);
});

test('exhausted coordinate bounds refuse placement without mutating valid saved data', async () => {
  const input = source('# Parent\nbody\n\n## Child\nbody\n\n');
  const first = await reconcileCanvasStateV2(null, input, ids('old'));
  const saved: CanvasStateV2 = { ...first.model, cards: first.model.cards.map((card, index) => ({ ...card,
    position: { x: index ? 1_000_000 : -1_000_000, y: index ? 1_000_000 : -1_000_000 },
    contentPosition: { x: 1_000_000, y: 1_000_000 } })) };
  validateCanvasStateV2(saved);
  const next = source(input.content + '# Added\nnew\n');
  const reconciled = await reconcileCanvasStateV2(saved, next, () => 'added');
  const before = structuredClone(reconciled.model);
  assert.throws(() => placeNewCanvasCardsV2(next.content, extractSections(next.content), reconciled.model,
    reconciled.bindings, new Set(saved.cards.map(card => card.id))), /坐标范围内安全放置/);
  assert.deepEqual(reconciled.model, before);
});

test('no new bound identities is an exact no-op; unrelated orphan records never trigger placement', async () => {
  const input = source('# Existing\nbody\n');
  const first = await reconcileCanvasStateV2(null, input, () => 'existing');
  const model: CanvasStateV2 = { ...first.model, cards: [...first.model.cards, { ...first.model.cards[0], id: 'unbound' }] };
  assert.strictEqual(placeNewCanvasCardsV2(input.content, extractSections(input.content), model, first.bindings,
    new Set(['existing'])), model);
});
