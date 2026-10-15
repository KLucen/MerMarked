import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeInputLeave } from '../src/core/input-leave.ts';

test('empty inputs allow leaving without asking; active writes and composition always block', async () => {
  let calls = 0;
  const confirm = async () => { calls++; return 'discard'; };
  assert.equal(await authorizeInputLeave(() => ({key:'a', kinds:[], busy:false}), confirm), 'allow');
  assert.equal(await authorizeInputLeave(() => ({key:'a', kinds:[], busy:true}), confirm), 'blocked');
  assert.equal(calls, 0);
});

test('return/cancel do not authorize discarding any input kind', async () => {
  const kinds = ['new-note', 'edit-note', 'reader-block', 'unapplied-input'];
  for (const answer of ['return','cancel']) {
    assert.equal(await authorizeInputLeave(() => ({key:'a', kinds, busy:false}), async (actual) => {
      assert.deepEqual(actual, kinds); return answer;
    }), answer);
  }
});

test('discard only authorizes the same document, revision, text, tag and anchor snapshot', async () => {
  let current = {key:'document-a:revision-1:note-one:tag-one:anchor-one', kinds:['new-note'], busy:false};
  assert.equal(await authorizeInputLeave(() => current, async () => 'discard'), 'allow');
  for (const change of ['document-b', 'revision-2', 'note-two', 'tag-two', 'anchor-two']) {
    assert.equal(await authorizeInputLeave(() => current, async () => {
      current = {...current, key:change}; return 'discard';
    }), 'blocked');
  }
});

test('a write started while the dialog was open invalidates discard permission', async () => {
  let current = {key:'a', kinds:['edit-note'], busy:false};
  assert.equal(await authorizeInputLeave(() => current, async () => {
    current = {...current, busy:true}; return 'discard';
  }), 'blocked');
});
