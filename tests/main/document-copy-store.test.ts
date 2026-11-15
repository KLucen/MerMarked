import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { copyDocumentFiles, recoverPendingDocumentCopies, CopyInterrupted, DocumentCopyError, DOCUMENT_COPY_SUFFIXES } from '../../src/main/document-copy-store.ts';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const original = Buffer.from('\ufeff# 中文 😀\r\n\r\n保留正文与原换行。');
const yaml = Buffer.from('schemaVersion: 1\nsource: { sha256: old-basis }\n');
const canvas = Buffer.from('{"schemaVersion":2,"retained":"unresolved-link"}\n');
async function fixture(run: (item: { root: string; source: string; target: string; journals: string; options: Parameters<typeof copyDocumentFiles>[0] }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mermarkd-copy-test-'));
  const source = path.join(root, '原文.md'), target = path.join(root, '副本.md'), journals = path.join(root, 'journals');
  await fs.writeFile(source, original); await fs.writeFile(source + '.annotations.yaml', yaml); await fs.writeFile(source + '.mermarkd.json', canvas);
  try { await run({ root, source, target, journals, options: { sourcePath: source, targetPath: target, expectedSourceSha256: sha(original), journalDirectory: journals } }); }
  finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('mermarkd-copy-test-'));
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) {
        assert.ok(entry.name === 'journals' || entry.name.startsWith('.mermarkd-copy-'));
        for (const child of await fs.readdir(file, { withFileTypes: true })) { assert.ok(child.isFile() || child.isSymbolicLink()); await fs.unlink(path.join(file, child.name)); }
        await fs.rmdir(file);
      } else await fs.unlink(file);
    }
    await fs.rmdir(root);
  }
}
const absent = async (file: string) => assert.rejects(fs.lstat(file), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
async function targetAbsent(target: string) { for (const suffix of DOCUMENT_COPY_SUFFIXES) await absent(target + suffix); }
async function exact(source: string, target: string) { for (const suffix of DOCUMENT_COPY_SUFFIXES) assert.deepEqual(await fs.readFile(target + suffix), await fs.readFile(source + suffix)); }

test('copy exact bytes and keep original bytes/mtime independent from later copy edits', async () => fixture(async ({ source, target, journals, options }) => {
  const before = await Promise.all(DOCUMENT_COPY_SUFFIXES.map(async suffix => ({ bytes: await fs.readFile(source + suffix), mtime: (await fs.stat(source + suffix)).mtimeMs })));
  assert.equal((await copyDocumentFiles(options)).targetPath, target); await exact(source, target);
  for (let i = 0; i < 3; i++) { assert.deepEqual(await fs.readFile(source + DOCUMENT_COPY_SUFFIXES[i]), before[i].bytes); assert.equal((await fs.stat(source + DOCUMENT_COPY_SUFFIXES[i])).mtimeMs, before[i].mtime); }
  assert.deepEqual(await fs.readdir(journals), []);
  await fs.writeFile(target, 'edited copy'); await fs.writeFile(target + '.annotations.yaml', 'edited copy note');
  assert.deepEqual(await fs.readFile(source), original); assert.deepEqual(await fs.readFile(source + '.annotations.yaml'), yaml); assert.equal((await fs.stat(source)).mtimeMs, before[0].mtime);
}));
test('missing companions remain missing', async () => fixture(async ({ source, target, options }) => {
  await fs.unlink(source + '.annotations.yaml'); await fs.unlink(source + '.mermarkd.json');
  assert.deepEqual((await copyDocumentFiles(options)).copiedSuffixes, ['']); assert.deepEqual(await fs.readFile(target), original);
  await absent(target + '.annotations.yaml'); await absent(target + '.mermarkd.json');
}));
test('any existing target refuses without overwriting siblings', async () => {
  for (const occupied of DOCUMENT_COPY_SUFFIXES) await fixture(async ({ target, options }) => {
    await fs.writeFile(target + occupied, 'external'); await assert.rejects(copyDocumentFiles(options), DocumentCopyError);
    for (const suffix of DOCUMENT_COPY_SUFFIXES) if (suffix === occupied) assert.equal(await fs.readFile(target + suffix, 'utf8'), 'external'); else await absent(target + suffix);
  });
});
test('source changes during staging abort without replacing external edits', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, beforePublish: async () => { await fs.writeFile(source, 'external edit'); } }), DocumentCopyError);
  assert.equal(await fs.readFile(source, 'utf8'), 'external edit'); await targetAbsent(target); assert.deepEqual(await fs.readdir(journals), []);
}));
test('a newly appearing source companion aborts', async () => fixture(async ({ source, target, options }) => {
  await fs.unlink(source + '.mermarkd.json');
  await assert.rejects(copyDocumentFiles({ ...options, beforePublish: async () => { await fs.writeFile(source + '.mermarkd.json', 'new canvas'); } }), DocumentCopyError);
  await targetAbsent(target); assert.equal(await fs.readFile(source + '.mermarkd.json', 'utf8'), 'new canvas');
}));
test('ordinary partial failure preserves the published target for explicit recovery', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async () => { throw new Error('injected failure'); } }), DocumentCopyError);
  await absent(target); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml); assert.deepEqual(await fs.readFile(source), original); assert.equal((await fs.readdir(journals)).length, 1);
}));
test('explicit restart recovery completes an interrupted partial publication', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async suffix => { if (suffix === '.annotations.yaml') throw new CopyInterrupted(); } }), CopyInterrupted);
  await absent(target); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml);
  const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
  assert.equal(recovered.completed.length, 1); assert.equal(recovered.rolledBack.length, 0); await exact(source, target); assert.deepEqual(await fs.readdir(journals), []);
}));
test('restart retains a complete copy after the Markdown commit marker', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async suffix => { if (suffix === '') throw new CopyInterrupted(); } }), CopyInterrupted);
  const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
  assert.equal(recovered.completed.length, 1); assert.equal(recovered.rolledBack.length, 0); await exact(source, target); assert.deepEqual(await fs.readdir(journals), []);
}));
test('external target edits preserve data and recovery evidence', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async suffix => { if (suffix === '.annotations.yaml') { await fs.writeFile(target + suffix, 'external edit'); throw new CopyInterrupted(); } } }), CopyInterrupted);
  const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
  assert.equal(recovered.conflicts.length, 1); assert.equal(await fs.readFile(target + '.annotations.yaml', 'utf8'), 'external edit');
  assert.deepEqual(await fs.readFile(source), original); assert.equal((await fs.readdir(journals)).length, 1);
}));
test('snapshot validator rejection creates no target', async () => fixture(async ({ target, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, validateSnapshot: async () => { throw new Error('unsupported sidecar'); } }), DocumentCopyError); await targetAbsent(target);
}));
test('invalid names, source reuse, another folder and stale hashes refuse', async () => fixture(async ({ root, source, target, journals, options }) => {
  await fs.mkdir(journals);
  for (const change of [{ targetPath: source }, { targetPath: path.join(root, 'CON.md') }, { targetPath: path.join(root, 'bad:name.md') }, { targetPath: path.join(journals, 'elsewhere.md') }, { expectedSourceSha256: '0'.repeat(64) }]) {
    await assert.rejects(copyDocumentFiles({ ...options, ...change }), DocumentCopyError); await targetAbsent(target); assert.deepEqual(await fs.readFile(source), original);
  }
  assert.deepEqual(await fs.readdir(journals), []);
}));
test('a racing target is preserved separately from the incomplete copy', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, beforePublish: async () => { await fs.writeFile(target, 'racing document', { flag: 'wx' }); } }), (e: unknown) => e instanceof DocumentCopyError && e.code === 'uncertain');
  assert.equal(await fs.readFile(target, 'utf8'), 'racing document'); assert.deepEqual(await fs.readFile(source), original);
  assert.equal((await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals })).conflicts.length, 1);
}));
test('same-content replacement with another inode remains a conflict', async () => fixture(async ({ source, target, journals, options }) => {
  let publishedInode = 0n;
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async suffix => {
    if (suffix !== '.annotations.yaml') return;
    const file = target + suffix; publishedInode = (await fs.stat(file, { bigint: true })).ino;
    const bytes = await fs.readFile(file); await fs.unlink(file); await fs.writeFile(file, bytes, { flag: 'wx' }); throw new CopyInterrupted();
  } }), CopyInterrupted);
  assert.notEqual((await fs.stat(target + '.annotations.yaml', { bigint: true })).ino, publishedInode);
  assert.equal((await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals })).conflicts.length, 1); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml);
}));
test('malformed receipts are preserved without blocking a different copy name', async () => fixture(async ({ root, source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async () => { throw new CopyInterrupted(); } }), CopyInterrupted);
  const filename = (await fs.readdir(journals))[0], receipt = path.join(journals, filename); await fs.writeFile(receipt, '{"version":1}');
  assert.deepEqual((await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals })).conflicts, [filename]);
  assert.equal(await fs.readFile(receipt, 'utf8'), '{"version":1}'); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml);
  const next = path.join(root, '另一个副本.md'); await copyDocumentFiles({ ...options, targetPath: next }); await exact(source, next); assert.equal((await fs.readdir(journals)).length, 1);
}));
test('recovery does not roll back an active same-process copy', { timeout: 10000 }, async () => fixture(async ({ source, target, journals, options }) => {
  let reached!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { reached = r; }), hold = new Promise<void>(r => { release = r; });
  const running = copyDocumentFiles({ ...options, beforePublish: async () => { reached(); await hold; } });
  try { await Promise.race([ready, running.then(() => assert.fail('copy did not pause'))]);
    const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals }); assert.equal(recovered.busy.length, 1); await targetAbsent(target);
  } finally { release(); await running; }
  await exact(source, target); assert.deepEqual(await fs.readdir(journals), []);
}));
test('a live different owner PID is busy', async () => fixture(async ({ source, target, journals, options }) => {
  assert.ok(process.ppid > 0 && process.ppid !== process.pid);
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async () => { throw new CopyInterrupted(); } }), CopyInterrupted);
  const filename = (await fs.readdir(journals))[0], file = path.join(journals, filename), journal = JSON.parse(await fs.readFile(file, 'utf8'));
  journal.ownerPid = process.ppid; await fs.writeFile(file, JSON.stringify(journal));
  assert.deepEqual((await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals })).busy, [filename]); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml);
}));
test('journal directory errors use the fixed store message', async () => fixture(async ({ root, target, journals, options }) => {
  await fs.writeFile(journals, 'not a directory');
  await assert.rejects(copyDocumentFiles(options), (e: unknown) => e instanceof DocumentCopyError && e.code === 'refused' && !e.message.includes(root)); await targetAbsent(target);
}));
test('validators cannot publish mutated snapshot buffers', async () => fixture(async ({ source, target, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, validateSnapshot: async files => { files[0].bytes![0] ^= 1; } }), DocumentCopyError);
  await targetAbsent(target); assert.deepEqual(await fs.readFile(source), original);
}));
test('actual child termination is recovered at each publication boundary', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const checkpoint of ['.annotations.yaml', 'markdown']) await fixture(async ({ source, target, journals }) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../fixtures/document-copy-crash.mjs', import.meta.url)), source, target, journals, checkpoint], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 73, child.stderr);
    const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
    assert.equal(recovered.completed.length, 1); assert.equal(recovered.busy.length + recovered.conflicts.length, 0);
    await exact(source, target); assert.deepEqual(await fs.readdir(journals), []);
  });
});
test('external deletion of a companion after Markdown publication stays deleted', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async suffix => { if (suffix === '') throw new CopyInterrupted(); } }), CopyInterrupted);
  await fs.unlink(target + '.annotations.yaml');
  const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
  assert.equal(recovered.conflicts.length, 1); await absent(target + '.annotations.yaml');
  assert.deepEqual(await fs.readFile(target), original); assert.deepEqual(await fs.readFile(source), original);
}));
test('recovery never reconstructs a missing staged candidate from the current source', async () => fixture(async ({ root, source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, afterPublish: async () => { throw new CopyInterrupted(); } }), CopyInterrupted);
  const stage = (await fs.readdir(root)).find(name => name.startsWith('.mermarkd-copy-'))!;
  assert.ok(stage && path.basename(stage) === stage); await fs.unlink(path.join(root, stage, '0'));
  await fs.writeFile(source, 'newer source');
  assert.equal((await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals })).conflicts.length, 1);
  await absent(target); assert.deepEqual(await fs.readFile(target + '.annotations.yaml'), yaml); assert.equal(await fs.readFile(source, 'utf8'), 'newer source');
}));
test('unpublished interruptions clean only private candidates', async () => fixture(async ({ source, target, journals, options }) => {
  await assert.rejects(copyDocumentFiles({ ...options, beforePublish: async () => { throw new CopyInterrupted(); } }), CopyInterrupted);
  await targetAbsent(target);
  const recovered = await recoverPendingDocumentCopies({ sourcePath: source, journalDirectory: journals });
  assert.equal(recovered.rolledBack.length, 1); assert.equal(recovered.completed.length, 0); await targetAbsent(target); assert.deepEqual(await fs.readdir(journals), []);
}));