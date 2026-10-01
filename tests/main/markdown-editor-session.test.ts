import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decodeMarkdownBytes, encodeMarkdownBytes } from '../../src/core/markdown-source.ts';
import { MarkdownEditorSession } from '../../src/main/markdown-editor-session.ts';
import {
  listMarkdownDrafts,
  listMarkdownSourceBackups,
  saveMarkdownDraft,
} from '../../src/main/markdown-store.ts';
import type { OpenedMarkdownDocument } from '../../src/types/reader-api.d.ts';

const bom = Buffer.from([0xef, 0xbb, 0xbf]);

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(source: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-editor-session-'));
  const documentPath = path.join(directory, 'sample.md');
  const draftDirectory = path.join(directory, 'app-data', 'markdown-drafts');
  const annotationPath = `${documentPath}.annotations.yaml`;
  const canvasPath = `${documentPath}.mermarkd.json`;
  await writeFile(documentPath, source);
  await writeFile(annotationPath, 'annotation sentinel\n', 'utf8');
  await writeFile(canvasPath, '{"canvas":"sentinel"}\n', 'utf8');
  const decoded = decodeMarkdownBytes(source);
  const document: OpenedMarkdownDocument = {
    path: documentPath,
    name: path.basename(documentPath),
    content: decoded.content,
    sourceSha256: digest(source),
    bomByteLength: decoded.format.bomByteLength,
  };
  return { directory, documentPath, draftDirectory, annotationPath, canvasPath, document };
}

async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

test('editor session checkpoints and saves exact BOM + CRLF bytes without touching sidecars', async () => {
  const original = Buffer.concat([bom, Buffer.from('# 标题\r\n原文', 'utf8')]);
  const f = await fixture(original);
  try {
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-a');
    assert.equal(session.view().dirty, false);
    assert.equal(session.view().format.lineEnding, 'crlf');
    assert.equal(session.view().format.hasTrailingLineEnding, false);
    assert.deepEqual(session.view().sourceFormat, session.view().format);

    const content = '# 标题\r\n修改后的正文';
    const updated = session.update({ epoch: 'epoch-a', revision: 1, content });
    assert.equal(updated.dirty, true);
    const checkpoint = await session.persistDraft({ epoch: 'epoch-a', revision: 1, content });
    assert.equal(checkpoint.draftPersisted, true);
    assert.equal((await listMarkdownDrafts(f.draftDirectory)).drafts.length, 1);

    const result = await session.save({ epoch: 'epoch-a', revision: 1, content });
    assert.equal(result.status, 'saved');
    if (result.status !== 'saved') return;
    assert.equal(result.changed, true);
    assert.equal(result.editor.dirty, false);
    assert.equal(result.editor.sourceFormat.lineEnding, 'crlf');
    assert.deepEqual(await readFile(f.documentPath), Buffer.from(encodeMarkdownBytes(content, 3)));
    assert.equal((await readFile(f.annotationPath, 'utf8')), 'annotation sentinel\n');
    assert.equal((await readFile(f.canvasPath, 'utf8')), '{"canvas":"sentinel"}\n');
    assert.ok(result.editor.latestSourceBackupId);
    assert.equal((await listMarkdownSourceBackups(f.documentPath)).backups.length, 1);
    await session.discardLatestSourceBackup(result.editor.latestSourceBackupId);
    assert.equal((await listMarkdownSourceBackups(f.documentPath)).backups.length, 0);
  } finally {
    await cleanup(f.directory);
  }
});

test('external source changes win while the dirty candidate remains recoverable', async () => {
  const original = Buffer.from('# Original\n', 'utf8');
  const f = await fixture(original);
  try {
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-b');
    const candidate = '# Candidate\n';
    session.update({ epoch: 'epoch-b', revision: 1, content: candidate });
    const external = Buffer.from('# External\n', 'utf8');
    await writeFile(f.documentPath, external);

    const result = await session.save({ epoch: 'epoch-b', revision: 1, content: candidate });
    assert.equal(result.status, 'conflict');
    assert.equal(result.editor.dirty, true);
    assert.equal(session.document.sourceSha256, digest(original));
    assert.equal(session.document.content, '# Original\n');
    assert.deepEqual(await readFile(f.documentPath), external);
    const inventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(inventory.drafts.length, 1);
    assert.equal(inventory.drafts[0].content, candidate);
    assert.equal(inventory.drafts[0].expectedSourceSha256, digest(original));
    assert.equal(inventory.drafts[0].relationship, 'conflict');
    assert.deepEqual((await listMarkdownSourceBackups(f.documentPath)).backups, []);

    const revisedCandidate = '# Candidate revised\n';
    const checkpoint = await session.persistDraft({
      epoch: 'epoch-b',
      revision: 2,
      content: revisedCandidate,
    });
    assert.equal(checkpoint.dirty, true);
    const revisedInventory = await listMarkdownDrafts(f.draftDirectory);
    assert.equal(revisedInventory.drafts.length, 1);
    assert.equal(revisedInventory.drafts[0].content, revisedCandidate);
    assert.equal(revisedInventory.drafts[0].expectedSourceSha256, digest(original));
    assert.equal(revisedInventory.drafts[0].relationship, 'conflict');
    assert.equal(session.document.sourceSha256, digest(original));
    assert.deepEqual(await readFile(f.documentPath), external);
  } finally {
    await cleanup(f.directory);
  }
});

test('a recoverable crash draft requires explicit adoption and keeps its exact generation', async () => {
  const original = Buffer.from('# Original\n', 'utf8');
  const f = await fixture(original);
  try {
    const first = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-c1');
    const candidate = '# Recovered\n';
    await first.persistDraft({ epoch: 'epoch-c1', revision: 1, content: candidate });

    const reopened = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-c2');
    const recovery = reopened.view().recoveryDrafts[0];
    assert.ok(recovery);
    assert.equal(recovery.relationship, 'recoverable');
    const restored = reopened.restoreRecoveryDraft(recovery.id);
    assert.equal(restored.content, candidate);
    assert.equal(restored.dirty, true);
    assert.equal(restored.draftPersisted, true);
  } finally {
    await cleanup(f.directory);
  }
});

test('a conflict draft cannot be rebound to a newer disk baseline', async () => {
  const original = Buffer.from('# Original\n', 'utf8');
  const f = await fixture(original);
  try {
    const first = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-d1');
    await first.persistDraft({ epoch: 'epoch-d1', revision: 1, content: '# Candidate\n' });
    const external = Buffer.from('# External\n', 'utf8');
    await writeFile(f.documentPath, external);
    const externalDocument: OpenedMarkdownDocument = {
      ...f.document,
      content: '# External\n',
      sourceSha256: digest(external),
    };
    const reopened = await MarkdownEditorSession.create(externalDocument, f.draftDirectory, 'epoch-d2');
    const recovery = reopened.view().recoveryDrafts[0];
    assert.equal(recovery.relationship, 'conflict');
    assert.throws(() => reopened.restoreRecoveryDraft(recovery.id), /不能直接覆盖/);
    assert.equal(reopened.view().dirty, false);
  } finally {
    await cleanup(f.directory);
  }
});

test('stale epochs and revisions are rejected and mixed-newline sources stay read-only', async () => {
  const f = await fixture(Buffer.from('# A\r\nB\n', 'utf8'));
  try {
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-e');
    assert.equal(session.view().editable, false);
    assert.match(session.view().readOnlyReason ?? '', /混用/);
    assert.throws(
      () => session.update({ epoch: 'wrong', revision: 1, content: f.document.content }),
      /文档已切换/,
    );
  } finally {
    await cleanup(f.directory);
  }
});

test('an editor update rejects accidental whole-document newline normalization', async () => {
  const original = Buffer.from('# A\r\nB\r\n', 'utf8');
  const f = await fixture(original);
  try {
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-f');
    assert.equal(session.view().sourceFormat.lineEnding, 'crlf');
    assert.throws(
      () => session.update({ epoch: 'epoch-f', revision: 1, content: '# A\nB\n' }),
      /换行格式/,
    );
    assert.equal(session.view().revision, 0);
    assert.equal(session.view().dirty, false);
    assert.deepEqual(await readFile(f.documentPath), original);
  } finally {
    await cleanup(f.directory);
  }
});

test('sourceFormat remains the persisted baseline while the candidate gains its first newline', async () => {
  const original = Buffer.from('# One line', 'utf8');
  const f = await fixture(original);
  try {
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-format');
    const view = session.update({
      epoch: 'epoch-format',
      revision: 1,
      content: '# One line\nSecond line',
    });
    assert.equal(view.sourceFormat.lineEnding, 'none');
    assert.equal(view.sourceFormat.hasTrailingLineEnding, false);
    assert.equal(view.format.lineEnding, 'lf');
    assert.equal(view.format.hasTrailingLineEnding, false);
  } finally {
    await cleanup(f.directory);
  }
});

test('successful save keeps unrelated recovery branches visible against the new baseline', async () => {
  const original = Buffer.from('# Original\n', 'utf8');
  const f = await fixture(original);
  try {
    for (const content of ['# Branch A\n', '# Branch B\n']) {
      await saveMarkdownDraft({
        documentPath: f.documentPath,
        draftDirectory: f.draftDirectory,
        expectedSourceSha256: digest(original),
        content,
        bomByteLength: 0,
      });
    }
    const session = await MarkdownEditorSession.create(f.document, f.draftDirectory, 'epoch-g');
    assert.equal(session.view().recoveryDrafts.length, 2);

    const saved = await session.save({
      epoch: 'epoch-g',
      revision: 1,
      content: '# Saved\n',
    });
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') return;
    assert.equal(saved.editor.recoveryDrafts.length, 2);
    assert.ok(saved.editor.recoveryDrafts.every((draft) => draft.relationship === 'conflict'));
    assert.deepEqual(
      (await listMarkdownDrafts(f.draftDirectory)).drafts.map((draft) => draft.content).sort(),
      ['# Branch A\n', '# Branch B\n'].sort(),
    );
    assert.ok(saved.editor.latestSourceBackupId);
    await session.discardLatestSourceBackup(saved.editor.latestSourceBackupId);
  } finally {
    await cleanup(f.directory);
  }
});
