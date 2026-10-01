import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { arrangeCanvas, buildCanvasScene } from '../src/core/canvas-scene.ts';
import { extractSections } from '../src/core/sections.ts';

const targetBytes = 5 * 1024 * 1024;
const headingCount = 1000;
const visibleCardCount = 200;
const chunks = [];
for (let index = 0; index < headingCount; index += 1) {
  chunks.push(`# Heading ${index}\n`);
  chunks.push(`Body ${index}: ${'performance '.repeat(400)}\n`);
}
let source = chunks.join('');
while (Buffer.byteLength(source) < targetBytes) source += 'padding text for the five mib benchmark. ';
source = source.slice(0, targetBytes);
const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');

function mark(label, startedAt, samples) {
  samples.push({ label, elapsedMs: Number((performance.now() - startedAt).toFixed(2)), rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2)) });
}

const samples = [];
let startedAt = performance.now();
const tree = extractSections(source);
mark('extractSections', startedAt, samples);
const cards = tree.sections.slice(0, visibleCardCount).map((section, index) => ({
  id: `card-${index}`,
  anchor: { kind: 'heading', basisSha256: sourceSha256, titlePath: [section.title], depth: section.depth, startByte: 0, endByte: 1, headingExact: '#', bodySha256: '0'.repeat(64) },
  position: { x: index * 8, y: index * 4 },
  collapsed: false,
}));
const bindings = cards.map((card, index) => ({ id: card.id, sectionIndex: index, kind: 'heading' }));
const state = { schemaVersion: 1, source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, cards, links: [], viewport: { x: 0, y: 0, zoom: 1 } };
startedAt = performance.now();
const scene = buildCanvasScene(tree, state, bindings);
mark('buildCanvasScene', startedAt, samples);
startedAt = performance.now();
const arranged = await arrangeCanvas(tree, state, bindings);
mark('arrangeCanvas', startedAt, samples);
console.log(JSON.stringify({
  status: 'passed',
  sourceBytes: Buffer.byteLength(source),
  headings: tree.sections.length,
  visibleCards: scene.cards.filter((card) => !card.hidden).length,
  arrangedCards: arranged.cards.length,
  samples,
  peakObservedRssMiB: Math.max(...samples.map((sample) => sample.rssMiB)),
}, null, 2));
