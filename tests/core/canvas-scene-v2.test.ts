import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { extractSections } from '../../src/core/sections.ts';

function source(content: string) {
  const bytes = new TextEncoder().encode(content);
  return { bytes, content, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('v2 scene keeps parent content position independent from its child group', async () => {
  const input = source('# Parent\nParent body\n\n## Child\nChild body\n');
  const reconciled = await reconcileCanvasStateV2(null, input, (() => { let index = 0; return () => `card-${index++}`; })());
  const migrated = reconciled.model;
  const model = {
    ...migrated,
    cards: migrated.cards.map((card, index) => index === 0
      ? { ...card, contentPosition: { x: 190, y: 76 }, bodyDisplay: 'full' as const }
      : card),
  };
  const scene = buildCanvasSceneV2(input.content, extractSections(input.content), model, reconciled.bindings);
  const parent = scene.cards.find((card) => card.id === 'card-0')!;
  const child = scene.cards.find((card) => card.id === 'card-1')!;
  assert.equal(child.parentId, 'card-0');
  assert.deepEqual(parent.contentPosition, { x: 190, y: 76 });
  assert.equal(scene.contents.find((card) => card.cardId === 'card-0')?.bodyDisplay, 'full');
  assert.ok(parent.width >= 190 + 328);
});

test('v2 scene hides descendants through the parent fold while retaining link endpoints', async () => {
  const input = source('# Parent\n\n## Child\n\n### Grandchild\n');
  const reconciled = await reconcileCanvasStateV2(null, input, (() => { let index = 0; return () => `card-${index++}`; })());
  const migrated = reconciled.model;
  const model = {
    ...migrated,
    cards: migrated.cards.map((card, index) => index === 0 ? { ...card, descendantsCollapsed: true } : card),
    links: [{ id: 'link-1', from: 'card-2', to: 'card-0', label: '归纳' }],
  };
  const scene = buildCanvasSceneV2(input.content, extractSections(input.content), model, reconciled.bindings);
  assert.equal(scene.cards.find((card) => card.id === 'card-1')?.hidden, true);
  assert.equal(scene.cards.find((card) => card.id === 'card-2')?.hidden, true);
  assert.deepEqual(scene.links[0], { id: 'link-1', from: 'card-0', to: 'card-0', label: '归纳', hiddenEndpoint: true });
});
