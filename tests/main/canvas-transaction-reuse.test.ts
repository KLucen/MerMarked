import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { migrateCanvasStateV1ToV2, serializeCanvasStateJson } from '../../src/core/canvas-state-v2.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { inspectDocumentTransaction, listDocumentTransactions, prepareAndCommitDocumentTransaction, recoverDocumentTransaction } from '../../src/main/document-transaction.ts';

async function fixture(v2: boolean) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf3f-txn-'));
  const documentPath = path.join(directory, 'doc.md');
  const content = '# 同名😀\r\n正文é\r\n\r\n# 同名😀\r\n其他\r\n';
  const markdown = Buffer.from('\uFEFF' + content);
  const sha256 = createHash('sha256').update(markdown).digest('hex');
  let i = 0;
  const initial = (await reconcileCanvasState(null, { content, bytes: markdown, sha256 }, () => `c-${i++}`)).model;
  const model = v2 ? migrateCanvasStateV1ToV2(initial) : initial;
  const annotations = Buffer.from(serializeAnnotationYaml({ schemaVersion: 1, source: model.source, tags: [], annotations: [] }));
  const before = { markdown, annotations, canvas: Buffer.from(serializeCanvasStateJson(model)) };
  const moved = { ...model, cards: model.cards.map(card => ({ ...card, position: { x: 80, y: 120 } })) } as typeof model;
  const after = { ...before, canvas: Buffer.from(serializeCanvasStateJson(moved)) };
  await writeFile(documentPath, markdown);
  await writeFile(documentPath + '.annotations.yaml', annotations);
  await writeFile(documentPath + '.mermarkd.json', before.canvas);
  return { directory, documentPath, before, after, moved };
}
async function unchangedFiles(documentPath: string) {
  return Promise.all([documentPath, documentPath + '.annotations.yaml'].map(async file => ({ bytes: await readFile(file), mtime: (await stat(file)).mtimeMs })));
}

test('one-operation source reuse commits both canvas generations without writing Markdown or annotations', async () => {
  for (const v2 of [false, true]) {
    const fixtureValue = await fixture(v2);
    const { directory, documentPath, before, after } = fixtureValue;
    try {
      const original = await unchangedFiles(documentPath);
      const result = await prepareAndCommitDocumentTransaction({ documentPath, before, after });
      assert.equal(result.status, 'committed');
      assert.deepEqual(await readFile(documentPath + '.mermarkd.json'), after.canvas);
      assert.deepEqual(await unchangedFiles(documentPath), original);
      const inspected = await inspectDocumentTransaction(documentPath, result.ref);
      assert.deepEqual(inspected.after.canvas, after.canvas);
      assert.equal((await listDocumentTransactions(documentPath))[0].completed, true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('source reuse retains conflict detection and independent recovery after interrupted canvas publication', async () => {
  for (const conflict of [false, true]) {
    const { directory, documentPath, before, after } = await fixture(true);
    try {
      const original = await unchangedFiles(documentPath);
      const result = await prepareAndCommitDocumentTransaction({ documentPath, before, after }, {
        afterDisplaced: async (kind, destination) => {
          assert.equal(kind, 'canvas');
          if (conflict) await writeFile(destination, 'external canvas');
          else throw Error('interrupted');
        },
      });
      assert.equal(result.status, conflict ? 'conflict' : 'pending');
      const recovered = await recoverDocumentTransaction(documentPath, result.ref);
      assert.equal(recovered.status, conflict ? 'conflict' : 'committed');
      assert.deepEqual(await unchangedFiles(documentPath), original);
      assert.equal(await readFile(documentPath + '.mermarkd.json', 'utf8'), conflict ? 'external canvas' : after.canvas.toString());
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('current-basis forged anchors are rejected before journal or target writes', async () => {
  for (const v2 of [false, true]) {
    const { directory, documentPath, before, after, moved } = await fixture(v2);
    try {
      const original = await unchangedFiles(documentPath);
      const names = await readdir(directory);
      const forged = { ...moved, cards: moved.cards.map(card => ({ ...card, anchor: { ...card.anchor, bodySha256: '0'.repeat(64) } })) } as typeof moved;
      await assert.rejects(prepareAndCommitDocumentTransaction({ documentPath, before, after: { ...after, canvas: Buffer.from(serializeCanvasStateJson(forged)) } }));
      assert.deepEqual(await readdir(directory), names);
      assert.deepEqual(await unchangedFiles(documentPath), original);
      assert.deepEqual(await readFile(documentPath + '.mermarkd.json'), before.canvas);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
