import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildSelectionMap, resolveSelection } from '../../src/core/selection-map.ts';

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
