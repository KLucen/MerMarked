import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { parseDocumentBundleArchive, BundleArchiveError } from '../../src/core/document-bundle-archive.ts';
import { createSavedDocumentBundle } from '../../src/main/document-bundle-store.ts';

type Entry = { name: string | Uint8Array; data?: Uint8Array };
const content = Buffer.from('\ufeff# 中文 😀\r\n\r\n![图片](images/%E5%9B%BE.png)\r\n');
const source = (data: Uint8Array = content): Entry => ({ name: '原文 😀.md', data });
const image = (name = 'images/图.png', data: Uint8Array = Buffer.from([1, 2, 3])): Entry => ({ name, data });
const MiB = 1024 * 1024;

/** Independent fixture encoder: native zlib supplies CRC, not the parser. */
function archive(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [], records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.data ?? []), checksum = crc32(data);
    const local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(33, 14); record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0x20, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name, data); records.push(record, name); offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(records), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function positions(bytes: Buffer): { end: number; central: number; local: number[]; records: number[] } {
  const end = bytes.length - 22, central = bytes.readUInt32LE(end + 16), count = bytes.readUInt16LE(end + 10);
  const local: number[] = [], records: number[] = []; let position = central;
  for (let i = 0; i < count; i++) {
    records.push(position); local.push(bytes.readUInt32LE(position + 42));
    position += 46 + bytes.readUInt16LE(position + 28);
  }
  return { end, central, local, records };
}
function refused(bytes: Uint8Array): void {
  assert.throws(() => parseDocumentBundleArchive(bytes), error => {
    assert.ok(error instanceof BundleArchiveError);
    assert.equal(error.name, 'BundleArchiveError');
    assert.equal(error.message, new BundleArchiveError().message);
    assert.equal(error.message.includes('原文'), false);
    return true;
  });
}

test('stored UTF-8 bundles retain document BOM/CRLF, companions, image bytes and entry order', () => {
  const yaml = Buffer.from('version: 1\r\n'), canvas = Buffer.from('{"version":1}\n');
  const entries = [source(), { name: '原文 😀.md.annotations.yaml', data: yaml },
    { name: '原文 😀.md.mermarkd.json', data: canvas }, image()];
  const result = parseDocumentBundleArchive(archive(entries));
  assert.equal(result.documentName, '原文 😀.md'); assert.equal(result.imageCount, 1);
  assert.deepEqual(result.files.map(file => [file.path, file.kind]), [
    ['原文 😀.md', 'markdown'], ['原文 😀.md.annotations.yaml', 'annotations'],
    ['原文 😀.md.mermarkd.json', 'canvas'], ['images/图.png', 'image'],
  ]);
  assert.equal(result.totalBytes, entries.reduce((sum, entry) => sum + (entry.data?.length ?? 0), 0));
  result.files.forEach((file, index) => assert.deepEqual(Buffer.from(file.bytes), entries[index].data));
});

test('archives emitted by the FILE1C writer round-trip byte-for-byte', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mermarkd-archive-reader-test-'));
  const sourcePath = path.join(root, '原文 😀.md'), targetPath = path.join(root, 'bundle.zip');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  const yaml = Buffer.from('original: retained\r\n'), canvas = Buffer.from('{"retained":true}\n');
  try {
    await fs.mkdir(path.join(root, 'images'));
    await fs.writeFile(sourcePath, content); await fs.writeFile(sourcePath + '.annotations.yaml', yaml);
    await fs.writeFile(sourcePath + '.mermarkd.json', canvas); await fs.writeFile(path.join(root, 'images', '图.png'), png);
    await createSavedDocumentBundle({ sourcePath, targetPath,
      expectedSourceSha256: createHash('sha256').update(content).digest('hex'),
      planSnapshot: async () => ['images/图.png'], review: async () => {} });
    const result = parseDocumentBundleArchive(await fs.readFile(targetPath));
    assert.equal(result.documentName, '原文 😀.md'); assert.equal(result.imageCount, 1);
    result.files.forEach((file, index) => assert.deepEqual(Buffer.from(file.bytes), [content, yaml, canvas, png][index]));
    assert.deepEqual(await fs.readFile(sourcePath), content);
  } finally {
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('mermarkd-archive-reader-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

test('minimal and unordered bundles allow missing companions and zero images', () => {
  assert.equal(parseDocumentBundleArchive(archive([source(Buffer.alloc(0))])).totalBytes, 0);
  const result = parseDocumentBundleArchive(archive([image('图.JPG'), source(), image('nested/图.JPEG'),
    image('a.GIF'), image('b.WebP')]));
  assert.equal(result.imageCount, 4); assert.equal(result.files[1].kind, 'markdown');
});

test('verified result owns each payload even for Buffer slices', () => {
  const bytes = archive([source(), image()]);
  const wrapper = Buffer.concat([Buffer.alloc(12), bytes, Buffer.alloc(7)]);
  const input = wrapper.subarray(12, 12 + bytes.length), result = parseDocumentBundleArchive(input);
  input.fill(0); assert.deepEqual(Buffer.from(result.files[0].bytes), content);
  result.files[0].bytes.fill(9); assert.deepEqual(Buffer.from(result.files[1].bytes), Buffer.from([1, 2, 3]));
});

test('every truncation refuses rather than accepting a partial archive', () => {
  const bytes = archive([source(), image()]);
  for (let length = 0; length < bytes.length; length++) refused(bytes.subarray(0, length));
});

test('central and local CRCs cannot hide corrupt payloads', () => {
  const bytes = archive([source(), image()]), { central, local } = positions(bytes);
  const corruptData = Buffer.from(bytes); corruptData[30 + corruptData.readUInt16LE(26)] ^= 1; refused(corruptData);
  const corruptBoth = Buffer.from(bytes);
  corruptBoth.writeUInt32LE(0x12345678, local[0] + 14); corruptBoth.writeUInt32LE(0x12345678, central + 16);
  refused(corruptBoth);
});

test('disk, EOCD counts, offsets and comments must describe the exact final archive', () => {
  const bytes = archive([source(), image()]), { end } = positions(bytes);
  for (const [field, width, value] of [[4, 2, 1], [6, 2, 1], [8, 2, 1], [10, 2, 0], [10, 2, 36],
    [12, 4, 0], [16, 4, 0], [16, 4, 0xffffffff], [20, 2, 1]] as const) {
    const changed = Buffer.from(bytes); changed.writeUIntLE(value, end + field, width); refused(changed);
  }
  refused(Buffer.concat([bytes, Buffer.from([0])])); refused(Buffer.concat([Buffer.from([0]), bytes]));
  refused(archive([]));
});

test('central-directory and local data gaps, overlaps and out-of-order offsets refuse', () => {
  const bytes = archive([source(), image()]), { central, records } = positions(bytes);
  for (const value of [0, 1, central - 1, 0xffffffff]) {
    const changed = Buffer.from(bytes); changed.writeUInt32LE(value, records[1] + 42); refused(changed);
  }
  const gap = Buffer.concat([bytes.subarray(0, central), Buffer.from([0]), bytes.subarray(central)]);
  gap.writeUInt32LE(central + 1, gap.length - 6); refused(gap);
  const centralGap = Buffer.concat([bytes.subarray(0, records[1]), Buffer.from([0]), bytes.subarray(records[1])]);
  centralGap.writeUInt32LE(bytes.readUInt32LE(bytes.length - 10) + 1, centralGap.length - 10); refused(centralGap);
});

test('versions, compression, flags, disk numbers and attributes are restricted to the writer dialect', () => {
  const bytes = archive([source()]), { central } = positions(bytes);
  for (const [relative, width, value] of [[4, 2, 0x0314], [6, 2, 45], [8, 2, 0], [8, 2, 0x0801],
    [8, 2, 0x0808], [8, 2, 0x0840], [10, 2, 8], [30, 2, 1], [32, 2, 1], [34, 2, 1],
    [36, 2, 1], [38, 4, 0], [38, 4, 0x10], [38, 4, 0xa1ff0000]] as const) {
    const changed = Buffer.from(bytes); changed.writeUIntLE(value, central + relative, width); refused(changed);
  }
  for (const [relative, value] of [[4, 45], [6, 0], [6, 0x0801], [6, 0x0808], [8, 8], [28, 1]] as const) {
    const changed = Buffer.from(bytes); changed.writeUInt16LE(value, relative); refused(changed);
  }
});

test('all duplicated local/central header fields and name bytes must match', () => {
  const bytes = archive([source()]), { central } = positions(bytes);
  for (const [position, width] of [[10, 2], [12, 2], [14, 4], [18, 4], [22, 4], [26, 2],
    [central + 20, 4], [central + 24, 4], [central + 28, 2]] as const) {
    const changed = Buffer.from(bytes); changed.writeUIntLE(changed.readUIntLE(position, width) + 1, position, width); refused(changed);
  }
  const renamed = Buffer.from(bytes); renamed[30] ^= 1; refused(renamed);
  for (const position of [0, central, bytes.length - 22]) {
    const changed = Buffer.from(bytes); changed[position] ^= 1; refused(changed);
  }
});

test('filename UTF-8 is strict while supplementary characters and a real replacement character are allowed', () => {
  for (const prefix of [[0xc0, 0xaf], [0xff], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
    refused(archive([{ name: Buffer.concat([Buffer.from(prefix), Buffer.from('.md')]) }]));
  }
  assert.equal(parseDocumentBundleArchive(archive([{ name: '\ufeff文😀\ufffd.md' }])).documentName, '\ufeff文😀\ufffd.md');
});

test('zip-slip, absolute, Windows device and nonportable segment names refuse', () => {
  const invalid = ['../secret.png', './a.png', '/a.png', '//server/a.png', 'C:/a.png', 'C:a.png',
    '\\server\\a.png', 'images\\a.png', 'a//b.png', 'a/../b.png', 'a/./b.png', 'a/', '',
    'a\u0000.png', 'a\u001f.png', 'a\u007f.png', 'a\u0085.png', 'a\u009f.png', 'a?.png',
    'a*.png', 'a|.png', 'a:.png', 'a".png', 'a<.png', 'a>.png', 'a. /b.png', 'a./b.png',
    'CON.png', 'PrN.gif', 'aux/a.png', 'nul.webp', 'COM1.png', 'com9/a.png', 'LPT1.jpg',
    'LPT9.png', 'COM¹.png', 'com².png', 'lpt³/a.png'];
  for (const name of invalid) refused(archive([source(), image(name)]));
});

test('duplicate names, case/NFC aliases and file-directory prefix collisions refuse', () => {
  for (const [first, second] of [['a.png', 'a.png'], ['图.PNG', '图.png'], ['é.png', 'e\u0301.png'],
    ['A.png', 'a.PNG/b.png'], ['a.png/b.png', 'A.PNG'], ['Images/a.png', 'images/b.png'],
    ['é/a.png', 'e\u0301/b.png']] as const) refused(archive([source(), image(first), image(second)]));
});

test('exactly one root Markdown and only its exact companion names are allowed', () => {
  const invalid: Entry[][] = [[], [image()], [{ name: 'nested/document.md' }], [source(), { name: 'another.md' }],
    [source(), { name: 'nested/another.md' }], [source(), { name: '原文 😀.annotations.yaml' }],
    [source(), { name: '原文 😀.md.ANNOTATIONS.yaml' }], [source(), { name: 'another.md.mermarkd.json' }],
    [source(), { name: 'nested/原文 😀.md.annotations.yaml' }], [source(), { name: 'readme.txt' }],
    [source(), { name: 'image.svg' }], [source(), { name: '.png' }], [source(), { name: 'nested/.png' }]];
  for (const entries of invalid) refused(archive(entries));
  assert.equal(parseDocumentBundleArchive(archive([{ name: '文.MD' }, { name: '文.MD.annotations.yaml' }])).files[1].kind, 'annotations');
});

test('filename character, segment and UTF-8 byte limits are bounded', () => {
  refused(archive([source(), image('x'.repeat(256) + '.png')]));
  refused(archive([source(), image(Array.from({ length: 9 }, () => 'a'.repeat(240)).join('/') + '.png')]));
  refused(archive([source(), image(Array.from({ length: 6 }, () => '中'.repeat(240)).join('/') + '.png')]));
});

test('entry and image counts are bounded independently', () => {
  const images = Array.from({ length: 32 }, (_, i) => image(`${i}.png`, Buffer.alloc(0)));
  const maximal = [source(), { name: '原文 😀.md.annotations.yaml' }, { name: '原文 😀.md.mermarkd.json' }, ...images];
  assert.equal(parseDocumentBundleArchive(archive(maximal)).files.length, 35);
  assert.equal(parseDocumentBundleArchive(archive(maximal)).imageCount, 32);
  refused(archive([source(), ...images, image('extra.png')]));
  refused(archive([source(), ...images, image('extra.png'), image('extra2.png'), image('extra3.png')]));
});

test('an exact 50 MiB payload and exact individual limits remain supported', () => {
  const entries = [{ name: '文.md', data: Buffer.alloc(32 * MiB) },
    { name: '文.md.annotations.yaml', data: Buffer.alloc(MiB) },
    { name: '文.md.mermarkd.json', data: Buffer.alloc(4 * MiB) },
    image('first.png', Buffer.alloc(10 * MiB)), image('second.png', Buffer.alloc(3 * MiB))];
  const result = parseDocumentBundleArchive(archive(entries));
  assert.equal(result.totalBytes, 50 * MiB); assert.equal(result.imageCount, 2);
});

test('each content kind refuses an actual payload larger than its own cap', () => {
  for (const [name, limit] of [['文.md', 32 * MiB], ['原文 😀.md.annotations.yaml', MiB],
    ['原文 😀.md.mermarkd.json', 4 * MiB], ['image.png', 10 * MiB]] as const) {
    const entry = { name, data: Buffer.alloc(limit + 1) };
    refused(archive(name.endsWith('.md') ? [entry] : [source(), entry]));
  }
});

test('combined payload and archive byte limits refuse actual oversized input', () => {
  const data = Buffer.alloc(10 * MiB), images = Array.from({ length: 5 }, (_, i) => image(`${i}.png`, data));
  refused(archive([source(), ...images]));
  refused(Buffer.alloc(52 * MiB + 1));
});
