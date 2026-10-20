import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasPreparationTask } from '../../src/renderer/canvas-preparation-task.ts';

class FakeWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  message;
  terminated = false;
  postMessage(message) { this.message = message; }
  terminate() { this.terminated = true; }
  reply(result, id = this.message.id) { this.onmessage?.({ data: { id, result } }); }
}

test('replacement and cancellation terminate parsing, settle callers and reject queued stale replies', async () => {
  const workers = [];
  const task = new CanvasPreparationTask(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
  const old = task.run('old', 0, null);
  const current = task.run('new', 3, null);
  assert.equal(await old, null); assert.equal(workers[0].terminated, true);
  workers[0].reply({ stale: true }); workers[1].reply({ wrongId: true }, -1);
  const result = { current: true }; workers[1].reply(result);
  assert.equal(await current, result); assert.equal(workers[1].terminated, true);
  const pending = task.run('pending', 0, null); task.cancel();
  assert.equal(await pending, null); assert.equal(workers[2].terminated, true);
});

test('worker creation, dispatch, error, decode and timeout failures settle without a synchronous fallback', async () => {
  assert.equal(await new CanvasPreparationTask(() => { throw Error('factory'); }).run('', 0, null), null);
  for (const kind of ['post', 'error', 'decode', 'response', 'timeout']) {
    const worker = new FakeWorker();
    if (kind === 'post') worker.postMessage = () => { throw Error('dispatch'); };
    const task = new CanvasPreparationTask(() => worker, 15);
    const pending = task.run('', 0, null);
    if (kind === 'error') worker.onerror({ preventDefault() {} });
    if (kind === 'decode') worker.onmessageerror({});
    if (kind === 'response') worker.onmessage({ data: { id: worker.message.id, error: true } });
    assert.equal(await pending, null); assert.equal(worker.terminated, true);
  }
});
