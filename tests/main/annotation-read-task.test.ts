import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { AnnotationReadTask } from '../../src/main/annotation-read-task.ts';
import { readAndVerifyAnnotations, type AnnotationReadInput } from '../../src/main/annotation-read.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { relocateAnnotationSidecarCandidate } from '../../src/core/annotation-relocation.ts';

const input: AnnotationReadInput = { documentPath: '', draftDirectory: '', content: '', sourceSha256: '' };
class FakeWorker extends EventEmitter {
  terminated = 0;
  async terminate() { this.terminated++; return 0; }
}

test('superseded reads settle, release the worker and ignore queued replies', async () => {
  const workers: FakeWorker[] = [];
  const task = new AnnotationReadTask(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const first = task.run(input);
  const rejected = assert.rejects(first, /取消/);
  const stale = workers[0].listeners('message')[0];
  assert.equal(task.run({ ...input }), first, 'concurrent identical reads share one verification');
  const second = task.run({ ...input, revision: 1 });
  const result = { data: { ok: false as const, errorCode: 'sidecar-invalid' as const, reason: 'fixture' }, relocation: null };
  stale({ result });
  assert.equal(workers[1].terminated, 0);
  workers[1].emit('message', { result });
  assert.deepEqual(await second, result);
  await rejected;
  assert.deepEqual(workers.map(worker => worker.terminated), [1, 1]);
  assert.ok(workers.every(worker => worker.eventNames().length === 0));
});

test('worker failure, early exit, timeout and explicit cancellation never produce a usable result', async () => {
  for (const failure of ['error', 'exit', 'message', 'timeout', 'cancel']) {
    const worker = new FakeWorker();
    const task = new AnnotationReadTask(() => worker, 5);
    const result = task.run(input);
    const rejected = assert.rejects(result, /核验未能完成|取消/);
    if (failure === 'cancel') task.cancel();
    else if (failure !== 'timeout') worker.emit(failure, failure === 'message' ? { error: true } : 1);
    await rejected;
    assert.equal(worker.terminated, 1);
    assert.equal(worker.eventNames().length, 0);
  }
  await assert.rejects(new AnnotationReadTask(() => { throw Error('startup'); }).run(input), /核验未能完成/);
});

test('real background verification preserves independent byte/anchor checks and writes no files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-annotation-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, 'doc.md');
  const content = '# 标题😀\r\n\r\n唯一引文 é。\r\n\r\n重复\r\n\r\n重复\r\n';
  const bytes = Buffer.from('\uFEFF' + content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const exact = '唯一引文 é';
  const startByte = 3 + Buffer.byteLength(content.slice(0, content.indexOf(exact)));
  const anchor = { basisSha256: sha256, startByte, endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact, displayQuote: exact, prefix: '', suffix: '' };
  const timestamp = '2026-10-23T00:00:00Z';
  const model = { schemaVersion: 1 as const, source: { sha256, encoding: 'utf-8' as const, coordinateSystem: 'utf8-byte' as const },
    tags: [], annotations: [
      { id: 'valid', kind: 'highlight' as const, color: 'amber' as const, createdAt: timestamp, updatedAt: timestamp, anchor },
      { id: 'forged', kind: 'highlight' as const, color: 'amber' as const, createdAt: timestamp, updatedAt: timestamp,
        anchor: { ...anchor, displayQuote: '不同文字' } },
    ] };
  await writeFile(documentPath, bytes);
  await writeFile(documentPath + '.annotations.yaml', serializeAnnotationYaml(model));
  await writeFile(documentPath + '.mermarkd.json', '{"untouched":true}');
  const snapshot = () => Promise.all(['', '.annotations.yaml', '.mermarkd.json'].map(async suffix => ({
    bytes: await readFile(documentPath + suffix), mtime: (await stat(documentPath + suffix)).mtimeMs,
  })));
  const before = await snapshot();
  const request = { documentPath, draftDirectory: directory, content, sourceSha256: sha256 };
  const task = new AnnotationReadTask(workerData => new Worker(new URL('../../src/main/annotation-read.worker.ts', import.meta.url), { workerData }));
  const result = await task.run(request);
  const oracle = await relocateAnnotationSidecarCandidate(model, { bytes, content, sha256 }, timestamp);
  assert.deepEqual(result.relocation, oracle);
  assert.deepEqual(result.relocation?.items.map(item => item.status), ['unchanged', 'unresolved']);
  assert.deepEqual(await snapshot(), before);
  assert.ok(result.data.ok && !('sourceBytes' in result.data), 'large source bytes remain local to the verification worker');
  await assert.rejects(task.run({ ...request, content: content + 'forged' }), /核验未能完成/);
  assert.equal((await task.run({ ...request, sourceSha256: '0'.repeat(64) })).relocation, null);
  await writeFile(documentPath, bytes.subarray(0, bytes.length - 2));
  assert.equal((await task.run(request)).relocation, null, 'external source change is never verified against the old session');
});

test('malformed YAML and an absent sidecar retain their read-only/empty semantics', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-annotation-read-empty-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const documentPath = path.join(directory, 'doc.md');
  const content = '# document\n';
  await writeFile(documentPath, content);
  const request = { documentPath, draftDirectory: directory, content, sourceSha256: createHash('sha256').update(content).digest('hex') };
  const empty = await readAndVerifyAnnotations(request);
  assert.deepEqual(empty.relocation?.items, []);
  await writeFile(documentPath + '.annotations.yaml', 'malformed: [');
  const invalid = await readAndVerifyAnnotations(request);
  assert.equal(invalid.data.ok, false);
  assert.equal(invalid.relocation, null);
});
