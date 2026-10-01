import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../../src/core/markdown-source.ts';
import {
  discardMarkdownDraft,
  discardMarkdownSaveLock,
  discardMarkdownSourceBackup,
  inspectMarkdownSaveLock,
  listMarkdownDrafts,
  listMarkdownSourceBackups,
  loadMarkdownDraft,
  recoverMarkdownSourceBackup,
  saveMarkdownDraft,
  saveMarkdownFile,
} from '../../src/main/markdown-store.ts';

const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const annotationSentinel = Buffer.from('annotation sentinel\r\n', 'utf8');
const canvasSentinel = Buffer.from('{"canvas":"sentinel"}\r\n', 'utf8');

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fixture(
  markdown: Buffer,
  options: { readonly companions?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-markdown-save-'));
  const documentPath = path.join(directory, 'sample.md');
  const annotationPath = documentPath + '.annotations.yaml';
  const canvasPath = documentPath + '.mermarkd.json';
  const draftDirectory = path.join(directory, 'app-data', 'markdown-drafts');
  const hasCompanions = options.companions !== false;
  await writeFile(documentPath, markdown);
  if (hasCompanions) {
    await writeFile(annotationPath, annotationSentinel);
    await writeFile(canvasPath, canvasSentinel);
  }
  return {
    directory,
    documentPath,
    annotationPath,
    canvasPath,
    draftDirectory,
    markdown,
    hasCompanions,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cleanupFixture(f: Fixture): Promise<void> {
  await rm(f.directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25,
  });
}

async function assertCompanionsUntouched(f: Fixture): Promise<void> {
  if (f.hasCompanions) {
    assert.deepEqual(await readFile(f.annotationPath), annotationSentinel);
    assert.deepEqual(await readFile(f.canvasPath), canvasSentinel);
  } else {
    assert.equal(await exists(f.annotationPath), false);
    assert.equal(await exists(f.canvasPath), false);
  }
}

async function filesRecursively(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(entryPath));
    else files.push(entryPath);
  }
  return files;
}

async function assertNoTemporaryOrLockFiles(directory: string): Promise<void> {
  const leaked = (await filesRecursively(directory)).filter((filePath) =>
    path.basename(filePath).endsWith('.tmp') ||
    path.basename(filePath).endsWith('.mermarkd-save.lock'));
  assert.deepEqual(leaked, []);
}

function saveInput(f: Fixture, content: string, bomByteLength: 0 | 3) {
  return {
    documentPath: f.documentPath,
    draftDirectory: f.draftDirectory,
    expectedSourceSha256: digest(f.markdown),
    content,
    bomByteLength,
  };
}

async function assertDraftCandidate(
  draftDirectory: string,
  revision: { readonly draftPath: string; readonly draftSha256: string },
  content: string,
  bomByteLength: 0 | 3,
  relationship?: 'recoverable' | 'already-saved' | 'conflict' | 'source-missing',
) {
  const inventory = await listMarkdownDrafts(draftDirectory);
  const draft = inventory.drafts.find((candidate) => candidate.draftPath === revision.draftPath);
  assert.ok(draft);
  assert.equal(draft.draftSha256, revision.draftSha256);
  assert.equal(digest(await readFile(draft.draftPath)), revision.draftSha256);
  assert.deepEqual(
    Buffer.from(encodeMarkdownBytes(draft.content, draft.format.bomByteLength)),
    Buffer.from(encodeMarkdownBytes(content, bomByteLength)),
  );
  if (relationship !== undefined) assert.equal(draft.relationship, relationship);
  return draft;
}

async function savedSourceBackup(
  result: Awaited<ReturnType<typeof saveMarkdownFile>>,
) {
  assert.equal(result.status, 'saved');
  if (result.status !== 'saved') {
    throw new Error('Expected a saved Markdown result.');
  }
  assert.equal(result.changed, true);
  assert.ok(result.sourceBackup);
  const inventory = await listMarkdownSourceBackups(result.documentPath);
  assert.deepEqual(inventory.unreadableBackups, []);
  const listed = inventory.backups.find(
    (backup) => backup.backupPath === result.sourceBackup?.backupPath,
  );
  assert.ok(listed);
  assert.equal(listed.backupSha256, result.sourceBackup.backupSha256);
  return result.sourceBackup;
}

async function discardSavedSourceBackup(
  result: Awaited<ReturnType<typeof saveMarkdownFile>>,
): Promise<void> {
  const backup = await savedSourceBackup(result);
  assert.equal((await discardMarkdownSourceBackup({
    documentPath: result.documentPath,
    backupPath: backup.backupPath,
    expectedBackupSha256: backup.backupSha256,
  })).status, 'discarded');
}

function twoPartyBarrier(onArrival?: (value: string) => void) {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (value: string): Promise<void> => {
    onArrival?.(value);
    arrivals += 1;
    if (arrivals === 2) release();
    await released;
  };
}

test('no-op preserves BOM, CRLF, no trailing newline, exact bytes, SHA, and mtime', async () => {
  const original = Buffer.concat([bom, Buffer.from('# 标题\r\n正文 e\u0301 😀', 'utf8')]);
  const f = await fixture(original);
  try {
    const oldTime = new Date(Date.now() - 60_000);
    await utimes(f.documentPath, oldTime, oldTime);
    const before = await stat(f.documentPath);
    const decoded = decodeMarkdownBytes(original);
    const result = await saveMarkdownFile(
      saveInput(f, decoded.content, decoded.format.bomByteLength),
    );

    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.equal(result.changed, false);
    assert.equal(result.sourceSha256, digest(original));
    assert.equal(result.draftRetained, false);
    assert.equal(result.sourceBackup, null);
    assert.deepEqual(result.cleanupWarnings, []);
    assert.deepEqual(await readFile(f.documentPath), original);
    assert.equal((await stat(f.documentPath)).mtimeMs, before.mtimeMs);
    assert.equal((await loadMarkdownDraft(f.documentPath, f.draftDirectory)).status, 'none');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a changed file exposes fully synced same-directory candidate bytes before commit', async () => {
  const original = Buffer.concat([bom, Buffer.from('# 标题\r\n旧正文\r\n末行', 'utf8')]);
  const content = '# 标题\r\n新正文 😀\r\n末行';
  const candidate = Buffer.from(encodeMarkdownBytes(content, 3));
  const f = await fixture(original);
  let syncObserved = false;
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 3), {
      afterTemporaryFileSync: async (temporaryPath, documentPath) => {
        syncObserved = true;
        assert.equal(path.dirname(temporaryPath), path.dirname(documentPath));
        assert.deepEqual(await readFile(documentPath), original);
        assert.deepEqual(await readFile(temporaryPath), candidate);
      },
    });

    assert.equal(syncObserved, true);
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.equal(result.changed, true);
    assert.equal(result.sourceSha256, digest(candidate));
    assert.deepEqual(await readFile(f.documentPath), candidate);
    assert.equal((await loadMarkdownDraft(f.documentPath, f.draftDirectory)).status, 'none');
    const sourceBackup = await savedSourceBackup(result);
    assert.deepEqual(await readFile(sourceBackup.backupPath), original);
    const staleDiscard = await discardMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: sourceBackup.backupPath,
      expectedBackupSha256: digest(Buffer.from('stale successful backup', 'utf8')),
    });
    assert.equal(staleDiscard.status, 'conflict');
    assert.deepEqual(await readFile(sourceBackup.backupPath), original);
    assert.equal((await discardMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: sourceBackup.backupPath,
      expectedBackupSha256: sourceBackup.backupSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a source-changed conflict preserves the exact candidate generation', async () => {
  const f = await fixture(Buffer.from('# 标题\r\n原文\r\n', 'utf8'));
  const content = '# 标题\r\n应用内修改\r\n';
  const external = Buffer.from('# 标题\r\n外部修改\r\n', 'utf8');
  try {
    await writeFile(f.documentPath, external);
    const result = await saveMarkdownFile(saveInput(f, content, 0));
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'source-changed');
    assert.equal(result.currentSourceSha256, digest(external));
    assert.deepEqual(await readFile(f.documentPath), external);
    await assertDraftCandidate(f.draftDirectory, result, content, 0, 'conflict');

    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('an edit observed after the temporary file sync wins and leaves the draft recoverable', async () => {
  const f = await fixture(Buffer.from('# 标题\r\n原文\r\n', 'utf8'));
  const content = '# 标题\r\n应用内候选\r\n';
  const external = Buffer.from('# 标题\r\n同步后的外部修改\r\n', 'utf8');
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 0), {
      afterTemporaryFileSync: async () => {
        await writeFile(f.documentPath, external);
      },
    });
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'source-changed');
    assert.equal(result.currentSourceSha256, digest(external));
    assert.deepEqual(await readFile(f.documentPath), external);
    await assertDraftCandidate(f.draftDirectory, result, content, 0, 'conflict');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('format, BOM, newline, and mixed-line gates retain exact pending drafts', async (t) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly source: Buffer;
    readonly content: string;
    readonly bomByteLength: 0 | 3;
  }> = [
    {
      name: 'invalid UTF-8 source',
      source: Buffer.from([0xff, 0xfe, 0x23, 0x20, 0x78]),
      content: '# repaired',
      bomByteLength: 0,
    },
    {
      name: 'BOM mismatch',
      source: Buffer.from('# 标题\r\n原文\r\n', 'utf8'),
      content: '# 标题\r\n候选\r\n',
      bomByteLength: 3,
    },
    {
      name: 'line-ending normalization',
      source: Buffer.from('# 标题\r\n原文\r\n', 'utf8'),
      content: '# 标题\n候选\n',
      bomByteLength: 0,
    },
    {
      name: 'mixed source line endings',
      source: Buffer.from('# 标题\r\n第一行\n第二行', 'utf8'),
      content: '# 标题\r\n已编辑\n第二行',
      bomByteLength: 0,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const f = await fixture(entry.source);
      try {
        const result = await saveMarkdownFile(saveInput(f, entry.content, entry.bomByteLength));
        assert.equal(result.status, 'pending-draft');
        if (result.status !== 'pending-draft') return;
        assert.equal(result.reason, 'unsupported-format');
        assert.deepEqual(await readFile(f.documentPath), entry.source);
        await assertDraftCandidate(
          f.draftDirectory,
          result,
          entry.content,
          entry.bomByteLength,
          'recoverable',
        );
        assert.equal((await discardMarkdownDraft({
          documentPath: f.documentPath,
          draftDirectory: f.draftDirectory,
          draftPath: result.draftPath,
          expectedDraftSha256: result.draftSha256,
        })).status, 'discarded');
        await assertCompanionsUntouched(f);
        await assertNoTemporaryOrLockFiles(f.directory);
      } finally {
        await cleanupFixture(f);
      }
    });
  }
});

test('a draft stays loadable, listable, and discardable after source deletion', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  try {
    const draft = await saveMarkdownDraft(saveInput(f, '# 标题\n恢复内容\n', 0));
    await rm(f.documentPath);
    const loaded = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.draft.draftPath, draft.draftPath);
    assert.equal(loaded.draft.relationship, 'source-missing');
    assert.equal(loaded.draft.currentSourceSha256, null);
    assert.equal(loaded.branches.length, 0);
    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 1);
    assert.equal(inventory.drafts[0].relationship, 'source-missing');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: draft.draftPath,
      expectedDraftSha256: draft.draftSha256,
    })).status, 'discarded');
    assert.equal((await loadMarkdownDraft(f.documentPath, f.draftDirectory)).status, 'none');
    assert.equal((await listMarkdownDrafts(f.draftDirectory)).drafts.length, 0);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('barrier-interleaved saves produce one winner and one recoverable loser', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const contentA = '# 标题\n候选 A\n';
  const contentB = '# 标题\n候选 B\n';
  const persistedPaths: string[] = [];
  const afterDraftPersisted = twoPartyBarrier((draftPath) => persistedPaths.push(draftPath));
  try {
    const results = await Promise.all([
      saveMarkdownFile(saveInput(f, contentA, 0), { afterDraftPersisted }),
      saveMarkdownFile(saveInput(f, contentB, 0), { afterDraftPersisted }),
    ]);
    const saved = results.filter((result) => result.status === 'saved');
    const conflicts = results.filter((result) => result.status === 'conflict');
    assert.equal(persistedPaths.length, 2);
    assert.equal(new Set(persistedPaths).size, 2);
    assert.equal(saved.length, 1);
    assert.equal(conflicts.length, 1);
    const winner = saved[0];
    const loser = conflicts[0];
    assert.equal(winner.status, 'saved');
    assert.equal(loser.status, 'conflict');
    if (winner.status !== 'saved' || loser.status !== 'conflict') return;
    assert.ok(loser.reason === 'busy' || loser.reason === 'source-changed');
    assert.equal(digest(await readFile(f.documentPath)), winner.candidateSha256);
    const loserContent =
      loser.candidateSha256 === digest(encodeMarkdownBytes(contentA, 0)) ? contentA : contentB;
    await assertDraftCandidate(f.draftDirectory, loser, loserContent, 0, 'conflict');
    const loaded = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.draft.draftPath, loser.draftPath);
    assert.equal(loaded.branches.length, 0);
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: loser.draftPath,
      expectedDraftSha256: loser.draftSha256,
    })).status, 'discarded');
    await discardSavedSourceBackup(winner);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('two branches from the same previousDraft both survive as immutable generations', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const branchPaths: string[] = [];
  try {
    const base = await saveMarkdownDraft(saveInput(f, '# 标题\n基础草稿\n', 0));
    const afterDraftPersisted = twoPartyBarrier((draftPath) => branchPaths.push(draftPath));
    const previousDraft = { draftPath: base.draftPath, draftSha256: base.draftSha256 };
    const branches = await Promise.all([
      saveMarkdownDraft({
        ...saveInput(f, '# 标题\n分支 A\n', 0),
        previousDraft,
      }, { afterDraftPersisted }),
      saveMarkdownDraft({
        ...saveInput(f, '# 标题\n分支 B\n', 0),
        previousDraft,
      }, { afterDraftPersisted }),
    ]);
    assert.equal(branchPaths.length, 2);
    assert.equal(new Set(branchPaths).size, 2);
    assert.equal(await exists(base.draftPath), false);
    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 2);
    assert.deepEqual(
      inventory.drafts.map((draft) => draft.content).sort(),
      ['# 标题\n分支 A\n', '# 标题\n分支 B\n'].sort(),
    );
    assert.ok(inventory.drafts.every((draft) => draft.relationship === 'recoverable'));
    const loaded = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.branches.length, 1);
    for (const branch of branches) {
      assert.equal((await discardMarkdownDraft({
        documentPath: f.documentPath,
        draftDirectory: f.draftDirectory,
        draftPath: branch.draftPath,
        expectedDraftSha256: branch.draftSha256,
      })).status, 'discarded');
    }
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('draft generations for two documents remain isolated in one directory', async () => {
  const f = await fixture(Buffer.from('# A\n原文\n', 'utf8'));
  const documentB = path.join(f.directory, 'second.md');
  const sourceB = Buffer.from('# B\n原文\n', 'utf8');
  try {
    await writeFile(documentB, sourceB);
    const draftA = await saveMarkdownDraft(saveInput(f, '# A\n草稿\n', 0));
    const draftB = await saveMarkdownDraft({
      documentPath: documentB,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: digest(sourceB),
      content: '# B\n草稿\n',
      bomByteLength: 0,
    });
    const loadedA = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    const loadedB = await loadMarkdownDraft(documentB, f.draftDirectory);
    assert.equal(loadedA.status, 'available');
    assert.equal(loadedB.status, 'available');
    if (loadedA.status !== 'available' || loadedB.status !== 'available') return;
    assert.equal(loadedA.draft.content, '# A\n草稿\n');
    assert.equal(loadedB.draft.content, '# B\n草稿\n');
    assert.equal(loadedA.branches.length, 0);
    assert.equal(loadedB.branches.length, 0);
    assert.equal((await listMarkdownDrafts(f.draftDirectory)).drafts.length, 2);
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: draftA.draftPath,
      expectedDraftSha256: draftA.draftSha256,
    })).status, 'discarded');
    assert.equal((await loadMarkdownDraft(f.documentPath, f.draftDirectory)).status, 'none');
    assert.equal((await loadMarkdownDraft(documentB, f.draftDirectory)).status, 'available');
    assert.equal((await discardMarkdownDraft({
      documentPath: documentB,
      draftDirectory: f.draftDirectory,
      draftPath: draftB.draftPath,
      expectedDraftSha256: draftB.draftSha256,
    })).status, 'discarded');
    assert.equal(await exists(documentB + '.annotations.yaml'), false);
    assert.equal(await exists(documentB + '.mermarkd.json'), false);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a malformed generation is reported alongside a valid generation', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  try {
    const valid = await saveMarkdownDraft(saveInput(f, '# 标题\n有效草稿\n', 0));
    const filename = path.basename(valid.draftPath);
    const marker = '.markdown.pending.';
    const key = filename.slice(0, filename.indexOf(marker));
    const malformedPath = path.join(
      f.draftDirectory,
      key + marker + Date.now().toString().padStart(13, '0') +
        '-' + randomUUID() + '.json',
    );
    const malformedBytes = Buffer.from('{broken', 'utf8');
    await writeFile(malformedPath, malformedBytes);
    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 1);
    assert.equal(inventory.drafts[0].draftPath, valid.draftPath);
    assert.equal(inventory.unreadableDrafts.length, 1);
    assert.equal(inventory.unreadableDrafts[0].draftPath, malformedPath);
    assert.equal(inventory.unreadableDrafts[0].reason, 'invalid');
    assert.equal(inventory.unreadableDrafts[0].draftSha256, digest(malformedBytes));
    const loaded = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.draft.draftPath, valid.draftPath);
    assert.equal(loaded.unreadableDrafts.length, 1);
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: malformedPath,
      expectedDraftSha256: digest(malformedBytes),
    })).status, 'discarded');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: valid.draftPath,
      expectedDraftSha256: valid.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a lock owned by a dead PID is inspected and removed only by explicit version', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.equal(child.status, 0);
  assert.ok(child.pid);
  const lockPath = f.documentPath + '.mermarkd-save.lock';
  const lockBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'markdown-save-lock',
    documentPath: f.documentPath,
    ownerToken: randomUUID(),
    pid: child.pid,
    createdAt: new Date().toISOString(),
  }) + '\n', 'utf8');
  try {
    await writeFile(lockPath, lockBytes);
    const inspected = await inspectMarkdownSaveLock(f.documentPath);
    assert.equal(inspected.status, 'locked');
    if (inspected.status !== 'locked') return;
    assert.equal(inspected.pid, child.pid);
    assert.equal(inspected.processAlive, false);
    assert.equal(inspected.lockSha256, digest(lockBytes));
    assert.equal((await discardMarkdownSaveLock({
      documentPath: f.documentPath,
      expectedLockSha256: inspected.lockSha256,
    })).status, 'discarded');
    assert.equal((await inspectMarkdownSaveLock(f.documentPath)).status, 'missing');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('an unknown lock is retained and blocks the save while its draft is recoverable', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const lockPath = f.documentPath + '.mermarkd-save.lock';
  const unknown = Buffer.from('foreign lock', 'utf8');
  try {
    await writeFile(lockPath, unknown);
    const inspected = await inspectMarkdownSaveLock(f.documentPath);
    assert.equal(inspected.status, 'unreadable');
    if (inspected.status !== 'unreadable') return;
    assert.equal(inspected.lockSha256, digest(unknown));
    const refused = await discardMarkdownSaveLock({
      documentPath: f.documentPath,
      expectedLockSha256: inspected.lockSha256,
    });
    assert.equal(refused.status, 'unreadable');
    assert.deepEqual(await readFile(lockPath), unknown);
    const result = await saveMarkdownFile(saveInput(f, '# 标题\n候选\n', 0));
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'busy');
    assert.deepEqual(await readFile(lockPath), unknown);
    await assertDraftCandidate(f.draftDirectory, result, '# 标题\n候选\n', 0, 'recoverable');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await rm(lockPath);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a committed save returns saved plus a warning when draft cleanup fails', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const content = '# 标题\n已提交\n';
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 0), {
      removeDraft: async () => {
        throw new Error('simulated cleanup failure');
      },
    });
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.equal(result.changed, true);
    assert.equal(result.draftRetained, true);
    assert.ok(result.cleanupWarnings.includes('saved-draft-retained'));
    assert.deepEqual(await readFile(f.documentPath), Buffer.from(encodeMarkdownBytes(content, 0)));
    await assertDraftCandidate(f.draftDirectory, result, content, 0, 'already-saved');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await discardSavedSourceBackup(result);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('saving Markdown does not create absent annotation or canvas sidecars', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'), { companions: false });
  try {
    const result = await saveMarkdownFile(saveInput(f, '# 标题\n候选\n', 0));
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.deepEqual(await readFile(f.documentPath), Buffer.from('# 标题\n候选\n', 'utf8'));
    await discardSavedSourceBackup(result);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('an external recreation after the source move is preserved with exact draft and backup recovery', async () => {
  const original = Buffer.from('# 标题\r\n原文\r\n', 'utf8');
  const content = '# 标题\r\n应用内候选\r\n';
  const external = Buffer.from('# 标题\r\n外部重建\r\n', 'utf8');
  const f = await fixture(original);
  let movedBackupPath: string | null = null;
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 0), {
      afterSourceMovedToBackup: async (backupPath, documentPath) => {
        movedBackupPath = backupPath;
        assert.equal(await exists(documentPath), false);
        assert.deepEqual(await readFile(backupPath), original);
        await writeFile(documentPath, external);
      },
    });

    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(result.reason, 'source-changed');
    assert.equal(result.currentSourceSha256, digest(external));
    assert.ok(result.cleanupWarnings.includes('source-backup-retained'));
    assert.deepEqual(await readFile(f.documentPath), external);
    await assertDraftCandidate(f.draftDirectory, result, content, 0, 'conflict');

    const backupInventory = await listMarkdownSourceBackups(f.documentPath);
    assert.deepEqual(backupInventory.unreadableBackups, []);
    assert.equal(backupInventory.backups.length, 1);
    const backup = backupInventory.backups[0];
    assert.equal(backup.backupPath, movedBackupPath);
    assert.equal(backup.backupSha256, digest(original));
    assert.deepEqual(await readFile(backup.backupPath), original);

    const staleDiscard = await discardMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: backup.backupPath,
      expectedBackupSha256: digest(Buffer.from('stale backup version', 'utf8')),
    });
    assert.equal(staleDiscard.status, 'conflict');
    if (staleDiscard.status === 'conflict') {
      assert.equal(staleDiscard.currentBackupSha256, digest(original));
    }
    assert.deepEqual(await readFile(backup.backupPath), original);
    assert.equal((await discardMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: backup.backupPath,
      expectedBackupSha256: backup.backupSha256,
    })).status, 'discarded');
    assert.equal((await listMarkdownSourceBackups(f.documentPath)).backups.length, 0);
    assert.deepEqual(await readFile(f.documentPath), external);

    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a crash after moving the source leaves an exact backup that can restore the missing file', async () => {
  const original = Buffer.concat([
    bom,
    Buffer.from('# 标题\r\n崩溃前原文\r\n末行', 'utf8'),
  ]);
  const content = '# 标题\r\n未发布候选\r\n末行';
  const f = await fixture(original);
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 3), {
      afterSourceMovedToBackup: async (backupPath, documentPath) => {
        assert.equal(await exists(documentPath), false);
        assert.deepEqual(await readFile(backupPath), original);
        throw new Error('simulated crash after source move');
      },
    });
    assert.equal(result.status, 'pending-draft');
    if (result.status !== 'pending-draft') return;
    assert.equal(result.reason, 'source-missing');
    assert.equal(result.currentSourceSha256, null);
    assert.ok(result.cleanupWarnings.includes('source-backup-retained'));
    assert.equal(await exists(f.documentPath), false);

    const backupInventory = await listMarkdownSourceBackups(f.documentPath);
    assert.deepEqual(backupInventory.unreadableBackups, []);
    assert.equal(backupInventory.backups.length, 1);
    const backup = backupInventory.backups[0];
    assert.equal(backup.backupSha256, digest(original));
    assert.deepEqual(await readFile(backup.backupPath), original);

    const staleRecovery = await recoverMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: backup.backupPath,
      expectedBackupSha256: digest(Buffer.from('stale backup version', 'utf8')),
    });
    assert.equal(staleRecovery.status, 'conflict');
    assert.equal(await exists(f.documentPath), false);
    assert.deepEqual(await readFile(backup.backupPath), original);

    const recovered = await recoverMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: backup.backupPath,
      expectedBackupSha256: backup.backupSha256,
    });
    assert.equal(recovered.status, 'restored');
    if (recovered.status !== 'restored') return;
    assert.equal(recovered.sourceSha256, digest(original));
    assert.equal(recovered.backupRetained, false);
    assert.deepEqual(await readFile(f.documentPath), original);
    assert.equal((await listMarkdownSourceBackups(f.documentPath)).backups.length, 0);
    assert.equal((await discardMarkdownSourceBackup({
      documentPath: f.documentPath,
      backupPath: backup.backupPath,
      expectedBackupSha256: backup.backupSha256,
    })).status, 'missing');

    await assertDraftCandidate(f.draftDirectory, result, content, 3, 'recoverable');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a fsynced orphan draft temp remains recoverable when exclusive publication fails', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const content = '# 标题\n未发布但持久的草稿\n';
  try {
    await assert.rejects(
      saveMarkdownDraft(saveInput(f, content, 0), {
        publishDraft: async () => {
          throw new Error('simulated draft publication failure');
        },
        removeTemporaryFile: async () => {
          throw new Error('simulated orphan cleanup failure');
        },
      }),
      /publication failure/,
    );

    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 1);
    assert.equal(inventory.unreadableDrafts.length, 0);
    const orphan = inventory.drafts[0];
    assert.ok(orphan.draftPath.endsWith('.tmp'));
    assert.equal(orphan.content, content);
    assert.equal(orphan.relationship, 'recoverable');
    assert.equal(
      digest(encodeMarkdownBytes(orphan.content, orphan.format.bomByteLength)),
      digest(encodeMarkdownBytes(content, 0)),
    );

    const loaded = await loadMarkdownDraft(f.documentPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.draft.draftPath, orphan.draftPath);
    assert.equal(loaded.draft.draftSha256, orphan.draftSha256);
    assert.equal(loaded.branches.length, 0);
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: orphan.draftPath,
      expectedDraftSha256: orphan.draftSha256,
    })).status, 'discarded');
    assert.equal((await loadMarkdownDraft(f.documentPath, f.draftDirectory)).status, 'none');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a temp retained after draft publication is listed and can be discarded exactly', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const content = '# 标题\n已发布的草稿\n';
  try {
    const draft = await saveMarkdownDraft(saveInput(f, content, 0), {
      removeTemporaryFile: async () => {
        throw new Error('simulated post-publication cleanup failure');
      },
    });
    assert.deepEqual(draft.cleanupWarnings, ['temporary-file-retained']);

    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 1);
    assert.equal(inventory.drafts[0].draftPath, draft.draftPath);
    assert.equal(inventory.retainedTemporaryDrafts.length, 1);
    const retained = inventory.retainedTemporaryDrafts[0];
    assert.ok(retained.draftPath.endsWith('.tmp'));
    assert.equal(retained.draftSha256, draft.draftSha256);
    assert.equal(retained.content, content);

    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: retained.draftPath,
      expectedDraftSha256: retained.draftSha256,
    })).status, 'discarded');
    const afterCleanup = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(afterCleanup.drafts.length, 1);
    assert.equal(afterCleanup.retainedTemporaryDrafts.length, 0);
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: draft.draftPath,
      expectedDraftSha256: draft.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a draft created through a symlink alias remains loadable after the target is deleted', async () => {
  const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
  const targetDirectory = path.join(f.directory, 'symlink-target');
  const aliasDirectory = path.join(f.directory, 'symlink-alias');
  const targetPath = path.join(targetDirectory, 'linked.md');
  const aliasPath = path.join(aliasDirectory, 'linked.md');
  const source = Buffer.from('# 链接目标\n原文\n', 'utf8');
  try {
    await mkdir(targetDirectory);
    await writeFile(targetPath, source);
    // A directory junction exercises the same stable alias identity on
    // Windows without requiring the file-symlink developer privilege.
    await symlink(targetDirectory, aliasDirectory, 'junction');

    const content = '# 链接目标\n别名草稿\n';
    const draft = await saveMarkdownDraft({
      documentPath: aliasPath,
      draftDirectory: f.draftDirectory,
      expectedSourceSha256: digest(source),
      content,
      bomByteLength: 0,
    });
    assert.equal(draft.documentIdentityPath, aliasPath);
    assert.equal(path.normalize(draft.documentPath), path.normalize(targetPath));
    await rm(targetPath);

    const loaded = await loadMarkdownDraft(aliasPath, f.draftDirectory);
    assert.equal(loaded.status, 'available');
    if (loaded.status !== 'available') return;
    assert.equal(loaded.draft.draftPath, draft.draftPath);
    assert.equal(loaded.draft.documentIdentityPath, aliasPath);
    assert.equal(path.normalize(loaded.draft.documentPath), path.normalize(targetPath));
    assert.equal(loaded.draft.content, content);
    assert.equal(loaded.draft.relationship, 'source-missing');
    assert.equal(loaded.branches.length, 0);

    assert.equal((await discardMarkdownDraft({
      documentPath: aliasPath,
      draftDirectory: f.draftDirectory,
      draftPath: draft.draftPath,
      expectedDraftSha256: draft.draftSha256,
    })).status, 'discarded');
    assert.equal((await loadMarkdownDraft(aliasPath, f.draftDirectory)).status, 'none');
    assert.equal(await exists(aliasPath + '.annotations.yaml'), false);
    assert.equal(await exists(aliasPath + '.mermarkd.json'), false);
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('a denied candidate publication restores the exact original and retains the candidate draft', async () => {
  const original = Buffer.concat([
    bom,
    Buffer.from('# 标题\r\n发布前原文\r\n末行', 'utf8'),
  ]);
  const content = '# 标题\r\n无法发布的候选\r\n末行';
  const f = await fixture(original);
  try {
    const result = await saveMarkdownFile(saveInput(f, content, 3), {
      publishDocument: async () => {
        throw Object.assign(new Error('simulated publish denial'), { code: 'EPERM' });
      },
    });

    assert.equal(result.status, 'pending-draft');
    if (result.status !== 'pending-draft') return;
    assert.equal(result.reason, 'read-only');
    assert.equal(result.currentSourceSha256, digest(original));
    assert.deepEqual(await readFile(f.documentPath), original);
    const backupInventory = await listMarkdownSourceBackups(f.documentPath);
    assert.deepEqual(backupInventory, { backups: [], unreadableBackups: [] });
    await assertDraftCandidate(f.draftDirectory, result, content, 3, 'recoverable');
    assert.equal((await discardMarkdownDraft({
      documentPath: f.documentPath,
      draftDirectory: f.draftDirectory,
      draftPath: result.draftPath,
      expectedDraftSha256: result.draftSha256,
    })).status, 'discarded');
    await assertCompanionsUntouched(f);
    await assertNoTemporaryOrLockFiles(f.directory);
  } finally {
    await cleanupFixture(f);
  }
});

test('active and unknown document locks block source-backup recovery and discard', async (t) => {
  const cases = [
    {
      name: 'active lock',
      bytes(documentPath: string) {
        return Buffer.from(JSON.stringify({
          schemaVersion: 1,
          kind: 'markdown-save-lock',
          documentPath,
          ownerToken: randomUUID(),
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }) + '\n', 'utf8');
      },
    },
    {
      name: 'unknown lock',
      bytes() {
        return Buffer.from('unknown lock payload', 'utf8');
      },
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const f = await fixture(Buffer.from('# 标题\n原文\n', 'utf8'));
      const lockPath = f.documentPath + '.mermarkd-save.lock';
      try {
        const result = await saveMarkdownFile(saveInput(f, '# 标题\n已保存\n', 0));
        assert.equal(result.status, 'saved');
        if (result.status !== 'saved') return;
        const backup = await savedSourceBackup(result);
        const lockBytes = entry.bytes(f.documentPath);
        await writeFile(lockPath, lockBytes);

        const recoverResult = await recoverMarkdownSourceBackup({
          documentPath: f.documentPath,
          backupPath: backup.backupPath,
          expectedBackupSha256: backup.backupSha256,
        });
        assert.equal(recoverResult.status, 'locked');
        const discardResult = await discardMarkdownSourceBackup({
          documentPath: f.documentPath,
          backupPath: backup.backupPath,
          expectedBackupSha256: backup.backupSha256,
        });
        assert.equal(discardResult.status, 'locked');
        assert.deepEqual(await readFile(lockPath), lockBytes);
        assert.equal(digest(await readFile(backup.backupPath)), backup.backupSha256);

        await rm(lockPath);
        assert.equal((await discardMarkdownSourceBackup({
          documentPath: f.documentPath,
          backupPath: backup.backupPath,
          expectedBackupSha256: backup.backupSha256,
        })).status, 'discarded');
        await assertCompanionsUntouched(f);
        await assertNoTemporaryOrLockFiles(f.directory);
      } finally {
        await cleanupFixture(f);
      }
    });
  }
});
