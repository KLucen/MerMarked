import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeDocumentDeparture } from '../src/core/document-departure.ts';

const initial = { documentKey: 1, epoch: 'first', revision: 3, content: '正文😀', dirty: true };
test('clean and cancelled departures never save or discard', async () => {
  const unexpected = async () => { throw Error('must not mutate'); };
  assert.equal(await authorizeDocumentDeparture(() => ({ ...initial, dirty: false }), unexpected, unexpected), 'allow');
  assert.equal(await authorizeDocumentDeparture(() => initial, async () => 'cancel', unexpected), 'cancel');
});
test('dialog permission rejects a changed document, revision or buffer before mutation', async () => {
  for (const changed of [{ documentKey: 2 }, { epoch: 'other' }, { revision: 4 }, { content: '另一段' }, { dirty: false }]) {
    let current = initial;
    assert.equal(await authorizeDocumentDeparture(() => current, async () => { current = { ...initial, ...changed }; return 'save'; },
      async () => { throw Error('stale permission must not mutate'); }), 'stale');
  }
});
test('save must succeed for the same content; first save may replace its editor epoch', async () => {
  for (const [result, after, expected] of [[false, initial, 'failed'], [true, { ...initial, dirty: false, epoch: 'saved-path' }, 'allow'],
    [true, { ...initial, dirty: false, content: 'unexpected' }, 'stale'], [true, { ...initial, dirty: false, documentKey: 2 }, 'stale'],
    [true, initial, 'stale']]) {
    let current = initial;
    assert.equal(await authorizeDocumentDeparture(() => current, async () => 'save', async choice => {
      assert.equal(choice, 'save'); current = after; return result;
    }), expected);
  }
});
test('explicit discard can reload different disk text, but cannot authorize a different document', async () => {
  let current = initial;
  assert.equal(await authorizeDocumentDeparture(() => current, async () => 'discard', async () => {
    current = { ...initial, epoch: 'reloaded', content: '外部磁盘文本', dirty: false }; return true;
  }), 'allow');
});
