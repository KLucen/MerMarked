import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyDragOutPromotion,
  evaluateDragOutPromotion,
  findCanvasOverlapCandidate,
  isCanvasStructureTargetAllowed,
  measureCanvasOverlap,
  updateCanvasOverlapDwell,
} from '../../src/core/canvas-structure-candidates.ts';
import { extractSections } from '../../src/core/sections.ts';

test('measures overlap against both card rectangles and the smaller-card ratio', () => {
  const metrics = measureCanvasOverlap({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 25, width: 100, height: 100 });
  assert.equal(metrics.intersectionArea, 3_750);
  assert.equal(metrics.sourceCoverage, 0.375);
  assert.equal(metrics.targetCoverage, 0.375);
  assert.equal(metrics.overlapRatio, 0.375);
  assert.deepEqual(metrics.intersection, { x: 50, y: 25, width: 50, height: 75 });
});

test('picks the strongest eligible target and excludes the dragged card itself', () => {
  const source = { id: 'source', rect: { x: 0, y: 0, width: 100, height: 100 } };
  const target = findCanvasOverlapCandidate(source, [
    source,
    { id: 'weak', rect: { x: 75, y: 75, width: 100, height: 100 } },
    { id: 'strong', rect: { x: 40, y: 40, width: 100, height: 100 } },
  ], { minimumRatio: 0.2, readyRatio: 0.3 });
  assert.equal(target?.targetId, 'strong');
  assert.equal(target?.status, 'ready');
  assert.equal(findCanvasOverlapCandidate(source, [{ ...source }]), null);
});

test('semantic target guard excludes self, current parent, and descendants before highlighting', () => {
  const tree = extractSections('# Parent\n## Child\n### Grandchild\n# Peer\n');
  assert.equal(isCanvasStructureTargetAllowed(tree, 1, 1), false);
  assert.equal(isCanvasStructureTargetAllowed(tree, 1, 0), false);
  assert.equal(isCanvasStructureTargetAllowed(tree, 1, 2), false);
  assert.equal(isCanvasStructureTargetAllowed(tree, 1, 3), true);
});

test('requires stable identity and dwell before an overlap becomes ready', () => {
  const source = { id: 'source', rect: { x: 0, y: 0, width: 100, height: 100 } };
  const candidate = findCanvasOverlapCandidate(source, [{ id: 'target', rect: { x: 25, y: 25, width: 100, height: 100 } }], {
    minimumRatio: 0.2, readyRatio: 0.4, dwellMs: 300,
  });
  assert.ok(candidate);
  const first = updateCanvasOverlapDwell(null, candidate, 1_000, { readyRatio: 0.4, dwellMs: 300 });
  assert.equal(first.status, 'candidate');
  const changedTarget = findCanvasOverlapCandidate(source, [{ id: 'other', rect: { x: 25, y: 25, width: 100, height: 100 } }], { minimumRatio: 0.2 });
  assert.equal(updateCanvasOverlapDwell(first.state, changedTarget, 1_400, { readyRatio: 0.4, dwellMs: 300 }).dwellMs, 0);
  const ready = updateCanvasOverlapDwell(first.state, candidate, 1_300, { readyRatio: 0.4, dwellMs: 300 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.dwellMs, 300);
  assert.equal(updateCanvasOverlapDwell(first.state, null, 1_400).status, 'none');
});

test('dragging a nested card outside its parent previews an independent top-level promotion', () => {
  const tree = extractSections('# Parent\n## Child\nchild\n### Grandchild\nbody\n# Other\n');
  const sample = evaluateDragOutPromotion(tree, 1, { x: 180, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 });
  assert.ok(sample);
  assert.equal(sample.parentIndex, 0);
  assert.equal(sample.escapeRatio, 1);
  assert.deepEqual(sample.operation, { kind: 'promote', sectionIndex: 1, targetDepth: 1 });
  const classified = classifyDragOutPromotion(sample, null, 'child-card', 500, { dwellMs: 250 });
  assert.equal(classified.status, 'candidate');
  const ready = classifyDragOutPromotion(sample, classified.state, 'child-card', 750, { dwellMs: 250 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.candidate?.operation.targetDepth, 1);
});

test('drag-out can request a one-level promotion and ignores already independent cards', () => {
  const tree = extractSections('# Parent\n## Child\n### Grandchild\n');
  const sample = evaluateDragOutPromotion(tree, 2, { x: 90, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, { destination: 'one-level' });
  assert.ok(sample);
  assert.equal(sample.operation.targetDepth, 2);
  assert.equal(evaluateDragOutPromotion(tree, 0, { x: 90, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }), null);
  assert.equal(evaluateDragOutPromotion(tree, 2, { x: 90, y: 0, width: 0, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }), null);
});

test('invalid threshold values are rejected instead of silently creating a command', () => {
  const source = { id: 'source', rect: { x: 0, y: 0, width: 10, height: 10 } };
  assert.throws(() => findCanvasOverlapCandidate(source, [], { minimumRatio: 2 }), /阈值无效/);
  assert.throws(() => updateCanvasOverlapDwell(null, null, -1), /停留时间无效/);
});
