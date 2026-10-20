import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareCanvas, preparedCanvasContent } from '../../src/core/canvas-preparation.ts';
import { canvasCardContent, createCanvasCardContentCache } from '../../src/core/canvas-card-content.ts';
import { reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { extractSections } from '../../src/core/sections.ts';

function ids(prefix = 'c') { let id = 0; return () => `${prefix}-${id++}`; }
test('background preparation preserves anchors, ambiguity, text and scene across structured cloning', async () => {
  for (const source of ['', '全文😀é', '---\ntitle: x\n---\n前言\n# 重复\n**强调** [x][ref]\n## 子节\n```md\n# code\n```\n# 重复\n重复正文\n\n[ref]: /target\n',
    '标题\r\n====\r\n\r\n|a|b|\r\n|-|-|\r\n|中|😀|\r\n> # quoted\r\n\r\n# End\r\n<script>unsafe</script>\r\n']) {
    for (const bom of [0, 3] as const) {
      const bytes = Buffer.from((bom ? '\uFEFF' : '') + source);
      const input = { content: source, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
      const original = await reconcileCanvasStateV2(null, input, ids());
      const first = original.model.cards[0];
      const previous = { ...original.model, cards: [...original.model.cards.map(card => ({ ...card, bodyDisplay: 'full' as const,
        position: { x: 90, y: 70 }, descendantsCollapsed: true })), ...(first ? [{ ...first, id: 'duplicate' }] : [])] };
      const expected = await reconcileCanvasStateV2(previous, input, ids('new'));
      const prepared = structuredClone(await prepareCanvas(source, bom, previous, ids('new')));
      assert.deepEqual(prepared.reconciled, expected);
      assert.deepEqual(prepared.tree, extractSections(source));
      const cache = preparedCanvasContent(source, prepared);
      for (const binding of expected.bindings) assert.deepEqual(cache.get(binding.sectionIndex), canvasCardContent(source, prepared.tree, binding.sectionIndex));
      assert.deepEqual(buildCanvasSceneV2(source, prepared.tree, expected.model, expected.bindings, {}, cache),
        buildCanvasSceneV2(source, prepared.tree, expected.model, expected.bindings, {}, createCanvasCardContentCache(source, prepared.tree)));
    }
  }
});

test('hydrated content has no parsing fallback and cannot be poisoned by caller mutations', async () => {
  const prepared = await prepareCanvas('# A\nbody\n', 0, null, ids());
  const cache = preparedCanvasContent('# A\nbody\n', prepared);
  Object.assign(prepared.contents[0][1], { summary: 'poison' });
  assert.equal(cache.get(0).summary, 'body');
  assert.throws(() => Object.assign(cache.get(0), { summary: 'changed' }));
  assert.throws(() => cache.get(100));
  assert.throws(() => preparedCanvasContent('other source', prepared));
  assert.throws(() => preparedCanvasContent('# A\nbody\n', { ...prepared, contents: [] }));
});
