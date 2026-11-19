import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { BundleStoreError, createSavedDocumentBundle, type SavedDocumentBundleOptions } from '../../src/main/document-bundle-store.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const sourceBytes = Buffer.from('\ufeff# 中文😀\r\n\r\n![图](images/%E5%9B%BE%20%F0%9F%98%80.png)\r\n');
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const asset = 'images/图 😀.png';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const absent = (file: string) => assert.rejects(fs.lstat(file), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
type Item = { root: string; source: string; target: string; image: string; destination: string; options: SavedDocumentBundleOptions };
async function cleanup(root: string, directory = root): Promise<void> {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('mermarkd-bundle-test-'));
  assert.ok(directory === root || path.resolve(directory).startsWith(path.resolve(root) + path.sep));
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const info = await fs.lstat(file);
    if (info.isDirectory() && !info.isSymbolicLink()) await cleanup(root, file); else await fs.unlink(file);
  }
  await fs.rmdir(directory);
}
async function fixture(run: (item: Item) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mermarkd-bundle-test-'));
  const sourceDirectory = path.join(root, 'source'), destination = path.join(root, 'destination');
  await fs.mkdir(path.join(sourceDirectory, 'images'), { recursive: true }); await fs.mkdir(destination);
  const source = path.join(sourceDirectory, '原文.md'), target = path.join(destination, '副本 包😀.zip'), image = path.join(sourceDirectory, ...asset.split('/'));
  await fs.writeFile(source, sourceBytes); await fs.writeFile(source + suffixes[1], 'old-basis: retained\n'); await fs.writeFile(source + suffixes[2], '{"unresolved":"retained"}\n'); await fs.writeFile(image, png);
  try { await run({ root, source, target, image, destination, options: { sourcePath: source, targetPath: target,
    expectedSourceSha256: sha(sourceBytes), planSnapshot: async () => [asset], review: async () => {} } }); }
  finally { await cleanup(root); }
}
async function snapshot(item: Item) {
  return Promise.all([...suffixes.map(suffix => item.source + suffix), item.image].map(async file => ({ file, bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs })));
}
/** Independent reader checks central/local agreement, UTF-8, lengths and CRC. */
function readZip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.length - 22; assert.ok(end >= 0); assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 4), 0); assert.equal(bytes.readUInt16LE(end + 6), 0);
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt16LE(end + 8), count); assert.equal(start + centralSize, end);
  const entries = new Map<string, Buffer>(); let position = start, localEnd = 0;
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50); assert.equal(bytes.readUInt16LE(position + 8), 0x0800); assert.equal(bytes.readUInt16LE(position + 10), 0);
    const size = bytes.readUInt32LE(position + 20), nameLength = bytes.readUInt16LE(position + 28), local = bytes.readUInt32LE(position + 42), crc = bytes.readUInt32LE(position + 16);
    assert.equal(bytes.readUInt32LE(position + 24), size); assert.equal(local, localEnd); assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 6), 0x0800); assert.equal(bytes.readUInt16LE(local + 8), 0);
    assert.equal(bytes.readUInt32LE(local + 14), crc); assert.equal(bytes.readUInt32LE(local + 18), size); assert.equal(bytes.readUInt32LE(local + 22), size);
    assert.equal(bytes.readUInt16LE(local + 26), nameLength); assert.equal(bytes.readUInt16LE(local + 28), 0);
    const encodedName = bytes.subarray(position + 46, position + 46 + nameLength), name = new TextDecoder('utf-8', { fatal: true }).decode(encodedName);
    assert.deepEqual(bytes.subarray(local + 30, local + 30 + nameLength), encodedName); assert.equal(entries.has(name), false);
    const data = bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size); assert.equal(data.length, size); assert.equal(crc32(data), crc);
    entries.set(name, Buffer.from(data)); localEnd = local + 30 + nameLength + size;
    position += 46 + nameLength + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
  }
  assert.equal(position, end); assert.equal(localEnd, start); return entries;
}

test('bundle stores original BOM/CRLF, companions and UTF-8 image paths with valid ZIP records and CRC', async () => fixture(async item => {
  const before = await snapshot(item); let reviewed = false;
  const receipt = await createSavedDocumentBundle({ ...item.options, review: async summary => {
    reviewed = true; assert.equal(summary.targetPath, item.target); assert.equal(summary.imageCount, 1); assert.equal(summary.files.length, 4);
    assert.deepEqual(summary.files.map(file => file.path), ['原文.md', '原文.md.annotations.yaml', '原文.md.mermarkd.json', asset]);
    assert.equal(summary.totalBytes, before.reduce((total, file) => total + file.bytes.length, 0)); assert.ok(summary.archiveBytes > summary.totalBytes);
    assert.deepEqual(await fs.readdir(item.destination), [], 'no stage before review');
  } });
  assert.equal(reviewed, true); const zip = await fs.readFile(item.target), entries = readZip(zip);
  assert.equal(receipt.fileCount, 4); assert.equal(receipt.archiveBytes, zip.length); assert.equal(receipt.sha256, sha(zip));
  for (let i = 0; i < 3; i++) assert.deepEqual(entries.get('原文.md' + suffixes[i]), before[i].bytes);
  assert.deepEqual(entries.get(asset), png); assert.deepEqual(await snapshot(item), before);
  assert.deepEqual(await fs.readdir(item.destination), [path.basename(item.target)]);
  await fs.writeFile(item.target, 'changed archive'); assert.deepEqual(await snapshot(item), before);
}));

test('missing sidecars are not created in the ZIP or source folder', async () => fixture(async item => {
  await fs.unlink(item.source + suffixes[1]); await fs.unlink(item.source + suffixes[2]);
  const receipt = await createSavedDocumentBundle(item.options); assert.equal(receipt.fileCount, 2);
  assert.deepEqual([...readZip(await fs.readFile(item.target)).keys()], ['原文.md', asset]);
  await absent(item.source + suffixes[1]); await absent(item.source + suffixes[2]);
}));

test('zero-image bundles remain valid and include only existing document files', async () => fixture(async item => {
  const receipt = await createSavedDocumentBundle({ ...item.options, planSnapshot: async () => [] });
  assert.equal(receipt.imageCount, 0); assert.equal(readZip(await fs.readFile(item.target)).size, 3);
}));

test('supported raster signatures are stored without transcoding and extension mismatches reject', async () => {
  const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBPVP8L', 8);
  const signatures = [
    ['png', png], ['jpg', Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])],
    ['jpeg', Buffer.from([255, 216, 255, 224, 0, 2, 255, 217])],
    ['gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')], ['webp', webp],
  ] as const;
  for (const [extension, bytes] of signatures) await fixture(async item => {
    const relative = `images/preserved.${extension}`; await fs.writeFile(path.join(path.dirname(item.source), ...relative.split('/')), bytes);
    await createSavedDocumentBundle({ ...item.options, planSnapshot: async () => [relative] });
    assert.deepEqual(readZip(await fs.readFile(item.target)).get(relative), bytes);
  });
  await fixture(async item => {
    const relative = 'images/not-jpeg.jpg'; await fs.writeFile(path.join(path.dirname(item.source), ...relative.split('/')), png);
    await assert.rejects(createSavedDocumentBundle({ ...item.options, planSnapshot: async () => [relative] }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('stale source hashes and non-ZIP or relative requests refuse before review', async () => {
  for (const change of [{ expectedSourceSha256: '0'.repeat(64) }, { targetPath: 'relative.zip' }, { sourcePath: 'relative.md' }, { targetPath: 'not-an-absolute-output.txt' }]) await fixture(async item => {
    const before = await snapshot(item);
    await assert.rejects(createSavedDocumentBundle({ ...item.options, ...change, review: async () => assert.fail('invalid request must not review') }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item), before);
  });
});

test('source and target entry names reject controls, lone surrogates and Windows device aliases', async () => {
  for (const stem of ['bad\u0001', 'bad\u0085', 'bad\u009f', 'bad\ud800', 'bad\udfff', 'COM¹', 'com²', 'LPT³']) await fixture(async item => {
    for (const field of ['sourcePath', 'targetPath'] as const) {
      const name = path.join(path.dirname(field === 'sourcePath' ? item.source : item.target), stem + (field === 'sourcePath' ? '.md' : '.zip'));
      await assert.rejects(createSavedDocumentBundle({ ...item.options, [field]: name, review: async () => assert.fail('invalid name must not review') }), BundleStoreError);
      assert.deepEqual(await fs.readdir(item.destination), []);
    }
  });
});

test('a lone surrogate cannot alias a real replacement-character source file', async () => fixture(async item => {
  const replacement = path.join(path.dirname(item.source), 'bad\ufffd.md'); await fs.writeFile(replacement, sourceBytes);
  await assert.rejects(createSavedDocumentBundle({ ...item.options, sourcePath: path.join(path.dirname(item.source), 'bad\ud800.md') }), BundleStoreError);
  assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await fs.readFile(replacement), sourceBytes);
}));

test('paired supplementary characters in the original source name survive UTF-8 ZIP encoding', async () => fixture(async item => {
  const renamed = path.join(path.dirname(item.source), '原文 😀.md');
  for (const suffix of suffixes) await fs.rename(item.source + suffix, renamed + suffix);
  await createSavedDocumentBundle({ ...item.options, sourcePath: renamed });
  assert.deepEqual(readZip(await fs.readFile(item.target)).get('原文 😀.md'), sourceBytes);
}));

test('review cancellation and validation refusal create no output or private stage', async () => {
  for (const phase of ['validateSnapshot', 'planSnapshot', 'review'] as const) await fixture(async item => {
    const before = await snapshot(item);
    await assert.rejects(createSavedDocumentBundle({ ...item.options, [phase]: async () => { throw Error('cancel or refuse'); } }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item), before);
  });
});

test('occupied targets refuse before review and are never overwritten', async () => fixture(async item => {
  await fs.writeFile(item.target, 'external'); const info = await fs.stat(item.target);
  await assert.rejects(createSavedDocumentBundle({ ...item.options, review: async () => assert.fail('must not review') }), BundleStoreError);
  assert.equal(await fs.readFile(item.target, 'utf8'), 'external'); assert.equal((await fs.stat(item.target)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await fs.readdir(item.destination), [path.basename(item.target)]);
}));

test('source or companion changes during review prevent publication and retain external content', async () => {
  for (const suffix of suffixes) await fixture(async item => {
    await assert.rejects(createSavedDocumentBundle({ ...item.options, review: async () => { await fs.writeFile(item.source + suffix, 'external state'); } }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.equal(await fs.readFile(item.source + suffix, 'utf8'), 'external state');
  });
});

test('a missing companion appearing during review is not silently included', async () => fixture(async item => {
  await fs.unlink(item.source + suffixes[1]);
  await assert.rejects(createSavedDocumentBundle({ ...item.options, review: async () => { await fs.writeFile(item.source + suffixes[1], 'new external note'); } }), BundleStoreError);
  assert.deepEqual(await fs.readdir(item.destination), []); assert.equal(await fs.readFile(item.source + suffixes[1], 'utf8'), 'new external note');
}));

test('image changes and identical-byte inode replacement during review reject stale snapshots', async () => {
  for (const replacement of [false, true]) await fixture(async item => {
    await assert.rejects(createSavedDocumentBundle({ ...item.options, review: async () => {
      if (replacement) { await fs.rename(item.image, item.image + '.retained'); await fs.writeFile(item.image, png); }
      else await fs.writeFile(item.image, Buffer.concat([png, Buffer.from('changed')]));
    } }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
    assert.deepEqual(await fs.readFile(item.image), replacement ? png : Buffer.concat([png, Buffer.from('changed')]));
  });
});

test('source and image changes after staging reject and clean only private stage', async () => {
  for (const change of ['source', 'image']) await fixture(async item => {
    await assert.rejects(createSavedDocumentBundle({ ...item.options, beforePublish: async () => { await fs.writeFile(change === 'source' ? item.source : item.image, 'external late state'); } }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
    assert.equal(await fs.readFile(change === 'source' ? item.source : item.image, 'utf8'), 'external late state');
  });
});

test('snapshot validators and planners cannot change captured bytes', async () => {
  for (const phase of ['validateSnapshot', 'planSnapshot'] as const) await fixture(async item => {
    const before = await snapshot(item);
    const mutate = async (files: Parameters<NonNullable<SavedDocumentBundleOptions['validateSnapshot']>>[0]) => { files[0].bytes![0] ^= 1; return [asset]; };
    await assert.rejects(createSavedDocumentBundle({ ...item.options, [phase]: mutate }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await snapshot(item), before);
  });
});

test('unsafe image paths, aliases, non-images and excessive lists reject', async () => {
  const plans = [['../outside.png'], ['/outside.png'], ['C:/outside.png'], ['images\\outside.png'], ['images/./a.png'], ['images//a.png'], ['images/CON.png'], ['images/a.png?x=1'], ['images/a.svg'], ['images/a.md'], [asset, asset], [asset, asset.toUpperCase()], Array(33).fill(asset)];
  for (const plan of plans) await fixture(async item => {
    await assert.rejects(createSavedDocumentBundle({ ...item.options, planSnapshot: async () => plan }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('missing images and files disguised as raster images reject before review', async () => {
  for (const fake of [null, Buffer.from('<svg><image href="../private.png"/></svg>'), Buffer.from('not PNG')]) await fixture(async item => {
    if (fake) await fs.writeFile(item.image, fake); else await fs.unlink(item.image);
    await assert.rejects(createSavedDocumentBundle({ ...item.options, review: async () => assert.fail('bad image must not review') }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('directory junctions and available image-file symlinks are not followed', async t => {
  await fixture(async item => {
    const external = path.join(item.root, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'outside.png'), png);
    const images = path.dirname(item.image), retained = path.join(path.dirname(item.source), 'retained-images');
    await fs.rename(images, retained); await fs.symlink(external, images, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(createSavedDocumentBundle({ ...item.options, planSnapshot: async () => ['images/outside.png'] }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []); assert.deepEqual(await fs.readFile(path.join(external, 'outside.png')), png);
  });
  await fixture(async item => {
    const external = path.join(item.root, 'external.png'); await fs.rename(item.image, external);
    try { await fs.symlink(external, item.image, 'file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.diagnostic('File-symlink subcase unavailable: OS permission; directory-junction subcase executed.'); return; } throw error; }
    await assert.rejects(createSavedDocumentBundle(item.options), BundleStoreError); assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('directory replacement during review or after staging retains unrelated destination files', async () => {
  for (const phase of ['review', 'beforePublish'] as const) await fixture(async item => {
    const retained = path.join(item.root, 'retained-destination');
    await assert.rejects(createSavedDocumentBundle({ ...item.options, [phase]: async () => {
      await fs.rename(item.destination, retained); await fs.mkdir(item.destination); await fs.writeFile(item.target, 'unrelated file');
    } }), BundleStoreError);
    assert.equal(await fs.readFile(item.target, 'utf8'), 'unrelated file'); assert.deepEqual(await fs.readdir(item.destination), [path.basename(item.target)]);
    assert.equal((await fs.readdir(retained)).length, phase === 'review' ? 0 : 1);
  });
});

test('late target creation is retained and only the private stage is cleaned', async () => fixture(async item => {
  await assert.rejects(createSavedDocumentBundle({ ...item.options, beforePublish: async () => { await fs.writeFile(item.target, 'external race'); } }), BundleStoreError);
  assert.equal(await fs.readFile(item.target, 'utf8'), 'external race'); assert.deepEqual(await fs.readdir(item.destination), [path.basename(item.target)]);
}));

test('an error after exclusive publication returns success only for the intact complete ZIP', async () => fixture(async item => {
  const receipt = await createSavedDocumentBundle({ ...item.options, afterPublish: async () => { throw Error('post-publication error'); } });
  assert.equal(readZip(await fs.readFile(item.target)).size, 4); assert.equal(receipt.imageCount, 1); assert.deepEqual(await fs.readdir(item.destination), [path.basename(item.target)]);
}));

test('externally changed published targets are preserved with their private snapshot', async () => fixture(async item => {
  await assert.rejects(createSavedDocumentBundle({ ...item.options, afterPublish: async () => { await fs.writeFile(item.target, 'external replacement'); } }), (error: unknown) => error instanceof BundleStoreError && error.code === 'uncertain');
  assert.equal(await fs.readFile(item.target, 'utf8'), 'external replacement'); assert.equal((await fs.readdir(item.destination)).length, 2);
}));

test('source, image and aggregate byte limits are enforced before review', async () => {
  for (const kind of ['source', 'image', 'total']) await fixture(async item => {
    let options = item.options;
    if (kind === 'source' || kind === 'image') {
      const handle = await fs.open(kind === 'source' ? item.source : item.image, 'r+');
      try { await handle.truncate((kind === 'source' ? 32 : 10) * 1024 * 1024 + 1); } finally { await handle.close(); }
    } else {
      const plan: string[] = [];
      for (let index = 0; index < 5; index++) {
        const relative = `images/large-${index}.png`, file = path.join(path.dirname(item.source), ...relative.split('/'));
        await fs.writeFile(file, png); const handle = await fs.open(file, 'r+'); try { await handle.truncate(10 * 1024 * 1024); } finally { await handle.close(); }
        plan.push(relative);
      }
      options = { ...options, planSnapshot: async () => plan };
    }
    await assert.rejects(createSavedDocumentBundle({ ...options, review: async () => assert.fail('oversize must not review') }), BundleStoreError);
    assert.deepEqual(await fs.readdir(item.destination), []);
  });
});

test('actual process exit leaves either no public ZIP or a complete independently readable ZIP', async () => {
  for (const checkpoint of ['prepared', 'published']) await fixture(async item => {
    const before = await snapshot(item);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../fixtures/document-bundle-crash.mjs', import.meta.url)), item.source, item.target, asset, checkpoint], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(child.status, 73, child.stderr);
    const privateFiles = (await fs.readdir(item.destination)).filter(name => name.startsWith('.mermarkd-bundle-'));
    assert.equal(privateFiles.length, 1); const prepared = await fs.readFile(path.join(item.destination, privateFiles[0])); assert.equal(readZip(prepared).size, 4);
    if (checkpoint === 'prepared') await absent(item.target); else assert.deepEqual(await fs.readFile(item.target), prepared);
    assert.deepEqual(await snapshot(item), before);
  });
});
