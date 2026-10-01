import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor, sectionHintForSelection } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');
const bom = Buffer.from([0xef, 0xbb, 0xbf]);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceBytes(content, withBom = false) {
  const body = Buffer.from(content, 'utf8');
  return withBom ? Buffer.concat([bom, body]) : body;
}

function byteIndex(bytes, exact, occurrence = 0) {
  const needle = Buffer.from(exact, 'utf8');
  let from = 0;
  let found = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    found = bytes.indexOf(needle, from);
    assert.ok(found >= 0, `fixture selection is missing: ${exact} occurrence ${occurrence + 1}`);
    from = found + needle.length;
  }
  return found;
}

function recordAnchor(content, bytes, exact, occurrence = 0) {
  const bomByteLength = bytes.subarray(0, 3).equals(bom) ? 3 : 0;
  const startByte = byteIndex(bytes, exact, occurrence);
  const selection = {
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    displayQuote: exact,
  };
  return makeAnnotationAnchor(
    content,
    bomByteLength,
    digest(bytes),
    selection,
    sectionHintForSelection(content, bomByteLength, selection),
  );
}

function buildFixture() {
  const oldContent = [
    '# A7.4 批注映射',
    '',
    'SAFE_BEFORE 保持在编辑区之前。',
    '',
    '## 编辑区',
    '',
    '这一行包含 OVERLAP_TARGET，并会被改写。',
    '',
    '## 重复区',
    '',
    'REPEAT_SAFE 第一次出现。',
    '',
    'REPEAT_SAFE 第二次出现。',
    '',
  ].join('\r\n');
  const newContent = oldContent.replace('OVERLAP_TARGET', 'CHANGED_SEGMENT_LONGER');
  const oldBytes = sourceBytes(oldContent, true);
  const newBytes = sourceBytes(newContent, true);
  const createdAt = '2026-09-20T08:00:00Z';
  const sidecar = {
    schemaVersion: 1,
    source: { sha256: digest(oldBytes), encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [{ id: 'tag-proof', name: '验收' }],
    annotations: [
      {
        id: 'note-before', kind: 'note', color: 'sage',
        anchor: recordAnchor(oldContent, oldBytes, 'SAFE_BEFORE'),
        note: '编辑区之前的便签。', tagId: 'tag-proof', createdAt, updatedAt: createdAt,
      },
      {
        id: 'note-overlap', kind: 'note', color: 'amber',
        anchor: recordAnchor(oldContent, oldBytes, 'OVERLAP_TARGET'),
        note: '与编辑范围相交，应保留旧锚点。', createdAt, updatedAt: createdAt,
      },
      {
        id: 'highlight-repeat-one', kind: 'highlight', color: 'blue',
        anchor: recordAnchor(oldContent, oldBytes, 'REPEAT_SAFE', 0), createdAt, updatedAt: createdAt,
      },
      {
        id: 'note-repeat-two', kind: 'note', color: 'rose',
        anchor: recordAnchor(oldContent, oldBytes, 'REPEAT_SAFE', 1),
        note: '第二处同文锚点也应按坐标安全移动。', tagId: 'tag-proof', createdAt, updatedAt: createdAt,
      },
    ],
  };
  return { oldContent, newContent, oldBytes, newBytes, sidecar, createdAt };
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = tabs.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      // Electron publishes the endpoint after the browser process is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the packaged Electron page.');
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function waitFor(cdp, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function launch(port, appData, localAppData, userData) {
  const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
    cwd: root,
    env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
    stdio: 'ignore',
  });
  const page = await waitForEndpoint(port);
  const cdp = await connect(page);
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer startup');
  return { child, cdp };
}

async function stop(running) {
  if (!running) return;
  running.cdp.close();
  if (running.child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(running.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      running.child.kill('SIGKILL');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function dropFile(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => {
    const element = document.querySelector('[data-markdown-drop-target]');
    if (!element) throw new Error('Drop target missing.');
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data });
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click();
    return true;
  })()`);
  assert.equal(clicked, true, `enabled button missing: ${selector}`);
}

async function pressShortcut(cdp, key) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: `Key${key.toUpperCase()}`, modifiers: 2,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers: 2,
  });
}

async function replaceEditorText(cdp, exact, replacement) {
  const focused = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const offset = textarea.value.indexOf(${JSON.stringify(exact)});
    if (offset < 0) return false;
    textarea.focus();
    textarea.setSelectionRange(offset, offset + ${exact.length});
    return true;
  })()`);
  assert.equal(focused, true, `editor text missing: ${exact}`);
  await cdp.send('Input.insertText', { text: replacement });
}

async function snapshot(filePath) {
  const [bytes, details] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
  return { digest: digest(bytes), bytes, mtimeNs: details.mtimeNs };
}

function assertSnapshotUnchanged(before, after, label) {
  assert.equal(after.digest, before.digest, `${label} bytes changed`);
  assert.equal(after.mtimeNs, before.mtimeNs, `${label} was rewritten with equal bytes`);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function annotationById(model, id) {
  const record = model.annotations.find((item) => item.id === id);
  assert.ok(record, `annotation is missing: ${id}`);
  return record;
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a7-4-e2e-'));
const appData = path.join(workspace, 'appdata');
const localAppData = path.join(workspace, 'localappdata');
const userData = path.join(workspace, 'user-data');
const documentPath = path.join(workspace, 'a7-4-mapping.md');
const sidecarPath = `${documentPath}.annotations.yaml`;
const noSidecarPath = path.join(workspace, 'a7-4-no-sidecar.md');
const noSidecarAnnotationPath = `${noSidecarPath}.annotations.yaml`;
const fixture = buildFixture();
const noSidecarOldContent = '# 无批注文件\r\n\r\nNO_SIDECAR_MARKER\r\n';
const noSidecarNewContent = noSidecarOldContent.replace('NO_SIDECAR_MARKER', 'NO_SIDECAR_SAVED');

await Promise.all([
  mkdir(appData, { recursive: true }),
  mkdir(localAppData, { recursive: true }),
  mkdir(userData, { recursive: true }),
]);
await writeFile(documentPath, fixture.oldBytes);
await writeFile(sidecarPath, serializeAnnotationYaml(fixture.sidecar), 'utf8');
await writeFile(noSidecarPath, sourceBytes(noSidecarOldContent));

let running;
try {
  const firstPort = 10_350 + Math.floor(Math.random() * 150);
  running = await launch(firstPort, appData, localAppData, userData);
  await dropFile(running.cdp, documentPath);
  await waitFor(running.cdp, `document.querySelector('.document-name')?.textContent === 'a7-4-mapping.md' &&
    document.querySelector('.annotation-summary')?.textContent.includes('4 条记录')`, 'mapping fixture');

  const yamlBeforeEdit = await snapshot(sidecarPath);
  await click(running.cdp, '[data-mode="editor"]');
  await waitFor(running.cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'mapping source editor');
  await replaceEditorText(running.cdp, 'OVERLAP_TARGET', 'CHANGED_SEGMENT_LONGER');
  await waitFor(running.cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`,
    'dirty mapping editor');
  assertSnapshotUnchanged(yamlBeforeEdit, await snapshot(sidecarPath), 'dirty mapping sidecar');
  assert.deepEqual(await readFile(documentPath), fixture.oldBytes, 'dirty edit must not write Markdown');

  await pressShortcut(running.cdp, 's');
  await waitFor(running.cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    (document.querySelector('.notice')?.textContent ?? '').includes('已同步 3 条批注位置') &&
    (document.querySelector('.notice')?.textContent ?? '').includes('1 条与编辑范围相交')`,
  'saved Markdown and annotation mapping');
  assert.deepEqual(await readFile(documentPath), fixture.newBytes);

  const savedYamlSnapshot = await snapshot(sidecarPath);
  assert.notEqual(savedYamlSnapshot.digest, yamlBeforeEdit.digest, 'explicit save should update the sidecar');
  const saved = parseAnnotationYaml(savedYamlSnapshot.bytes.toString('utf8'));
  assert.equal(saved.source.sha256, digest(fixture.newBytes));
  assert.deepEqual(saved.tags, fixture.sidecar.tags);
  assert.deepEqual(saved.annotations.map((item) => item.id), fixture.sidecar.annotations.map((item) => item.id));

  const safeBefore = annotationById(saved, 'note-before');
  const safeRepeatOne = annotationById(saved, 'highlight-repeat-one');
  const safeRepeatTwo = annotationById(saved, 'note-repeat-two');
  const overlap = annotationById(saved, 'note-overlap');
  const expectedSafeBefore = recordAnchor(fixture.newContent, fixture.newBytes, 'SAFE_BEFORE');
  const expectedRepeatOne = recordAnchor(fixture.newContent, fixture.newBytes, 'REPEAT_SAFE', 0);
  const expectedRepeatTwo = recordAnchor(fixture.newContent, fixture.newBytes, 'REPEAT_SAFE', 1);

  assert.deepEqual(safeBefore.anchor, expectedSafeBefore);
  assert.deepEqual(safeRepeatOne.anchor, expectedRepeatOne);
  assert.deepEqual(safeRepeatTwo.anchor, expectedRepeatTwo);
  for (const record of [safeBefore, safeRepeatOne, safeRepeatTwo]) {
    const original = annotationById(fixture.sidecar, record.id);
    assert.equal(record.createdAt, original.createdAt);
    assert.notEqual(record.updatedAt, original.updatedAt);
    assert.equal(record.color, original.color);
    assert.equal(record.note, original.note);
    assert.equal(record.tagId, original.tagId);
  }
  assert.deepEqual(overlap, annotationById(fixture.sidecar, 'note-overlap'),
    'overlapping annotation must retain its old basis, range, and timestamp');

  await click(running.cdp, '[data-mode="reader"]');
  await waitFor(running.cdp, `document.querySelector('.annotation-summary')?.textContent.includes('4 条记录') &&
    document.querySelector('.annotation-summary')?.textContent.includes('1 条待定位')`,
  'mixed anchor state after save');
  const immediateView = await running.cdp.evaluate(`window.mermarkd.loadAnnotations()`);
  assert.equal(immediateView.status, 'ready');
  assert.equal(immediateView.count, 4);
  assert.equal(immediateView.unresolvedCount, 1);
  assert.equal(immediateView.relocatableCount, 0);

  await dropFile(running.cdp, noSidecarPath);
  await waitFor(running.cdp, `document.querySelector('.document-name')?.textContent === 'a7-4-no-sidecar.md' &&
    document.querySelector('.annotation-summary')?.textContent.includes('0 条记录')`, 'no-sidecar fixture');
  assert.equal(await fileExists(noSidecarAnnotationPath), false);
  await click(running.cdp, '[data-mode="editor"]');
  await waitFor(running.cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'no-sidecar editor');
  await replaceEditorText(running.cdp, 'NO_SIDECAR_MARKER', 'NO_SIDECAR_SAVED');
  await waitFor(running.cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`,
    'dirty no-sidecar editor');
  assert.equal(await fileExists(noSidecarAnnotationPath), false, 'dirty edit must not create a sidecar');
  await pressShortcut(running.cdp, 's');
  await waitFor(running.cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    (document.querySelector('.notice')?.textContent ?? '').includes('未创建空 sidecar')`,
  'no-sidecar source save');
  assert.deepEqual(await readFile(noSidecarPath), sourceBytes(noSidecarNewContent));
  assert.equal(await fileExists(noSidecarAnnotationPath), false, 'save must not create an empty sidecar');

  await stop(running);
  running = undefined;

  const restartPort = 10_550 + Math.floor(Math.random() * 150);
  running = await launch(restartPort, appData, localAppData, userData);
  await dropFile(running.cdp, documentPath);
  await waitFor(running.cdp, `document.querySelector('.document-name')?.textContent === 'a7-4-mapping.md' &&
    document.querySelector('.annotation-summary')?.textContent.includes('4 条记录') &&
    document.querySelector('.annotation-summary')?.textContent.includes('1 条待定位')`,
  'restarted mixed anchor state');
  const restartedView = await running.cdp.evaluate(`window.mermarkd.loadAnnotations()`);
  assert.equal(restartedView.status, 'ready');
  assert.equal(restartedView.count, 4);
  assert.equal(restartedView.unresolvedCount, 1);
  assert.equal(restartedView.relocatableCount, 0);
  assert.deepEqual(
    restartedView.items.map((item) => [item.id, item.status]),
    [
      ['note-before', 'resolved'],
      ['note-overlap', 'unresolved'],
      ['highlight-repeat-one', 'resolved'],
      ['note-repeat-two', 'resolved'],
    ],
  );
  const persistedAfterRestart = parseAnnotationYaml(await readFile(sidecarPath, 'utf8'));
  assert.deepEqual(persistedAfterRestart, saved, 'restart must not rewrite the mapped sidecar');

  console.log(JSON.stringify({
    status: 'passed',
    mappedAnnotations: 3,
    unresolvedAnnotations: 1,
    dirtySidecarFrozen: true,
    noEmptySidecar: true,
    restartVerified: true,
    markdownSha256: digest(fixture.newBytes),
  }));
} finally {
  await stop(running);
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
