import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commitDocumentTransaction, inspectDocumentTransaction, listDocumentTransactions, prepareDocumentTransaction, recoverDocumentTransaction } from '../../src/main/document-transaction.ts';
import { serializeCanvasJson, reconcileCanvasState } from '../../src/core/canvas-state.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { mapAnnotationSidecarThroughEdit } from '../../src/core/annotation-edit-map.ts';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';

function bytes(value: string) { return Buffer.from(value, 'utf8'); }
function sha(value: Uint8Array) { return createHash('sha256').update(value).digest('hex'); }
async function bundle(markdown: string, root: string, withSidecars = true) {
  const md = bytes(markdown);
  const source = { bytes: md, content: markdown, sha256: sha(md) };
  const canvas = withSidecars ? serializeCanvasJson((await reconcileCanvasState(null, source, (() => { let i = 0; return () => `card-${i++}`; })())).model) : null;
  return { markdown: md, annotations: null, canvas: canvas ? bytes(canvas) : null };
}
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a8-1-'));
  const documentPath = path.join(root, 'doc.md');
  const before = await bundle('# A\nbody\n# B\nsecond\n', root);
  await writeFile(documentPath, before.markdown);
  await writeFile(`${documentPath}.mermarkd.json`, before.canvas!);
  return { root, documentPath, before };
}
async function cleanup(root: string) { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }

test('prepares and commits Markdown plus a new canvas sidecar with durable journal', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    assert.equal((await listDocumentTransactions(documentPath)).at(0)?.status, 'prepared');
    const result = await commitDocumentTransaction(documentPath, ref);
    assert.equal(result.status, 'committed');
    assert.equal((await readFile(documentPath, 'utf8')).includes('changed'), true);
    assert.equal((await listDocumentTransactions(documentPath)).at(0)?.status, 'committed');
  } finally { await cleanup(root); }
});

test('completion receipt distinguishes retained historical snapshots from unfinished transactions after later edits', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    assert.equal((await commitDocumentTransaction(documentPath, ref)).status, 'committed');
    await writeFile(documentPath, '# A\nlater external edit\n# B\nsecond\n');
    const historical = (await listDocumentTransactions(documentPath))[0];
    assert.equal(historical.status, 'conflict'); assert.equal(historical.completed, true);
    await writeFile(`${documentPath}.mermarkd-txn.${ref.id}.committed.json`, '{}\n');
    assert.equal((await listDocumentTransactions(documentPath))[0].completed, false);
    assert.equal((await recoverDocumentTransaction(documentPath, ref)).status, 'conflict');
    assert.equal(await readFile(documentPath, 'utf8'), '# A\nlater external edit\n# B\nsecond\n');
  } finally { await cleanup(root); }
});

test('read-only inspection works while Markdown is displaced and does not consume snapshots or locks', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nrecover candidate\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    assert.equal((await commitDocumentTransaction(documentPath, ref, { afterDisplaced: async () => { throw new Error('interrupt'); } })).status, 'pending');
    const names = await readdir(root);
    const inspected = await inspectDocumentTransaction(documentPath, ref);
    assert.equal(inspected.current.markdown, 'interrupted');
    assert.deepEqual(inspected.before.markdown, before.markdown); assert.deepEqual(inspected.after.markdown, after.markdown);
    assert.deepEqual(await readdir(root), names); await assert.rejects(readFile(documentPath), { code: 'ENOENT' });
    assert.equal((await recoverDocumentTransaction(documentPath, ref)).status, 'committed');
    assert.equal((await listDocumentTransactions(documentPath))[0].completed, true);
  } finally { await cleanup(root); }
});

test('does not overwrite an external file recreated after Markdown displacement', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nexternal-safe\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    const result = await commitDocumentTransaction(documentPath, ref, {
      afterDisplaced: async () => { await writeFile(documentPath, 'external replacement\n'); },
    });
    assert.equal(result.status, 'conflict');
    assert.equal(await readFile(documentPath, 'utf8'), 'external replacement\n');
  } finally { await cleanup(root); }
});

test('recovery rolls forward an interrupted transaction and preserves exact originals as artifacts', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nrecovered\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    const first = await commitDocumentTransaction(documentPath, ref, {
      afterDisplaced: async (kind) => { if (kind === 'markdown') throw new Error('simulated crash'); },
    });
    assert.equal(first.status, 'pending');
    assert.equal((await listDocumentTransactions(documentPath)).at(0)?.status, 'interrupted');
    const recovered = await recoverDocumentTransaction(documentPath, ref);
    assert.equal(recovered.status, 'committed');
    assert.equal(await readFile(documentPath, 'utf8'), '# A\nrecovered\n# B\nsecond\n');
    assert.ok((await readdir(root)).some((name) => name.includes('.displaced')));
  } finally { await cleanup(root); }
});

test('active foreign locks remain recoverable without mutation', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    await writeFile(`${documentPath}.mermarkd-save.lock`, JSON.stringify({ schemaVersion: 1, kind: 'markdown-save-lock', documentPath, ownerToken: '00000000-0000-0000-0000-000000000000', pid: process.pid, createdAt: new Date().toISOString() }));
    const result = await recoverDocumentTransaction(documentPath, ref);
    assert.equal(result.status, 'busy');
    assert.equal(await readFile(documentPath, 'utf8'), '# A\nbody\n# B\nsecond\n');
  } finally { await cleanup(root); }
});

test('all three files recover after real process exits at every displacement and publication point', async () => {
  for (const phase of ['afterDisplaced', 'beforePublished', 'afterPublished']) {
    for (const kind of ['markdown', 'annotations', 'canvas']) {
      const { root, documentPath, before } = await setup();
      try {
        const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
        const oldYaml = serializeAnnotationYaml({ schemaVersion: 1, source: { sha256: sha(before.markdown), encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] });
        const newYaml = serializeAnnotationYaml({ schemaVersion: 1, source: { sha256: sha(after.markdown), encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] });
        const baseline = { ...before, annotations: bytes(oldYaml) };
        const candidate = { ...after, annotations: bytes(newYaml) };
        await writeFile(`${documentPath}.annotations.yaml`, baseline.annotations);
        const ref = await prepareDocumentTransaction({ documentPath, before: baseline, after: candidate });
        await assert.rejects(promisify(execFile)(process.execPath, ['tests/fixtures/transaction-crash.mjs', documentPath, JSON.stringify(ref), phase, kind]),
          (error: unknown) => (error as { code?: number }).code === 37);
        const inventory = await listDocumentTransactions(documentPath);
        assert.ok(['interrupted', 'committed'].includes(inventory[0].status), `${phase} ${kind}`);
        assert.equal((await recoverDocumentTransaction(documentPath, ref)).status, 'committed', `${phase} ${kind}`);
        assert.deepEqual(await readFile(documentPath), candidate.markdown);
        assert.deepEqual(await readFile(`${documentPath}.annotations.yaml`), candidate.annotations);
        assert.deepEqual(await readFile(`${documentPath}.mermarkd.json`), candidate.canvas);
        assert.equal((await readdir(root)).some((name) => name.endsWith('.lock')), false);
      } finally { await cleanup(root); }
    }
  }
});

test('creates both missing sidecars and retains stale unchanged sidecars on source-only changes', async () => {
  const { root, documentPath, before } = await setup();
  try {
    await rm(`${documentPath}.mermarkd.json`);
    const baseline = { ...before, canvas: null };
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const yaml = bytes(serializeAnnotationYaml({ schemaVersion: 1, source: { sha256: sha(after.markdown), encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] }));
    const candidate = { ...after, annotations: yaml };
    const ref = await prepareDocumentTransaction({ documentPath, before: baseline, after: candidate });
    assert.equal((await commitDocumentTransaction(documentPath, ref)).status, 'committed');
    const changed = { ...candidate, markdown: bytes('# A\nanother\n# B\nsecond\n') };
    const second = await prepareDocumentTransaction({ documentPath, before: candidate, after: changed });
    assert.equal((await commitDocumentTransaction(documentPath, second)).status, 'committed');
    assert.deepEqual(await readFile(`${documentPath}.annotations.yaml`), yaml);
    assert.deepEqual(await readFile(`${documentPath}.mermarkd.json`), candidate.canvas);
  } finally { await cleanup(root); }
});

test('partial publication rejects externally changed YAML and preserves independent recovery snapshots', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    const result = await commitDocumentTransaction(documentPath, ref, { afterPublished: async (kind) => {
      if (kind === 'markdown') {
        await writeFile(documentPath, 'external in-place edit\n');
        throw new Error('stop');
      }
    } });
    assert.equal(result.status, 'pending');
    assert.equal((await recoverDocumentTransaction(documentPath, ref)).status, 'conflict');
    assert.deepEqual(await readFile(`${documentPath}.mermarkd-txn.${ref.id}.markdown.after`), after.markdown);
    assert.equal(await readFile(documentPath, 'utf8'), 'external in-place edit\n');
  } finally { await cleanup(root); }
});

test('mapped and unresolved annotation anchors must be proven against their declared source versions', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const content = before.markdown.toString('utf8');
    const startByte = content.indexOf('body');
    const anchor = makeAnnotationAnchor(content, 0, sha(before.markdown), { startByte, endByte: startByte + 4, sourceExact: 'body', displayQuote: 'body' });
    const model = { schemaVersion: 1 as const, source: { sha256: sha(before.markdown), encoding: 'utf-8' as const, coordinateSystem: 'utf8-byte' as const }, tags: [],
      annotations: [{ id: 'note', kind: 'note' as const, anchor, note: 'retained', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] };
    const baseline = { ...before, annotations: bytes(serializeAnnotationYaml(model)) };
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const mapping = await mapAnnotationSidecarThroughEdit(model,
      { bytes: before.markdown, content, sha256: sha(before.markdown) },
      { bytes: after.markdown, content: after.markdown.toString('utf8'), sha256: sha(after.markdown) }, '2026-10-01T01:00:00Z');
    await prepareDocumentTransaction({ documentPath, before: baseline, after: { ...after, annotations: bytes(serializeAnnotationYaml(mapping.model)) } });
    const forged = { ...mapping.model, annotations: [{ ...model.annotations[0], anchor: { ...anchor, basisSha256: sha(after.markdown) } }] };
    await assert.rejects(prepareDocumentTransaction({ documentPath, before: baseline, after: { ...after, annotations: bytes(serializeAnnotationYaml(forged)) } }));
    const rebased = { ...mapping.model, annotations: [{ ...model.annotations[0], anchor: { ...anchor, startByte: anchor.startByte + 1, endByte: anchor.endByte + 1 } }] };
    await assert.rejects(prepareDocumentTransaction({ documentPath, before: baseline, after: { ...after, annotations: bytes(serializeAnnotationYaml(rebased)) } }));
  } finally { await cleanup(root); }
});

test('source, YAML and canvas baselines are validated before a candidate can commit', async () => {
  const { root, documentPath, before } = await setup();
  try {
    const after = await bundle('# A\nchanged\n# B\nsecond\n', root);
    const ref = await prepareDocumentTransaction({ documentPath, before, after });
    const journalPath = `${documentPath}.mermarkd-txn.${ref.id}.journal.json`;
    await writeFile(journalPath, '{"forged":true}\n');
    await assert.rejects(commitDocumentTransaction(documentPath, ref));
    assert.equal(await readFile(documentPath, 'utf8'), '# A\nbody\n# B\nsecond\n');
  } finally { await cleanup(root); }
});
