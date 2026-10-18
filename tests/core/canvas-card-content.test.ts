import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { toString } from 'mdast-util-to-string';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { canvasCardContent, createCanvasCardContentCache } from '../../src/core/canvas-card-content.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { extractSections, type SectionTree } from '../../src/core/sections.ts';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter);

// Original standalone chapter projection: keep reference/HTML/block behavior,
// including code-point truncation, independently of the new cache/excerpt path.
function legacy(content: string, tree: SectionTree, index: number | null) {
  const section = index === null ? null : tree.sections[index];
  const range = section?.directContentRange ?? tree.virtualCard?.sourceRange;
  const root = processor.parse(range ? content.slice(range.start, range.end) : '');
  root.children = root.children.filter(node => !['html', 'definition', 'yaml'].includes(node.type));
  const fullText = toString(root).replace(/\s+/g, ' ').trim();
  return { title: section?.title ?? (tree.virtualCard?.kind === 'preamble' ? '文档前言' : '全文'),
    summary: Array.from(fullText).slice(0, 160).join(''), fullText, childCount: section?.childIndexes.length ?? 0 };
}

test('cached card content preserves standalone chapter semantics and Unicode excerpts', () => {
  for (const content of ['', '无标题 😀\r\n\r\n正文',
    '---\ntitle: metadata\n---\n\n前言 **中文**\n\n# Same\n\n[本节引用][ref]\n\n[ref]: https://example.com\n\n## Same\n\n[其他章节引用][ref]\n',
    '# 标题\r\n\r\n> 引文 **强调**\r\n\r\n- 列表\r\n- [x] 任务\r\n\r\n| A | B |\r\n| - | - |\r\n| 中 | 😀 |\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n<div>隐藏 HTML</div>\r\n',
    '标题\n====\n\n' + 'a'.repeat(159) + '😀' + 'é👨‍👩‍👧‍👦'.repeat(10_000)]) {
    const tree = extractSections(content);
    const cache = createCanvasCardContentCache(content, tree);
    for (const index of [...(tree.virtualCard ? [null] : []), ...tree.sections.map(section => section.index)]) {
      assert.deepEqual(canvasCardContent(content, tree, index), legacy(content, tree, index));
      assert.deepEqual(cache.get(index), legacy(content, tree, index));
      assert.equal(cache.get(index), cache.get(index));
      assert.ok(Object.isFrozen(cache.get(index)));
    }
  }
});

test('card cache cannot cross source or tree snapshots after same-heading body edits', async () => {
  const content = '# Same\n\nold body\n';
  const tree = extractSections(content);
  const cache = createCanvasCardContentCache(content, tree);
  const next = content.replace('old', 'new');
  assert.equal(createCanvasCardContentCache(next, extractSections(next)).get(0).fullText, 'new body');
  assert.equal(cache.get(0).fullText, 'old body');
  const bytes = new TextEncoder().encode(content);
  const result = await reconcileCanvasStateV2(null, { content, bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.throws(() => buildCanvasSceneV2(next, tree, result.model, result.bindings, {}, cache), /different source/);
  assert.throws(() => buildCanvasSceneV2(content, extractSections(content), result.model, result.bindings, {}, cache), /different source/);
});

test('cached scenes equal uncached scenes through moves, folding, sizing and hidden links', async () => {
  const content = '前言\n\n# Parent\n\n父正文\n\n## Child\n\n子正文😀\n\n### Grandchild\n\n后代\n\n# Other\n\n其他\n';
  const tree = extractSections(content);
  const bytes = new TextEncoder().encode(content);
  let id = 0;
  const { model, bindings } = await reconcileCanvasStateV2(null, { content, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }, () => `card-${id++}`);
  const before = structuredClone(model);
  const cache = createCanvasCardContentCache(content, tree);
  for (const collapsed of [false, true]) for (const bodyDisplay of ['preview', 'full', 'hidden'] as const) {
    const candidate = { ...model,
      cards: model.cards.map((card, index) => ({ ...card, descendantsCollapsed: collapsed, bodyDisplay,
        position: { x: index * 400, y: index * 50 }, contentPosition: { x: 30, y: 60 }, size: { width: 400, height: 240 } })),
      links: [{ id: 'link', from: 'card-3', to: 'card-4', label: '后代与其他' }] };
    const heights = { 'card-1': 320 };
    assert.deepEqual(buildCanvasSceneV2(content, tree, candidate, bindings, heights, cache),
      buildCanvasSceneV2(content, tree, candidate, bindings, heights));
  }
  assert.deepEqual(model, before);
});
