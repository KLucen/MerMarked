import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSavedDocumentBundle } from '../../src/main/document-bundle-store.ts';
import { parseDocumentBundleArchive } from '../../src/core/document-bundle-archive.ts';
import { BundleImportError, importDocumentBundle, type DocumentBundleImportOptions } from '../../src/main/document-bundle-import-store.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const documentName = '原文😀.md', asset = 'images/图 😀.png';
const markdown = Buffer.from('\ufeff# 中文😀\r\n\r\n![图](images/%E5%9B%BE%20%F0%9F%98%80.png)\r\n');
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const absent = (file: string) => assert.rejects(fs.lstat(file), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
type Item = { root: string; archive: string; destination: string; options: DocumentBundleImportOptions };
async function cleanup(root: string, current = root): Promise<void> {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('mermarkd-bundle-import-test-'));
  assert.ok(current === root || path.resolve(current).startsWith(path.resolve(root) + path.sep));
  for (const name of await fs.readdir(current)) {
    const file = path.join(current, name), info = await fs.lstat(file);
    if (info.isDirectory() && !info.isSymbolicLink()) await cleanup(root, file); else await fs.unlink(file);
  }
  await fs.rmdir(current);
}
async function fixture(run: (item: Item) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mermarkd-bundle-import-test-'));
  try {
    const sourceDirectory = path.join(root, 'source'), destination = path.join(root, 'destination'), archiveDirectory = path.join(root, 'archives');
    await fs.mkdir(path.join(sourceDirectory, 'images'), { recursive: true }); await fs.mkdir(destination); await fs.mkdir(archiveDirectory);
    const source = path.join(sourceDirectory, documentName), archive = path.join(archiveDirectory, '副本包😀.zip');
    await fs.writeFile(source, markdown); await fs.writeFile(source + suffixes[1], 'old-anchor: retained\r\n');
    await fs.writeFile(source + suffixes[2], '{"unresolved":"retained"}\r\n'); await fs.writeFile(path.join(sourceDirectory, ...asset.split('/')), png);
    await createSavedDocumentBundle({ sourcePath: source, targetPath: archive, expectedSourceSha256: sha(markdown), planSnapshot: async () => [asset], review: async () => {} });
    await run({ root, archive, destination, options: { archivePath: archive, parentDirectory: destination, review: async () => {} } });
  } finally { await cleanup(root); }
}
const snapshot = async (file: string) => ({ bytes: await fs.readFile(file), mtime: (await fs.stat(file, { bigint: true })).mtimeNs });
const unpacked = (directory: string, relative: string) => path.join(directory, ...relative.split('/'));
async function noPrivate(directory: string): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    assert.equal(name.startsWith('.mermarkd-unpack-'), false);
    const file = path.join(directory, name); if ((await fs.lstat(file)).isDirectory()) await noPrivate(file);
  }
}
/** Independent small stored-ZIP fixture writer, also permits semantic-invalid payloads. */
function archiveBytes(entries: readonly { path: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, size = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path), data = Buffer.from(entry.bytes), header = Buffer.alloc(30), record = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0800, 8); record.writeUInt16LE(33, 14);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(0x20, 38); record.writeUInt32LE(offset, 42); central.push(record, name);
    offset += header.length + name.length + data.length; size += record.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, ...central, end]);
}

test('import previews zero writes and restores original bytes with Markdown published last', async () => fixture(async item => {
  const before = await snapshot(item.archive), parsed = parseDocumentBundleArchive(before.bytes), order: string[] = []; let output = '';
  const receipt = await importDocumentBundle({ ...item.options, review: async summary => {
    output = summary.directory; assert.equal(summary.documentPath, path.join(output, documentName)); assert.equal(summary.imageCount, 1); assert.equal(summary.fileCount, 4);
    assert.equal(summary.totalBytes, parsed.totalBytes); assert.match(path.basename(output), /^原文😀 - 副本-[0-9a-f]{8}$/);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(summary.files.map(file => file.path), parsed.files.map(file => file.path));
  }, afterPublish: async relative => { order.push(relative); if (relative !== documentName) await absent(path.join(output, documentName)); } });
  assert.equal(receipt.directory, output); assert.equal(receipt.documentPath, path.join(output, documentName)); assert.equal(order.at(-1), documentName); assert.equal(order[0], asset);
  for (const file of parsed.files) assert.deepEqual(await fs.readFile(unpacked(output, file.path)), Buffer.from(file.bytes));
  await noPrivate(output); assert.deepEqual(await snapshot(item.archive), before);
}));

test('missing companions stay absent; repeated imports choose independent fresh directories', async () => fixture(async item => {
  const entries = parseDocumentBundleArchive(await fs.readFile(item.archive)).files.filter(file => file.kind === 'markdown' || file.kind === 'image');
  await fs.writeFile(item.archive, archiveBytes(entries)); const before = await snapshot(item.archive);
  const first = await importDocumentBundle(item.options), second = await importDocumentBundle(item.options);
  assert.notEqual(first.directory, second.directory); assert.equal(first.fileCount, 2);
  for (const receipt of [first, second]) { await absent(receipt.documentPath + suffixes[1]); await absent(receipt.documentPath + suffixes[2]); }
  assert.deepEqual(await snapshot(item.archive), before);
}));

test('zero-image packages import only their original existing files', async () => fixture(async item => {
  await fs.writeFile(item.archive, archiveBytes([{ path: 'empty.md', bytes: Buffer.from('# Empty\n') }]));
  const receipt = await importDocumentBundle(item.options); assert.equal(receipt.fileCount, 1); assert.equal(receipt.imageCount, 0);
  assert.equal(await fs.readFile(receipt.documentPath, 'utf8'), '# Empty\n');
}));

test('validation precedes directory choice and preview; cancellation at either stage writes nothing', async () => {
  for (const phase of ['schema', 'directory', 'review'] as const) await fixture(async item => {
    const before = await snapshot(item.archive); let validated = false, selected = false;
    await assert.rejects(importDocumentBundle({ ...item.options, validateBundle: async () => { validated = true; if (phase === 'schema') throw Error('schema details must stay private'); },
      parentDirectory: async () => { assert.equal(validated, true); selected = true; if (phase === 'directory') throw Error('cancel'); return item.destination; },
      review: async () => { assert.equal(selected, true); throw Error('cancel'); },
    }), error => error instanceof BundleImportError && error.code === 'refused' && !error.message.includes('schema details') && !error.partialDirectory);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item.archive), before);
  });
});

test('non-ZIP, invalid UTF-8, HTML, unsupported references, missing/extra images and bad signatures refuse before directory selection', async () => {
  const variants = [Buffer.from('not ZIP'), archiveBytes([{ path: 'a.md', bytes: Uint8Array.from([255]) }]),
    archiveBytes([{ path: 'a.md', bytes: Buffer.from('<img src="image.png">') }]), archiveBytes([{ path: 'a.md', bytes: Buffer.from('[pdf](notes.pdf)') }]),
    archiveBytes([{ path: 'a.md', bytes: Buffer.from('![x](missing.png)') }]),
    archiveBytes([{ path: 'a.md', bytes: Buffer.from('# No images') }, { path: 'unused.png', bytes: png }]),
    archiveBytes([{ path: 'a.md', bytes: Buffer.from('![x](fake.jpg)') }, { path: 'fake.jpg', bytes: png }]),
  ];
  for (const bytes of variants) await fixture(async item => {
    await fs.writeFile(item.archive, bytes); const before = await snapshot(item.archive);
    await assert.rejects(importDocumentBundle({ ...item.options, parentDirectory: async () => assert.fail('bad ZIP must not choose directory'), review: async () => assert.fail('bad ZIP must not review') }), BundleImportError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item.archive), before);
  });
});

test('supported raster signatures import without decoding or transcoding', async () => {
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBPVP8L', 8);
  for (const [extension, bytes] of [['png', png], ['jpg', Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])],
    ['jpeg', Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])], ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')], ['webp', webp]] as const) await fixture(async item => {
    const image = `images/a.${extension}`;
    await fs.writeFile(item.archive, archiveBytes([{ path: 'a.md', bytes: Buffer.from(`![x](${image})`) }, { path: image, bytes }]));
    const receipt = await importDocumentBundle(item.options); assert.deepEqual(await fs.readFile(unpacked(receipt.directory, image)), bytes);
  });
});

test('archive byte changes and same-byte identity replacement during review refuse without writes', async () => {
  for (const replace of [false, true]) await fixture(async item => {
    const before = await fs.readFile(item.archive);
    await assert.rejects(importDocumentBundle({ ...item.options, review: async () => {
      if (replace) { await fs.rename(item.archive, item.archive + '.retained'); await fs.writeFile(item.archive, before); }
      else await fs.writeFile(item.archive, 'external ZIP change');
    } }), error => error instanceof BundleImportError && error.code === 'refused');
    assert.deepEqual(await fs.readdir(item.destination), []);
    assert.deepEqual(await fs.readFile(item.archive), replace ? before : Buffer.from('external ZIP change'));
  });
});

test('oversized or non-file archives and relative requests refuse before preview', async () => {
  for (const variant of ['oversize', 'directory', 'relative-archive', 'relative-parent']) await fixture(async item => {
    if (variant === 'oversize') await fs.truncate(item.archive, 52 * 1024 * 1024 + 1);
    if (variant === 'directory') { await fs.unlink(item.archive); await fs.mkdir(item.archive); }
    await assert.rejects(importDocumentBundle({ ...item.options,
      ...(variant === 'relative-archive' ? { archivePath: 'relative.zip' } : {}), ...(variant === 'relative-parent' ? { parentDirectory: 'relative-directory' } : {}),
      review: async () => assert.fail('invalid request must not preview'),
    }), BundleImportError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('source archive parent replacement is caught even when its files keep their identities', async () => fixture(async item => {
  const parent = path.dirname(item.archive), retained = parent + '-retained', before = await snapshot(item.archive);
  await assert.rejects(importDocumentBundle({ ...item.options, review: async () => {
    await fs.rename(parent, retained); await fs.mkdir(parent); await fs.rename(path.join(retained, path.basename(item.archive)), item.archive);
  } }), BundleImportError);
  assert.deepEqual(await snapshot(item.archive), before); assert.deepEqual(await fs.readdir(item.destination), []);
}));

test('validator byte mutation is rejected after preview before directory creation', async () => fixture(async item => {
  const before = await snapshot(item.archive);
  await assert.rejects(importDocumentBundle({ ...item.options, validateBundle: async bundle => { bundle.files[0].bytes[0] ^= 1; } }), BundleImportError);
  assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item.archive), before);
}));

test('predicted output collisions are preserved and not reported as owned partial output', async () => fixture(async item => {
  let collision = '';
  await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => {
    collision = summary.directory; await fs.mkdir(collision); await fs.writeFile(path.join(collision, 'external.txt'), 'external');
  } }), error => error instanceof BundleImportError && error.code === 'refused' && !error.partialDirectory);
  assert.equal(await fs.readFile(path.join(collision, 'external.txt'), 'utf8'), 'external'); assert.deepEqual(await fs.readdir(collision), ['external.txt']);
}));

test('parent identity replacement during preview preserves the replacement directory', async () => fixture(async item => {
  const retained = path.join(item.root, 'retained-parent');
  await assert.rejects(importDocumentBundle({ ...item.options, review: async () => {
    await fs.rename(item.destination, retained); await fs.mkdir(item.destination); await fs.writeFile(path.join(item.destination, 'external.txt'), 'external');
  } }), BundleImportError);
  assert.deepEqual(await fs.readdir(retained), []); assert.deepEqual(await fs.readdir(item.destination), ['external.txt']);
}));

test('selected parent junctions and replaced output directories do not receive package writes', async () => {
  await fixture(async item => {
    const external = path.join(item.root, 'external'), alias = path.join(item.root, 'alias'); await fs.mkdir(external);
    await fs.symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(importDocumentBundle({ ...item.options, parentDirectory: alias }), BundleImportError); assert.deepEqual(await fs.readdir(external), []);
  });
  for (const replacePart of ['root', 'images']) await fixture(async item => {
    const external = path.join(item.root, 'external'), retained = path.join(item.root, 'retained'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'external.txt'), 'external');
    let output = '', changed = false;
    await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => { output = summary.directory; }, afterPublish: async relative => {
      if (relative !== asset || changed) return; changed = true;
      const selected = replacePart === 'root' ? output : path.join(output, 'images');
      await fs.rename(selected, retained); await fs.symlink(external, selected, process.platform === 'win32' ? 'junction' : 'dir');
    } }), error => error instanceof BundleImportError && error.code === 'uncertain' && error.partialDirectory === output);
    assert.deepEqual(await fs.readdir(external), ['external.txt']); await absent(path.join(output, documentName));
    assert.deepEqual(await fs.readFile(replacePart === 'root' ? unpacked(retained, asset) : path.join(retained, path.basename(asset))), png);
  });
});

test('file symlink archives are rejected without reading or changing their target', async t => fixture(async item => {
  const retained = item.archive + '.retained', before = await snapshot(item.archive); await fs.rename(item.archive, retained);
  try { await fs.symlink(retained, item.archive, 'file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('File-symlink case unavailable: OS permission; directory-junction cases run separately.'); return; } throw error; }
  await assert.rejects(importDocumentBundle(item.options), BundleImportError); assert.deepEqual(await snapshot(retained), before); assert.deepEqual(await fs.readdir(item.destination), []);
}));

test('late target collisions retain external bytes and already-published files without Markdown', async () => fixture(async item => {
  let output = '';
  await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => { output = summary.directory; }, afterPublish: async relative => {
    if (relative === asset) await fs.writeFile(path.join(output, documentName + suffixes[1]), 'external sidecar');
  } }), error => error instanceof BundleImportError && error.code === 'uncertain' && error.partialDirectory === output);
  assert.deepEqual(await fs.readFile(unpacked(output, asset)), png); assert.equal(await fs.readFile(path.join(output, documentName + suffixes[1]), 'utf8'), 'external sidecar');
  await absent(path.join(output, documentName)); await noPrivate(output);
}));

test('published-file external changes are preserved and prevent the final Markdown marker', async () => {
  for (const mutation of ['write', 'replace', 'delete']) await fixture(async item => {
    let output = '';
    await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => { output = summary.directory; }, afterPublish: async relative => {
      if (relative !== asset) return;
      const target = unpacked(output, asset);
      if (mutation === 'write') await fs.writeFile(target, 'external change');
      if (mutation === 'replace') { await fs.rename(target, target + '.retained'); await fs.writeFile(target, png); }
      if (mutation === 'delete') await fs.unlink(target);
    } }), error => error instanceof BundleImportError && error.code === 'uncertain' && error.partialDirectory === output);
    await absent(path.join(output, documentName));
    if (mutation === 'delete') await absent(unpacked(output, asset));
    else assert.deepEqual(await fs.readFile(unpacked(output, asset)), mutation === 'write' ? Buffer.from('external change') : png);
    await noPrivate(output);
  });
});

test('source ZIP changes before final Markdown preserve partial output and require a fresh directory on retry', async () => fixture(async item => {
  let output = ''; const before = await snapshot(item.archive); let checkpoints = 0;
  await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => { output = summary.directory; }, beforePublish: async () => {
    if (++checkpoints === 2) await fs.writeFile(item.archive, 'external ZIP update');
  } }), error => error instanceof BundleImportError && error.code === 'uncertain' && error.partialDirectory === output);
  await absent(path.join(output, documentName)); assert.deepEqual(await fs.readFile(unpacked(output, asset)), png); await noPrivate(output);
  assert.equal(await fs.readFile(item.archive, 'utf8'), 'external ZIP update');
  await fs.writeFile(item.archive, before.bytes); const retry = await importDocumentBundle(item.options); assert.notEqual(retry.directory, output); await absent(path.join(output, documentName));
}));

test('a failure after the final marker retains the complete package and reports its actual directory', async () => fixture(async item => {
  const before = await snapshot(item.archive), entries = parseDocumentBundleArchive(before.bytes).files; let output = '';
  await assert.rejects(importDocumentBundle({ ...item.options, review: async summary => { output = summary.directory; }, afterPublish: async relative => {
    if (relative === documentName) throw Error('post-publication failure');
  } }), error => error instanceof BundleImportError && error.code === 'uncertain' && error.partialDirectory === output);
  for (const file of entries) assert.deepEqual(await fs.readFile(unpacked(output, file.path)), Buffer.from(file.bytes));
  await noPrivate(output); assert.deepEqual(await snapshot(item.archive), before);
}));

test('path depth and directory-count amplification reject before review', async () => {
  const deep = [...Array.from({ length: 33 }, () => 'a'), 'a.png'].join('/');
  const many = Array.from({ length: 32 }, (_, index) => `d${index}/a/b/c/d/image.png`);
  for (const images of [[deep], many]) await fixture(async item => {
    const entries = [{ path: 'a.md', bytes: Buffer.from(images.map(image => `![x](${image})`).join('\n')) }, ...images.map(image => ({ path: image, bytes: png }))];
    await fs.writeFile(item.archive, archiveBytes(entries));
    await assert.rejects(importDocumentBundle({ ...item.options, review: async () => assert.fail('amplification must not preview') }), BundleImportError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('actual process exits preserve unchanged ZIP and either no Markdown or a complete raw package', async () => {
  for (const checkpoint of ['before-markdown', 'after-markdown']) await fixture(async item => {
    const before = await snapshot(item.archive), entries = parseDocumentBundleArchive(before.bytes).files;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../fixtures/document-bundle-import-crash.mjs', import.meta.url)), item.archive, item.destination, checkpoint], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(child.status, 73, child.stderr); const directories = await fs.readdir(item.destination); assert.equal(directories.length, 1); const output = path.join(item.destination, directories[0]);
    for (const entry of entries) {
      if (entry.kind === 'markdown' && checkpoint === 'before-markdown') await absent(unpacked(output, entry.path));
      else assert.deepEqual(await fs.readFile(unpacked(output, entry.path)), Buffer.from(entry.bytes));
    }
    await noPrivate(output); assert.deepEqual(await snapshot(item.archive), before);
  });
});
