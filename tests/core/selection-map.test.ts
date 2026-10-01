import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSelectionMap,
  resolveSelection,
  resolveStoredHighlight,
  type SelectionMap,
} from '../../src/core/selection-map.ts';

const fixturePath = new URL('../fixtures/reader/selection-mapping.md', import.meta.url);

async function fixture() {
  const bytes = await readFile(fixturePath);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { bytes, map: buildSelectionMap(content, 3) };
}

test('maps repeated text and UTF-8 content to exact original BOM + CRLF byte ranges', async () => {
  const { bytes, map } = await fixture();
  const cases = [
    { text: '普通文本', occurrence: 0, bytes: [33, 45] },
    { text: '重复词', occurrence: 0, bytes: [88, 97] },
    { text: '重复词', occurrence: 1, bytes: [109, 118] },
    { text: '加粗内容', occurrence: 0, bytes: [163, 175] },
    { text: '链接文字', occurrence: 0, bytes: [181, 193] },
    { text: '😀', occurrence: 0, bytes: [242, 246] },
    { text: 'é', occurrence: 0, bytes: [262, 265] },
  ] as const;

  for (const entry of cases) {
    const block = map.blocks.find((candidate) => candidate.visibleText.includes(entry.text));
    assert.ok(block, entry.text);
    let start = -1;
    for (let index = 0; index <= entry.occurrence; index += 1) {
      start = block.visibleText.indexOf(entry.text, start + 1);
    }
    assert.notEqual(start, -1);
    const result = resolveSelection(map, block.blockStart, start, start + entry.text.length);
    assert.equal(result.ok, true, `${entry.text}: ${result.ok ? '' : result.reason}`);
    if (!result.ok) continue;
    assert.deepEqual([result.startByte, result.endByte], entry.bytes);
    assert.equal(result.displayQuote, entry.text);
    assert.equal(bytes.subarray(result.startByte, result.endByte).toString('utf8'), result.sourceExact);
  }
});

test('a selection across inline markup includes the intervening source syntax', async () => {
  const { bytes, map } = await fixture();
  const block = map.blocks.find((candidate) => candidate.visibleText.includes('跨节点前半段'));
  assert.ok(block);
  const start = block.visibleText.indexOf('跨节点前半段');
  const end = block.visibleText.indexOf('跨节点后半段') + '跨节点后半段'.length;
  const result = resolveSelection(map, block.blockStart, start, end);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.displayQuote, '跨节点前半段 跨节点后半段');
  assert.equal(result.sourceExact, '跨节点前半段 **跨节点后半段');
  assert.equal(bytes.subarray(result.startByte, result.endByte).toString('utf8'), result.sourceExact);
});

test('rejects unsupported inline code and ambiguous interior of escaped text', async () => {
  const { map } = await fixture();
  const block = map.blocks.find((candidate) => candidate.visibleText.includes('跨节点前半段'));
  assert.ok(block);
  const bad = resolveSelection(map, block.blockStart, 0, 0);
  assert.deepEqual(bad.ok, false);

  const unsupported = map.blocks.find((candidate) => !candidate.supported && candidate.reason?.includes('inlineCode'));
  assert.ok(unsupported);
  assert.equal(resolveSelection(map, unsupported.blockStart, 0, 1).ok, false);
  assert.equal(resolveSelection(map, -999, 0, 1).ok, false);
});

test('rejects selections cutting through an emoji surrogate pair or combining sequence', async () => {
  const { map } = await fixture();
  const block = map.blocks.find((candidate) => candidate.visibleText.includes('emoji 😀'));
  assert.ok(block);
  const emojiStart = block.visibleText.indexOf('😀');
  const accentStart = block.visibleText.indexOf('é');
  assert.equal(resolveSelection(map, block.blockStart, emojiStart, emojiStart + 1).ok, false);
  assert.equal(resolveSelection(map, block.blockStart, accentStart, accentStart + 1).ok, false);
});

test('never places a byte boundary inside an entity, escape, or CRLF', () => {
  for (const { source, selected, expected } of [
    { source: 'A &amp; B', selected: '&', expected: null },
    { source: 'A &semi; B', selected: ';', expected: '&semi;' },
    { source: 'A \\* B', selected: '*', expected: '\\*' },
    { source: 'A\r\nB', selected: '\n', expected: null },
  ]) {
    const map = buildSelectionMap(source, 0);
    const block = map.blocks[0];
    const start = block.visibleText.indexOf(selected);
    assert.notEqual(start, -1, source);
    const result = resolveSelection(map, block.blockStart, start, start + selected.length);
    assert.equal(result.ok, expected !== null, source);
    if (result.ok) assert.equal(result.sourceExact, expected);
  }
});

test('maps a plain no-BOM source and checks inconsistent metadata', () => {
  const map = buildSelectionMap('# Hi\n\nPlain 中文 😀', 0);
  const block = map.blocks.find((candidate) => candidate.visibleText === 'Plain 中文 😀');
  assert.ok(block);
  const start = block.visibleText.indexOf('中文');
  const result = resolveSelection(map, block.blockStart, start, start + '中文'.length);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual([result.startByte, result.endByte], [12, 18]);
  assert.throws(() => buildSelectionMap('\uFEFF# Hi', 0), /BOM/);
  assert.throws(() => buildSelectionMap('Hi', 2), /BOM/);
});

function selectedAnchor(map: SelectionMap, quote: string, occurrence = 0) {
  const block = map.blocks.find((candidate) => candidate.supported && candidate.visibleText.includes(quote));
  assert.ok(block, quote);
  let start = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    start = block.visibleText.indexOf(quote, start + 1);
  }
  assert.notEqual(start, -1, quote);
  const anchor = resolveSelection(map, block.blockStart, start, start + quote.length);
  assert.equal(anchor.ok, true, quote);
  if (!anchor.ok) throw new Error(anchor.reason);
  return { block, start, anchor };
}

test('inverts repeated text by exact source bytes rather than first visible occurrence', async () => {
  const { map } = await fixture();
  for (const occurrence of [0, 1]) {
    const { block, start, anchor } = selectedAnchor(map, '重复词', occurrence);
    assert.deepEqual(resolveStoredHighlight(map, anchor), {
      ok: true,
      blockStart: block.blockStart,
      visibleStart: start,
      visibleEnd: start + '重复词'.length,
    });
  }
});

test('inverts formatted ranges and Unicode graphemes with BOM and CRLF offsets', async () => {
  const { bytes, map } = await fixture();
  for (const quote of ['选区映射验收', '加粗内容', '链接文字', '跨节点前半段 跨节点后半段', '😀', 'é']) {
    const { block, start, anchor } = selectedAnchor(map, quote);
    assert.equal(bytes.subarray(anchor.startByte, anchor.endByte).toString('utf8'), anchor.sourceExact);
    assert.deepEqual(resolveStoredHighlight(map, anchor), {
      ok: true,
      blockStart: block.blockStart,
      visibleStart: start,
      visibleEnd: start + quote.length,
    }, quote);
  }
});

test('refuses stale, malformed, unsupported, and ambiguous stored anchors', async () => {
  const { map } = await fixture();
  const { block, anchor } = selectedAnchor(map, '重复词', 1);
  const rejected = [
    { ...anchor, startByte: anchor.startByte - 1 },
    { ...anchor, endByte: anchor.endByte + 1 },
    { ...anchor, sourceExact: '假'.repeat(3) },
    { ...anchor, displayQuote: '其他词' },
    { ...anchor, displayQuote: '复' },
    { ...anchor, startByte: -1 },
  ];
  for (const candidate of rejected) {
    assert.equal(resolveStoredHighlight(map, candidate).ok, false, JSON.stringify(candidate));
  }

  const unsupported = buildSelectionMap('A &amp; B', 0);
  assert.equal(resolveStoredHighlight(unsupported, {
    startByte: 2,
    endByte: 7,
    sourceExact: '&amp;',
    displayQuote: '&',
  }).ok, false);

  // If a future mapper exposes two DOM locations for the same source range,
  // refuse to choose one even when every source field is identical.
  assert.equal(resolveStoredHighlight({ ...map, blocks: [...map.blocks, block] }, anchor).ok, false);
});
