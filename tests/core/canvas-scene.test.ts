import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { arrangeCanvas, buildCanvasScene } from '../../src/core/canvas-scene.ts';
import { reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { extractSections } from '../../src/core/sections.ts';

async function fixture() {
  const content = '# A\nroot\n## B\nchild\n### C\ngrand\n# D\npeer\n';
  const bytes = Buffer.from(content);
  const source = { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  let next = 0;
  const reconciled = await reconcileCanvasState(null, source, () => `card-${next++}`);
  return { ...reconciled, tree: extractSections(content) };
}

test('ELK produces nested relative positions and complete enclosing sizes without writing source', async () => {
  const { model, bindings, tree } = await fixture();
  const arranged = await arrangeCanvas(tree, model, bindings);
  const scene = buildCanvasScene(tree, arranged, bindings);
  for (const card of scene.cards) if (card.parentId) {
    const parent = scene.cards.find((entry) => entry.id === card.parentId)!;
    assert.ok(card.position.x >= 24 && card.position.y >= 150);
    assert.ok(card.position.x + card.width <= parent.width);
    assert.ok(card.position.y + card.height <= parent.height);
  }
  assert.ok(scene.cards[3].position.x >= scene.cards[0].width + 36);
  assert.deepEqual(model.cards.map((card) => card.position), Array.from({ length: 4 }, () => ({ x: 0, y: 0 })));
});

test('folds hide all descendants and project arrow endpoints onto visible ancestors while retaining original endpoints', async () => {
  const { model, bindings, tree } = await fixture();
  const folded = { ...model, cards: model.cards.map((card, index) => ({ ...card, collapsed: index === 0 })),
    links: [{ id: 'arrow', from: 'card-2', to: 'card-3', label: 'relation' }] };
  const scene = buildCanvasScene(tree, folded, bindings);
  assert.deepEqual(scene.cards.map((card) => card.hidden), [false, true, true, false]);
  assert.equal(scene.cards[0].hiddenDescendants, 2);
  assert.equal(scene.links[0].from, 'card-0');
  assert.equal(scene.links[0].hiddenEndpoint, true);
  assert.equal(folded.links[0].from, 'card-2');
});

test('reordered bindings still measure children before parents', async () => {
  const { model, bindings, tree } = await fixture();
  const arranged = await arrangeCanvas(tree, model, bindings);
  assert.deepEqual(buildCanvasScene(tree, arranged, bindings), buildCanvasScene(tree, arranged, [...bindings].reverse()));
});

test('actual text measurements keep children below long parent titles and expand containing bounds', async () => {
  const { model, bindings, tree } = await fixture();
  const measured = { 'card-0': 500, 'card-1': 300 };
  const arranged = await arrangeCanvas(tree, model, bindings, measured);
  const scene = buildCanvasScene(tree, arranged, bindings, measured);
  assert.ok(scene.cards[1].position.y >= 500);
  assert.ok(scene.cards[2].position.y >= 300);
  assert.ok(scene.cards[0].height >= scene.cards[1].height + 500);
});
