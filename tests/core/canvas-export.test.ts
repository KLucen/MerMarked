import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCanvasExportSize, buildCanvasExportScene, canvasSceneToSvg } from '../../src/core/canvas-export.ts';

test('export bounds include nested cards, offscreen cards, arrows and labels', () => {
  const scene = buildCanvasExportScene([
    { id: 'root', sectionIndex: 0, hidden: false, width: 300, height: 200, hiddenDescendants: 0, position: { x: -400, y: -180 } },
    { id: 'child', sectionIndex: 1, parentId: 'root', hidden: false, width: 500, height: 280, hiddenDescendants: 0, position: { x: 330, y: 210 } },
    { id: 'far', sectionIndex: 2, hidden: false, width: 300, height: 160, hiddenDescendants: 0, position: { x: 900, y: 800 } },
  ], [{ id: 'edge', from: 'child', to: 'far', label: '跨层关系', hiddenEndpoint: false }], { padding: 32 });
  assert.ok(scene.bounds.x <= -432);
  assert.ok(scene.bounds.width >= 1600);
  assert.ok(scene.bounds.height >= 1250);
  const svg = canvasSceneToSvg(scene);
  assert.match(svg, /跨层关系/);
  assert.match(svg, /data-card="root"/);
  assert.match(svg, /marker-end/);
});

test('export escapes user labels and remains nonempty for an empty scene', () => {
  const scene = buildCanvasExportScene([], []);
  const svg = canvasSceneToSvg(scene, { background: '#fff' });
  assert.match(svg, /width="1" height="1"/);
  const labeled = buildCanvasExportScene([{ id: 'x&<>', sectionIndex: null, hidden: false, width: 10, height: 10, hiddenDescendants: 0, position: { x: 0, y: 0 } }], [{ id: 'l', from: 'x&<>', to: 'x&<>', label: '<danger>' }]);
  assert.doesNotMatch(canvasSceneToSvg(labeled), /<danger>/);
});

test('export rejects cyclic parents and unsafe single-file dimensions', () => {
  assert.throws(() => buildCanvasExportScene([
    { id: 'a', sectionIndex: 0, parentId: 'b', hidden: false, width: 100, height: 100, hiddenDescendants: 0, position: { x: 0, y: 0 } },
    { id: 'b', sectionIndex: 1, parentId: 'a', hidden: false, width: 100, height: 100, hiddenDescendants: 0, position: { x: 0, y: 0 } },
  ], []), /Cyclic export hierarchy/);
  assert.throws(() => assertCanvasExportSize({ x: 0, y: 0, width: 12_001, height: 100 }), /超出单文件导出上限/);
});

test('export SVG uses verified card content and a routed label box', () => {
  const scene = buildCanvasExportScene([
    { id: 'a', sectionIndex: 0, hidden: false, width: 300, height: 180, hiddenDescendants: 0, position: { x: 0, y: 0 } },
    { id: 'b', sectionIndex: 1, hidden: false, width: 300, height: 180, hiddenDescendants: 0, position: { x: 700, y: 240 } },
  ], [{ id: 'link', from: 'a', to: 'b', label: '中文长标签', hiddenEndpoint: false }]);
  const svg = canvasSceneToSvg(scene, {}, new Map([
    ['a', { title: '真实章节', summary: '正文摘要', childCount: 1 }],
    ['b', { title: '目标章节', summary: '目标正文', childCount: 0 }],
  ]));
  assert.match(svg, /真实章节/);
  assert.match(svg, /正文摘要/);
  assert.match(svg, /中文长标签/);
  assert.match(svg, /<rect[^>]+rx="4"/);
});
