import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertCanvasExportSize, buildCanvasExportScene, canvasSceneToSvg } from '../../src/core/canvas-export.ts';
import { preflightCanvasExport } from '../../src/core/canvas-export-preflight.ts';
import type { CanvasSceneCard, CanvasSceneLink } from '../../src/core/canvas-scene.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { extractSections } from '../../src/core/sections.ts';

function card(id: string, x = 0, y = 0, width = 300, height = 180): CanvasSceneCard {
  return { id, sectionIndex: 0, hidden: false, width, height, hiddenDescendants: 0, position: { x, y } };
}

test('preflight measures offscreen nested cards, negative coordinates, full labels and self-loop bounds exactly as export', () => {
  const cards = [
    card('root', -420.5, -160.25, 320, 220),
    { ...card('child', 340.25, 240.5, 280, 180), parentId: 'root', sectionIndex: 1 },
    { ...card('far', 1750.75, 920.25, 300, 200), sectionIndex: 2 },
  ];
  const links: CanvasSceneLink[] = [
    { id: 'long', from: 'child', to: 'far', label: '中文关系🙂'.repeat(100), hiddenEndpoint: false },
    { id: 'loop', from: 'root', to: 'root', label: '自我关系', hiddenEndpoint: false },
  ];
  const before = structuredClone({ cards, links });
  const actual = buildCanvasExportScene(cards, links);
  const preflight = preflightCanvasExport(cards, links);

  assert.deepEqual(preflight, { width: 6160, height: 1537, visibleCardCount: 3, linkCount: 2, hiddenCardCount: 0, allowed: true, reason: null });
  assert.deepEqual({ width: preflight.width, height: preflight.height }, assertCanvasExportSize(actual.bounds));
  assert.match(canvasSceneToSvg(actual), /^<svg[^>]+width="6160" height="1537"/);
  assert.ok(actual.bounds.x < -2100, 'the full long label extends well beyond the leftmost card');
  assert.ok(actual.bounds.y < -340, 'the self-loop above its card must be included');
  assert.deepEqual({ cards, links }, before, 'preflight must not change card coordinates or link metadata');

  const padded = preflightCanvasExport(cards, links, { padding: 96 });
  assert.equal(padded.width, preflight.width + 96);
  assert.equal(padded.height, preflight.height + 96);
  assert.deepEqual({ width: padded.width, height: padded.height }, assertCanvasExportSize(buildCanvasExportScene(cards, links, { padding: 96 }).bounds));
});

test('preflight counts folded descendants once and includes links projected to a visible ancestor', async () => {
  const content = '# Parent\n\n## Child\n\n### Grandchild\n\n# Other\n';
  const bytes = new TextEncoder().encode(content);
  let nextId = 0;
  const reconciled = await reconcileCanvasStateV2(null, {
    content, bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
  }, () => `card-${nextId++}`);
  const model = {
    ...reconciled.model,
    cards: reconciled.model.cards.map((entry, index) => ({ ...entry, descendantsCollapsed: index < 2 })),
    links: [
      { id: 'external', from: 'card-2', to: 'card-3', label: '分支关系' },
      { id: 'internal', from: 'card-1', to: 'card-2', label: '内部关系' },
    ],
  };
  const scene = buildCanvasSceneV2(content, extractSections(content), model, reconciled.bindings);
  const result = preflightCanvasExport(scene.cards, scene.links);

  assert.equal(result.visibleCardCount, 2);
  assert.equal(result.hiddenCardCount, 2);
  assert.equal(result.linkCount, 2);
  assert.equal(result.allowed, true);
  assert.equal(result.reason, null);
  assert.deepEqual(scene.links.map(({ from, to, hiddenEndpoint }) => ({ from, to, hiddenEndpoint })), [
    { from: 'card-0', to: 'card-3', hiddenEndpoint: true },
    { from: 'card-0', to: 'card-0', hiddenEndpoint: true },
  ]);
  const actual = buildCanvasExportScene(scene.cards, scene.links);
  assert.equal(result.width, actual.bounds.width);
  assert.equal(result.height, actual.bounds.height);
  assert.match(actual.links[0].displayLabel, /隐藏端点/);
});

test('preflight retains the full over-limit dimensions and the same refusal reason as export', () => {
  for (const { cards, width, height } of [
    { cards: [card('a'), card('distant', 12001, 0)], width: 12401, height: 280 },
    { cards: [card('a'), card('diagonal', 6200, 6200)], width: 6600, height: 6480 },
  ]) {
    const result = preflightCanvasExport(cards, []);
    assert.equal(result.allowed, false);
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.equal(result.visibleCardCount, 2);
    assert.equal(result.hiddenCardCount, 0);
    assert.match(result.reason!, new RegExp(`${width} × ${height}`));
    assert.match(result.reason!, /12000 px、40 MP/);
    assert.throws(() => assertCanvasExportSize(buildCanvasExportScene(cards, []).bounds), { message: result.reason! });
  }
});

test('preflight counts only routes present in the export and preserves the empty-scene contract', () => {
  const cards = [card('visible'), { ...card('hidden', 50000, 50000), hidden: true }];
  const links: CanvasSceneLink[] = [
    { id: 'hidden', from: 'visible', to: 'hidden', label: '隐藏', hiddenEndpoint: false },
    { id: 'missing', from: 'visible', to: 'missing', label: '丢失', hiddenEndpoint: false },
  ];
  assert.deepEqual(preflightCanvasExport(cards, links), {
    width: 400, height: 280, visibleCardCount: 1, hiddenCardCount: 1, linkCount: 0, allowed: true, reason: null,
  });
  assert.deepEqual(preflightCanvasExport([], []), {
    width: 1, height: 1, visibleCardCount: 0, hiddenCardCount: 0, linkCount: 0, allowed: true, reason: null,
  });
});

test('preflight does not disguise an invalid hierarchy or invalid geometry as a size warning', () => {
  assert.throws(() => preflightCanvasExport([{ ...card('a'), parentId: 'missing' }], []), /Missing export parent/);
  assert.throws(() => preflightCanvasExport([card('a', Infinity)], []), /Invalid export geometry/);
  assert.throws(() => preflightCanvasExport([card('a')], [], { padding: -1 }), /Invalid export padding/);
});
