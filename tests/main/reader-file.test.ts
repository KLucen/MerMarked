import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  decodeMarkdownSource,
  decodeUtf8Markdown,
  readDocumentImage,
  selectedMarkdownPath,
  validatedExternalUrl,
} from '../../src/main/reader-file.ts';

test('file selection accepts one .md and leaves cancellation empty', () => {
  assert.equal(selectedMarkdownPath({ canceled: true, filePaths: [] }), null);
  assert.equal(selectedMarkdownPath({ canceled: false, filePaths: ['note.MD'] }), 'note.MD');
  assert.throws(() => selectedMarkdownPath({ canceled: false, filePaths: ['note.txt'] }), /\.md/);
});

test('UTF-8 decoding handles BOM without changing the source bytes', () => {
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('# 中文\r\n正文')]);
  const snapshot = Buffer.from(bytes);
  assert.equal(decodeUtf8Markdown(bytes), '# 中文\r\n正文');
  assert.deepEqual(bytes, snapshot);
  assert.throws(() => decodeUtf8Markdown(Uint8Array.from([0xff, 0xfe, 0x23])), /UTF-8/);
});

test('source metadata hashes original BOM and CRLF bytes', () => {
  const text = '# 中文\r\n正文 😀\r\n';
  const withoutBom = Buffer.from(text, 'utf8');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), withoutBom]);
  const snapshot = Buffer.from(withBom);

  assert.deepEqual(decodeMarkdownSource(withoutBom), {
    content: text,
    sourceSha256: 'c4d0954d595b032209a990e7adbe421fec4f98ced3028000028d66cb5125a497',
    bomByteLength: 0,
  });
  assert.deepEqual(decodeMarkdownSource(withBom), {
    content: text,
    sourceSha256: 'e52568dc00ee5a94db2fccc6aeec9bb372bbbae2749519696cba8e1103324e8e',
    bomByteLength: 3,
  });
  assert.deepEqual(withBom, snapshot);
});

test('external links use a narrow protocol allowlist', () => {
  assert.equal(validatedExternalUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(validatedExternalUrl('mailto:reader@example.com'), 'mailto:reader@example.com');
  for (const unsafe of ['javascript:alert(1)', 'data:text/html,hi', 'file:///C:/secret', '/relative', 'https://user:pass@example.com/', 'https://example.com/\ncmd']) {
    assert.equal(validatedExternalUrl(unsafe), null, unsafe);
  }
});

test('local images stay in the opened Markdown directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-reader-'));
  try {
    const documentPath = path.join(directory, 'note.md');
    const imagePath = path.join(directory, 'image.png');
    await writeFile(documentPath, '# Note\n');
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const image = await readDocumentImage(documentPath, 'image.png');
    assert.match(image ?? '', /^data:image\/png;base64,/);
    assert.equal(await readDocumentImage(documentPath, '../outside.png'), null);
    assert.equal(await readDocumentImage(documentPath, 'https://example.com/image.png'), null);
    assert.equal(await readDocumentImage(documentPath, 'C:\\Windows\\secret.png'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
