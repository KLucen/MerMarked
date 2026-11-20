import assert from 'node:assert/strict';
import test from 'node:test';
import { createReaderEditSession } from '../../src/renderer/reader-edit-session.ts';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settled = () => new Promise(resolve => setImmediate(resolve));

function harness(onCommit = () => Promise.resolve(true)) {
  let dom = '正文';
  let focused = false;
  let connected = true;
  let activity = 0;
  let restores = 0;
  const activityChanges = [], commits = [], restrictions = [], drafts = [];
  const frames = [], tasks = [];
  const enqueue = queue => run => {
    const entry = { run, cancelled: false };
    queue.push(entry);
    return () => { entry.cancelled = true; };
  };
  const flush = (queue, stale = false) => {
    const entries = queue.splice(0);
    for (const entry of entries) if (stale || !entry.cancelled) entry.run();
  };
  const session = createReaderEditSession({
    sourceText: '正文',
    readText: () => connected ? dom : null,
    isFocused: () => focused,
    restoreChildren: () => { restores++; dom = '正文'; },
    onCommit: text => { commits.push(text); return onCommit(text); },
    onDraftChange: dirty => drafts.push(dirty),
    onCommittingChange: active => {
      activity += active ? 1 : -1;
      activityChanges.push(active);
      assert.ok(activity >= 0, 'an owned activity lease can only be released once');
    },
    onRestricted: (reason, draft) => restrictions.push({ reason, draft }),
    scheduler: { frame: enqueue(frames), task: enqueue(tasks) },
  });
  return {
    session, commits, restrictions, drafts, activityChanges,
    get dom() { return dom; },
    get activity() { return activity; },
    get restores() { return restores; },
    focus() { focused = true; session.focus(); },
    blur() { focused = false; session.blur(); },
    domOnly(text) { dom = text; },
    input(text) { dom = text; session.input(); },
    disconnect() { connected = false; },
    frame(stale) { flush(frames, stale); },
    task(stale) { flush(tasks, stale); },
    finish(stale) { flush(frames, stale); flush(tasks, stale); },
  };
}
function composeThenBlur(h) {
  h.focus();
  h.session.compositionStart();
  h.input('正文ni');
  h.blur();
}

test('blur during composition commits the final input following compositionend once', async () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  assert.equal(h.activity, 1, 'capture compositionend may now release global composing activity');
  assert.deepEqual(h.commits, []);
  h.input('正文你');
  h.finish();
  assert.deepEqual(h.commits, ['正文你']);
  assert.equal(h.activity, 1, 'the same lease covers the pending commit promise');
  await settled();
  assert.equal(h.activity, 0);
  assert.deepEqual(h.activityChanges, [true, false]);
});

test('a late final input between the frame and task postpones the DOM read', async () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.frame();
  h.input('正文你');
  h.task(true);
  assert.deepEqual(h.commits, [], 'a superseded task cannot publish the candidate');
  assert.equal(h.activity, 1);
  h.finish();
  await settled();
  assert.deepEqual(h.commits, ['正文你']);
  assert.deepEqual(h.activityChanges, [true, false]);
});

test('settling reads final live DOM when no final input event is delivered', async () => {
  const h = harness();
  composeThenBlur(h);
  h.domOnly('正文你');
  h.session.compositionEnd();
  h.finish();
  await settled();
  assert.deepEqual(h.commits, ['正文你']);
  assert.equal(h.activity, 0);
});

test('the usual final input before compositionend retains one commit', async () => {
  const h = harness();
  composeThenBlur(h);
  h.input('正文你');
  h.session.compositionEnd();
  h.finish();
  await settled();
  assert.deepEqual(h.commits, ['正文你']);
});

test('a blur just after compositionend still waits for final native text', async () => {
  const h = harness();
  h.focus();
  h.session.compositionStart();
  h.input('正文ni');
  h.session.compositionEnd();
  h.blur();
  h.input('正文你');
  assert.deepEqual(h.commits, []);
  h.finish();
  await settled();
  assert.deepEqual(h.commits, ['正文你']);
});

test('a focused completed composition settles without committing, then ordinary blur commits synchronously', async () => {
  const h = harness();
  h.focus();
  h.session.compositionStart();
  h.input('正文你');
  h.session.compositionEnd();
  h.finish();
  assert.deepEqual(h.commits, []);
  assert.equal(h.activity, 0);
  h.blur();
  assert.deepEqual(h.commits, ['正文你']);
  await settled();
  assert.equal(h.activity, 0);
});

test('composition cancellation with original DOM and no tail input finishes and unlocks', () => {
  const h = harness();
  composeThenBlur(h);
  h.domOnly('正文');
  h.session.compositionEnd();
  h.finish();
  assert.deepEqual(h.commits, []);
  assert.equal(h.drafts.at(-1), false);
  assert.equal(h.activity, 0);
  assert.deepEqual(h.activityChanges, [true, false]);
});

test('ordinary blur reads the latest DOM and invokes onCommit before returning', async () => {
  const h = harness();
  h.focus();
  h.input('正文旧');
  h.domOnly('正文新');
  h.blur();
  assert.deepEqual(h.commits, ['正文新']);
  assert.equal(h.activity, 1);
  await settled();
  assert.equal(h.activity, 0);
});

test('repeated blur while settling and committing cannot duplicate a shared edit', async () => {
  const response = deferred();
  const h = harness(() => response.promise);
  composeThenBlur(h);
  h.session.compositionEnd();
  h.input('正文你');
  h.blur(); h.blur();
  h.finish();
  h.blur(); h.blur();
  assert.deepEqual(h.commits, ['正文你']);
  assert.equal(h.activity, 1);
  response.resolve(true);
  await settled();
  h.blur();
  assert.equal(h.commits.length, 1);
  assert.deepEqual(h.activityChanges, [true, false]);
});

test('refocus cancels stale settling and leaves the draft for a later blur', async () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.input('正文你');
  h.frame();
  h.focus();
  h.finish(true);
  assert.deepEqual(h.commits, []);
  assert.equal(h.dom, '正文你');
  assert.equal(h.activity, 0);
  h.blur();
  assert.deepEqual(h.commits, ['正文你']);
  await settled();
});

test('a new composition rejects an already queued completion of the old one', async () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.frame();
  h.session.compositionStart();
  h.input('正文你好');
  h.finish(true);
  assert.deepEqual(h.commits, []);
  assert.equal(h.session.composing(), true);
  h.blur();
  h.session.compositionEnd();
  h.finish();
  await settled();
  assert.deepEqual(h.commits, ['正文你好']);
  assert.equal(h.activity, 0);
});

test('Escape restore invalidates a queued completion and late compositionend', () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.frame();
  h.session.restore();
  h.finish(true);
  h.session.compositionEnd();
  h.finish(true);
  h.blur();
  assert.deepEqual(h.commits, []);
  assert.equal(h.dom, '正文');
  assert.equal(h.drafts.at(-1), false);
  assert.equal(h.activity, 0);
  assert.equal(h.restores, 1);
});

test('unmount cancels scheduled work even when a cancelled scheduler callback runs', () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.frame();
  h.session.dispose();
  h.disconnect();
  h.finish(true);
  assert.deepEqual(h.commits, []);
  assert.equal(h.activity, 0);
  assert.equal(h.restores, 0);
});

test('source or identity replacement cannot use old document callbacks', async () => {
  for (const fail of [false, true]) {
    const response = deferred();
    const old = harness(() => response.promise);
    old.focus(); old.input('正文你'); old.blur();
    old.session.dispose();
    assert.equal(old.activity, 1, 'disposal cannot cancel an already emitted mutation');
    const replacement = harness();
    replacement.focus(); replacement.input('正文新文档');
    if (fail) response.reject(Error('old document failed'));
    else response.resolve(false);
    await settled();
    assert.equal(old.restores, 0);
    assert.deepEqual(old.restrictions, []);
    assert.equal(old.activity, 0);
    assert.equal(replacement.dom, '正文新文档');
    assert.deepEqual(replacement.restrictions, []);
  }
});

test('stale async replies cannot restore or report restrictions into a new focused edit or composition', async () => {
  for (const nextEdit of ['focus', 'compositionStart']) {
    for (const outcome of ['accept', 'reject', 'error']) {
      const response = deferred();
      const h = harness(() => response.promise);
      h.focus(); h.input('正文你'); h.blur();
      if (nextEdit === 'focus') h.focus();
      else h.session.compositionStart();
      h.input('正文你好');
      assert.equal(h.activity, 1, 'new editing cannot release a pending mutation lease');
      if (outcome === 'error') response.reject(Error('late failure'));
      else response.resolve(outcome === 'accept');
      await settled();
      assert.equal(h.dom, '正文你好');
      assert.equal(h.restores, 0);
      assert.deepEqual(h.restrictions, []);
      assert.equal(h.activity, 0);
    }
  }
});

test('an old completion cannot clear the draft notification owned by another block', async () => {
  const response = deferred();
  const first = harness(() => response.promise);
  first.focus(); first.input('正文第一块'); first.blur();
  const afterHandoff = first.drafts.length;
  const second = harness();
  second.focus(); second.input('正文第二块');
  response.resolve(true);
  await settled();
  assert.equal(first.drafts.length, afterHandoff, 'completion must not send a second clean notification');
  assert.equal(second.drafts.at(-1), true);
  assert.equal(second.dom, '正文第二块');
});

test('overlapping promises own separate leases through refocus, disposal and reverse completion', async () => {
  const first = deferred(), second = deferred();
  let call = 0;
  const h = harness(() => call++ === 0 ? first.promise : second.promise);
  h.focus(); h.input('正文第一版'); h.blur();
  h.focus(); h.input('正文第二版'); h.blur();
  assert.equal(h.activity, 2);
  h.session.dispose();
  assert.equal(h.activity, 2);
  second.reject(Error('later mutation failed'));
  await settled();
  assert.equal(h.activity, 1);
  first.resolve(false);
  await settled();
  assert.equal(h.activity, 0);
  assert.deepEqual(h.activityChanges, [true, true, false, false]);
  assert.deepEqual(h.restrictions, []);
  assert.equal(h.restores, 0);
});

test('a current rejected or failed commit retains the input in restriction feedback before restoring', async () => {
  for (const onCommit of [() => Promise.resolve(false), () => Promise.reject(Error('write failed')),
    () => { throw Error('synchronous failure'); }]) {
    const h = harness(onCommit);
    h.focus(); h.input('正文你'); h.blur();
    await settled();
    assert.equal(h.restrictions.length, 1);
    assert.equal(h.restrictions[0].draft, '正文你');
    assert.equal(h.restores, 1);
    assert.equal(h.activity, 0);
  }
});

test('invalid final native multiline text is retained for source editing and never committed', () => {
  const h = harness();
  composeThenBlur(h);
  h.session.compositionEnd();
  h.domOnly('正文\n你');
  h.finish();
  assert.deepEqual(h.commits, []);
  assert.equal(h.restrictions[0].draft, '正文\n你');
  assert.equal(h.restores, 1);
  assert.equal(h.activity, 0);
});
