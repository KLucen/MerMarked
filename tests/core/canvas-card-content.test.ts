import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canvasCardContent, canvasContentsFromSnapshot, createCanvasCardContentCache } from '../../src/core/canvas-card-content.ts';
import { parseMarkdownSnapshot } from '../../src/core/markdown-snapshot.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { reconcileCanvasStateV2 } from '../../src/core/canvas-state-v2.ts';
import { extractSections } from '../../src/core/sections.ts';

test('card text retains blocks, list levels and task state, table cells and code indentation', () => {
  const content = '\uFEFF' + [
    '# 标题', '', '第一段 **重点**与[链接](/url)。', '', '第二段  ', '手动换行', '',
    '3. 首项', '   - [x] 子任务', '   - [ ] 继续', '4. 末项', '', '- 列表一', '- 列表二', '',
    '| 项目 | 数值 |', '| - | - |', '| 单价 | 12 |', '| | 😀 |', '',
    '```js', '  const value = 1;', '\treturn value;', '```',
  ].join('\r\n');
  const tree = extractSections(content);
  const expected = [
    '第一段 重点与链接。', '', '第二段', '手动换行', '',
    '3. 首项', '  • ☑ 子任务', '  • ☐ 继续', '4. 末项', '', '• 列表一', '• 列表二', '',
    '项目 │ 数值', '单价 │ 12', ' │ 😀', '', '  const value = 1;', '\treturn value;',
  ].join('\n');
  const card = canvasCardContent(content, tree, 0);
  assert.deepEqual(card, { title: '标题', summary: expected, fullText: expected, childCount: 0 });
  assert.deepEqual(new Map(canvasContentsFromSnapshot(parseMarkdownSnapshot(content), tree)).get(0), card);
});

test('card projection omits hidden payloads without mutating the shared parser tree', () => {
  const content = '\uFEFF---\ntitle: HIDDEN_YAML\n---\n\n前言\n\n# 章节\n\n' +
    'A <b>bold</b><br> tail\n\n> <iframe>\n>\n> HIDDEN_RAW_SUBTREE\n>\n> </iframe>\n\n' +
    'Before <script>HIDDEN_INLINE_SCRIPT</script> After\n\n<div>HIDDEN_RAW_BLOCK</div>\n\n' +
    'Text[^note]\n\n[^note]: HIDDEN_FOOTNOTE\n\n[ref]: /HIDDEN_DEFINITION';
  const tree = extractSections(content);
  const snapshot = parseMarkdownSnapshot(content);
  const before = structuredClone(snapshot.root);
  const shared = new Map(canvasContentsFromSnapshot(snapshot, tree));
  assert.deepEqual(snapshot.root, before);
  assert.equal(shared.get(null)?.fullText, '前言');
  assert.equal(shared.get(0)?.fullText, 'A bold\ntail\n\nBefore After\n\nText');
  assert.deepEqual(shared.get(0), canvasCardContent(content, tree, 0));
  // Exercise the shared AST directly as well as the definition-sensitive fallback.
  const withoutDefinitions = content.slice(0, content.indexOf('\n\nText[^note]'));
  const sharedHtmlSnapshot = parseMarkdownSnapshot(withoutDefinitions);
  const sharedHtmlBefore = structuredClone(sharedHtmlSnapshot.root);
  const sharedHtml = new Map(canvasContentsFromSnapshot(sharedHtmlSnapshot, extractSections(withoutDefinitions)));
  assert.equal(sharedHtml.get(0)?.fullText, 'A bold\ntail\n\nBefore After');
  assert.deepEqual(sharedHtmlSnapshot.root, sharedHtmlBefore);
});

test('cached card content preserves standalone chapter semantics and Unicode excerpts', () => {
  for (const content of ['', '无标题 😀\r\n\r\n正文',
    '---\ntitle: metadata\n---\n\n前言 **中文**\n\n# Same\n\n[本节引用][ref]\n\n[ref]: https://example.com\n\n## Same\n\n[其他章节引用][ref]\n',
    '# 标题\r\n\r\n> 引文 **强调**\r\n\r\n- 列表\r\n- [x] 任务\r\n\r\n| A | B |\r\n| - | - |\r\n| 中 | 😀 |\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n<div>隐藏 HTML</div>\r\n',
    '标题\n====\n\n' + 'a'.repeat(159) + '😀' + 'é👨‍👩‍👧‍👦'.repeat(10_000)]) {
    const tree = extractSections(content);
    const cache = createCanvasCardContentCache(content, tree);
    const shared = new Map(canvasContentsFromSnapshot(parseMarkdownSnapshot(content), tree));
    for (const index of [...(tree.virtualCard ? [null] : []), ...tree.sections.map(section => section.index)]) {
      const standalone = canvasCardContent(content, tree, index);
      assert.deepEqual(shared.get(index), standalone);
      assert.deepEqual(cache.get(index), standalone);
      assert.equal(standalone.summary, Array.from(standalone.fullText ?? '').slice(0, 160).join(''));
      assert.equal(cache.get(index), cache.get(index));
      assert.ok(Object.isFrozen(cache.get(index)));
    }
  }
});

test('shared parser card text keeps fragment reference, HTML, frontmatter and block boundaries', () => {
  const fragments = [
    '[link][ref]\n\n![image][ref]\n\n[ref]: /here\n',
    '[link][ref]\n\nText[^note]\n',
    '[^note]: footnote\n\n[ref]: /there\n',
    '> [inside][ref]\n\n- [list][ref]\n',
    '<div>\n# raw heading\n</div>\n\nA <b>bold</b> tail\n',
    '---\nx: y\n---\n',
    '```md\n# fenced\n```\n\n    # indented\n',
    'line  \nbreak\n\n- [x] task\n\n|a|b|\n|-|-|\n|中|😀|\n',
    'plain😀é\n\nanother paragraph\n',
  ];
  for (const first of fragments) for (const second of fragments) for (const bom of ['', '\uFEFF']) {
    const content = bom + '---\ntitle: metadata\n---\n\nPreamble\n\n# A\n\n' + first + '\n# B\n\n' + second;
    const snapshot = parseMarkdownSnapshot(content);
    const tree = extractSections(content);
    for (const [index, card] of canvasContentsFromSnapshot(snapshot, tree)) {
      assert.deepEqual(card, canvasCardContent(content, tree, index), `fragment projection ${JSON.stringify(content)}`);
    }
  }
  const referenceSource = '# A\n\n[link][ref]\n\n![image][ref]\n\n[ref]: /here\n\n# B\n\n[link][ref]\n';
  const referenceCards = new Map(canvasContentsFromSnapshot(parseMarkdownSnapshot(referenceSource), extractSections(referenceSource)));
  assert.equal(referenceCards.get(0)?.fullText, 'link\n\nimage');
  assert.equal(referenceCards.get(1)?.fullText, '[link][ref]');
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
  assert.throws(() => buildCanvasSceneV2(next, tree, result.model, result.bindings, cache), /different source/);
  assert.throws(() => buildCanvasSceneV2(content, extractSections(content), result.model, result.bindings, cache), /different source/);
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
    assert.deepEqual(buildCanvasSceneV2(content, tree, candidate, bindings, cache),
      buildCanvasSceneV2(content, tree, candidate, bindings));
  }
  assert.deepEqual(model, before);
});
