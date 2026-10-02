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

function annotationText(content, bytes, bomByteLength, exact, id) {
  const startByte = bytes.indexOf(Buffer.from(exact));
  assert.ok(startByte >= bomByteLength, `fixture selection is missing: ${exact}`);
  const selection = {
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    displayQuote: exact,
  };
  return serializeAnnotationYaml({
    schemaVersion: 1,
    source: { sha256: digest(bytes), encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [],
    annotations: [{
      id,
      kind: 'highlight',
      color: 'amber',
      anchor: makeAnnotationAnchor(
        content,
        bomByteLength,
        digest(bytes),
        selection,
        sectionHintForSelection(content, bomByteLength, selection),
      ),
      createdAt: '2026-09-29T08:00:00Z',
      updatedAt: '2026-09-29T08:00:00Z',
    }],
  });
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
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForNode(probe, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function dropFile(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    const element = document.querySelector('[data-markdown-drop-target]');
    if (!element) throw new Error('Drop target missing.');
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, top: bounds.top, width: bounds.width, height: bounds.height };
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

async function setInput(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, `input missing: ${selector}`);
}

async function insertEditorText(cdp, marker, inserted) {
  const focused = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const offset = textarea.value.indexOf(${JSON.stringify(marker)});
    if (offset < 0) return false;
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    return true;
  })()`);
  assert.equal(focused, true, `editor marker missing: ${marker}`);
  await cdp.send('Input.insertText', { text: inserted });
}

async function snapshot(filePath) {
  const [bytes, details] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
  return { digest: digest(bytes), bytes, mtimeNs: details.mtimeNs };
}

function assertSnapshotUnchanged(before, after, label) {
  assert.equal(after.digest, before.digest, `${label} bytes changed`);
  assert.equal(after.mtimeNs, before.mtimeNs, `${label} was rewritten with equal bytes`);
}

async function walkFiles(directory) {
  const result = [];
  async function visit(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child);
      else result.push(child);
    }
  }
  await visit(directory);
  return result.sort();
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a7-3b-e2e-'));
const appData = path.join(workspace, 'appdata');
const localAppData = path.join(workspace, 'localappdata');
const userData = path.join(workspace, 'user-data');
const firstPath = path.join(workspace, 'a7-3b-roundtrip.md');
const firstSidecar = `${firstPath}.annotations.yaml`;
const firstCanvas = `${firstPath}.mermarkd.json`;
const secondPath = path.join(workspace, 'a7-3b-conflict.md');
const secondSidecar = `${secondPath}.annotations.yaml`;
const secondCanvas = `${secondPath}.mermarkd.json`;
const thirdPath = path.join(workspace, 'b5-reader-edit.md');
const thirdSidecar = `${thirdPath}.annotations.yaml`;
const thirdCanvas = `${thirdPath}.mermarkd.json`;

const firstContent = [
  '---',
  'title: Full source fixture',
  '---',
  '# 完整源码',
  '',
  'ANCHOR_TEXT 与原始文字。  ',
  '\tTAB_LINE',
  '## 查找替换',
  '',
  'FIND_TARGET and FIND_TARGET',
  '',
  '```txt',
  '<raw>source marker</raw>',
  '```',
  '',
  'ASCII_CURSOR 中文 😀 e\u0301',
].join('\r\n').replace(/\r\n$/, '');
const firstBytes = sourceBytes(firstContent, true);
const secondContent = '# 冲突测试\n\nANCHOR_TWO 与 CANDIDATE_MARKER\n';
const thirdContent = '# 阅读编辑\n\n这是 **重点** 与 [旧文字](https://example.test)。\n';
const secondBytes = sourceBytes(secondContent);
const thirdBytes = sourceBytes(thirdContent);
const firstSidecarText = annotationText(firstContent, firstBytes, 3, 'ASCII_CURSOR', 'roundtrip-highlight');
const secondSidecarText = annotationText(secondContent, secondBytes, 0, 'ANCHOR_TWO', 'conflict-highlight');
const firstCanvasBytes = Buffer.from('{"schemaVersion":1,"sentinel":"roundtrip-canvas"}\n');
const secondCanvasBytes = Buffer.from('{"schemaVersion":1,"sentinel":"conflict-canvas"}\n');

await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
await mkdir(userData, { recursive: true });
await writeFile(firstPath, firstBytes);
await writeFile(firstSidecar, firstSidecarText, 'utf8');
await writeFile(firstCanvas, firstCanvasBytes);
await writeFile(secondPath, secondBytes);
await writeFile(secondSidecar, secondSidecarText, 'utf8');
await writeFile(secondCanvas, secondCanvasBytes);
await writeFile(thirdPath, thirdContent, 'utf8');
await writeFile(thirdSidecar, annotationText(thirdContent, thirdBytes, 0, '重点', 'reader-highlight'), 'utf8');
await writeFile(thirdCanvas, Buffer.from('{"schemaVersion":1,"sentinel":"reader-canvas"}\n'));

const port = 10_100 + Math.floor(Math.random() * 200);
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], {
  cwd: root,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
  stdio: 'ignore',
});
let cdp;

try {
  const page = await waitForEndpoint(port);
  cdp = await connect(page);
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer startup');
  await dropFile(cdp, firstPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-3b-roundtrip.md' &&
    document.querySelector('.annotation-summary')?.textContent.includes('1 条记录')`, 'first reader document');

  const noWriteBefore = {
    markdown: await snapshot(firstPath),
    annotations: await snapshot(firstSidecar),
    canvas: await snapshot(firstCanvas),
    entries: (await readdir(workspace)).sort(),
  };
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'source editor');
  const sourceContract = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    const status = document.querySelector('[data-editor-status]')?.textContent ?? '';
    return {
      value: textarea?.value,
      hasReader: Boolean(document.querySelector('.markdown-body')),
      status,
      dirty: document.querySelector('.app-shell')?.getAttribute('data-dirty'),
    };
  })()`);
  assert.equal(sourceContract.value, firstContent.replace(/\r\n/g, '\n'));
  assert.equal(sourceContract.hasReader, false);
  assert.equal(sourceContract.dirty, 'false');
  assert.match(sourceContract.status, /UTF-8 BOM/);
  assert.match(sourceContract.status, /CRLF/);
  assert.match(sourceContract.status, /末尾无换行/);

  const contextMenuReady = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    const start = textarea.value.indexOf('ANCHOR_TEXT');
    textarea.focus();
    textarea.setSelectionRange(start, start + 'ANCHOR_TEXT'.length);
    textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 160 }));
    return true;
  })()`);
  assert.equal(contextMenuReady, true, 'source context-menu selection');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-context-menu]'))`, 'source context menu');
  const sourceMenuKeyboard = await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    if (!(textarea instanceof HTMLTextAreaElement)) return false;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
    return true;
  })()`);
  assert.equal(sourceMenuKeyboard, true, 'source context-menu keyboard open');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-context-menu]')) &&
    document.activeElement?.textContent === '复制'`, 'source context menu keyboard focus');
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))`);
  await waitFor(cdp, `document.activeElement?.textContent === '剪切'`, 'source context menu arrow navigation');
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))`);
  await waitFor(cdp, `!document.querySelector('[data-editor-context-menu]')`, 'source context menu keyboard close');
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    if (!(textarea instanceof HTMLTextAreaElement)) return;
    const start = textarea.value.indexOf('ANCHOR_TEXT');
    textarea.focus(); textarea.setSelectionRange(start, start + 'ANCHOR_TEXT'.length);
    textarea.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 160 }));
  })()`);
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-context-menu]'))`, 'source context menu reopened');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-editor-context-menu] button')).find((button) => button.textContent === '加粗')?.click()`);
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('**ANCHOR_TEXT**')`, 'source bold command');
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `!document.querySelector('[data-editor-textarea]')?.value.includes('**ANCHOR_TEXT**')`, 'source bold undo');

  await click(cdp, '[data-mode="reader"]');
  await waitFor(cdp, `Boolean(document.querySelector('.markdown-body'))`, 'reader after clean mode switch');
  const readerMenuReady = await cdp.evaluate(`(() => {
    const article = document.querySelector('.markdown-body');
    if (!(article instanceof HTMLElement)) return false;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    let node;
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
    while ((node = walker.nextNode())) {
      const start = node.nodeValue?.indexOf('ASCII_CURSOR') ?? -1;
      if (start < 0) continue;
      const block = node.parentElement?.closest('[contenteditable="true"]');
      if (block instanceof HTMLElement) block.focus();
      const range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + 'ASCII_CURSOR'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges(); selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      article.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
      return selection?.toString();
    }
    return false;
  })()`);
  assert.equal(readerMenuReady, 'ASCII_CURSOR', 'reader context-menu selection');
  await waitFor(cdp, `Boolean(document.querySelector('[data-reader-context-menu]'))`, 'reader context menu');
  await waitFor(cdp, `document.activeElement?.textContent === '复制正文'`, 'reader context menu keyboard focus');
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))`);
  await waitFor(cdp, `document.querySelector('[data-reader-context-menu]')?.querySelector('[role="menuitem"]:focus')?.getAttribute('aria-label')?.includes('琥珀')`,
    'reader context menu arrow navigation');
  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))`);
  await waitFor(cdp, `!document.querySelector('[data-reader-context-menu]')`, 'reader context menu keyboard close');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'editor after clean mode switch');
  assertSnapshotUnchanged(noWriteBefore.markdown, await snapshot(firstPath), 'clean mode switch Markdown');
  assertSnapshotUnchanged(noWriteBefore.annotations, await snapshot(firstSidecar), 'clean mode switch annotations');
  assertSnapshotUnchanged(noWriteBefore.canvas, await snapshot(firstCanvas), 'clean mode switch canvas');
  assert.deepEqual((await readdir(workspace)).sort(), noWriteBefore.entries,
    'clean mode switches must not create adjacent recovery files');

  await insertEditorText(cdp, 'FIND_TARGET', 'EDITED_');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'dirty editor');
  assertSnapshotUnchanged(noWriteBefore.markdown, await snapshot(firstPath), 'dirty buffer Markdown');
  assertSnapshotUnchanged(noWriteBefore.annotations, await snapshot(firstSidecar), 'dirty buffer annotations');
  assertSnapshotUnchanged(noWriteBefore.canvas, await snapshot(firstCanvas), 'dirty buffer canvas');

  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'undo to baseline');
  await pressShortcut(cdp, 'y');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'redo dirty edit');

  await pressShortcut(cdp, 'h');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-search]'))`, 'source replace bar');
  await setInput(cdp, '[data-editor-find-input]', 'FIND_TARGET');
  await setInput(cdp, '[data-editor-replace-input]', 'REPLACED_TARGET');
  await waitFor(cdp, `document.querySelector('[data-editor-search] output')?.textContent?.includes('/ 2')`, 'two source matches');
  await click(cdp, '[data-editor-replace-all]');
  await waitFor(cdp, `(document.querySelector('[data-editor-textarea]')?.value.match(/REPLACED_TARGET/g) ?? []).length === 2`,
    'replace all');
  await waitFor(cdp, `document.activeElement === document.querySelector('[data-editor-textarea]')`,
    'editor focus after replace all');
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `(document.querySelector('[data-editor-textarea]')?.value.match(/FIND_TARGET/g) ?? []).length === 2`,
    'single-step replace-all undo');
  await waitFor(cdp, `document.activeElement === document.querySelector('[data-editor-textarea]')`,
    'editor focus after replace-all undo');
  await pressShortcut(cdp, 'y');
  await waitFor(cdp, `(document.querySelector('[data-editor-textarea]')?.value.match(/REPLACED_TARGET/g) ?? []).length === 2`,
    'replace-all redo');

  await insertEditorText(cdp, 'ASCII_CURSOR', 'X');
  await new Promise((resolve) => setTimeout(resolve, 160));
  const cursorProbe = await cdp.evaluate(`({
    status: document.querySelector('[data-editor-status]')?.textContent ?? '',
    value: document.querySelector('[data-editor-textarea]')?.value ?? '',
    start: document.querySelector('[data-editor-textarea]')?.selectionStart,
    end: document.querySelector('[data-editor-textarea]')?.selectionEnd,
  })`);
  assert.match(cursorProbe.status, /行\s*\d+，列\s*2/,
    `unexpected source cursor status: ${JSON.stringify(cursorProbe)}`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('ASCII_CURSOR') &&
    !document.querySelector('[data-editor-textarea]')?.value.includes('XASCII_CURSOR')`, 'cursor probe undo');

  await click(cdp, '[data-mode="reader"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-dirty-preview]')) &&
    document.querySelector('.markdown-body')?.textContent.includes('REPLACED_TARGET')`, 'dirty reader preview');
  const previewState = await cdp.evaluate(`({
    annotationSidebar: Boolean(document.querySelector('.annotation-sidebar')),
    selectionToolbar: Boolean(document.querySelector('.selection-toolbar')),
    highlighted: Boolean(CSS.highlights?.get('mermarkd-amber')),
  })`);
  assert.deepEqual(previewState, { annotationSidebar: false, selectionToolbar: false, highlighted: false });
  const directDirtyMutation = await cdp.evaluate(`window.mermarkd.recolorHighlight({
    id: 'roundtrip-highlight', color: 'blue'
  })`);
  assert.equal(directDirtyMutation.status, 'conflict');
  assert.match(directDirtyMutation.reason, /未保存/);
  assertSnapshotUnchanged(noWriteBefore.annotations, await snapshot(firstSidecar), 'dirty direct annotation mutation');

  await click(cdp, '[data-mode="editor"]');
  const firstCandidate = await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.value`);
  await pressShortcut(cdp, 's');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'successful source save');
  const expectedFirstBytes = sourceBytes(firstCandidate.replace(/\n/g, '\r\n'), true);
  assert.deepEqual(await readFile(firstPath), expectedFirstBytes);
  assert.equal(expectedFirstBytes.at(-1) === 0x0a || expectedFirstBytes.at(-1) === 0x0d, false,
    'save must preserve the missing trailing newline');
  const mappedFirstSidecar = parseAnnotationYaml(await readFile(firstSidecar, 'utf8'));
  assert.equal(mappedFirstSidecar.source.sha256, digest(expectedFirstBytes));
  assert.equal(mappedFirstSidecar.annotations[0].anchor.basisSha256, digest(expectedFirstBytes));
  assert.equal(mappedFirstSidecar.annotations[0].anchor.sourceExact, 'ASCII_CURSOR');
  assert.equal(mappedFirstSidecar.annotations[0].anchor.startByte,
    expectedFirstBytes.indexOf(Buffer.from('ASCII_CURSOR')));
  assertSnapshotUnchanged(noWriteBefore.canvas, await snapshot(firstCanvas), 'successful save canvas');
  const firstEntriesAfterSave = await readdir(workspace);
  const backupNames = firstEntriesAfterSave.filter((name) =>
    name.startsWith('.a7-3b-roundtrip.md.') && name.endsWith('.mermarkd-backup'));
  assert.equal(backupNames.length, 1, 'changed save should retain one exact source recovery file');
  assert.deepEqual(await readFile(path.join(workspace, backupNames[0])), firstBytes);

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' &&
    Boolean(document.querySelector('[data-reader-editable="true"]'))`, 'reader editable plain block');
  const thirdBefore = {
    markdown: await snapshot(thirdPath),
    annotations: await snapshot(thirdSidecar),
    canvas: await snapshot(thirdCanvas),
  };
  const readerEditResult = await cdp.evaluate(`(() => {
    const block = document.querySelector('[data-reader-editable="true"]');
    if (!(block instanceof HTMLElement)) return false;
    block.focus();
    block.textContent = '阅读中已修改';
    block.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '阅读中已修改' }));
    block.blur();
    return true;
  })()`);
  assert.equal(readerEditResult, true, 'reader contenteditable input');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true' &&
    document.querySelector('.markdown-body')?.textContent.includes('阅读中已修改')`, 'reader edit dirty preview');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('阅读中已修改')`, 'reader edit in source buffer');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    document.querySelector('[data-editor-textarea]')?.value.includes('这是 **重点** 与 [旧文字](https://example.test)。')`, 'reader edit shared undo');
  await pressShortcut(cdp, 'y');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true' &&
    document.querySelector('[data-editor-textarea]')?.value.includes('阅读中已修改')`, 'reader edit shared redo');
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'reader edit return to baseline');

  await click(cdp, '[data-mode="reader"]');
  await waitFor(cdp, `Boolean(document.querySelector('.markdown-body'))`, 'reader inline edit');
  const inlineEditResult = await cdp.evaluate(`(() => {
    const block = [...document.querySelectorAll('[data-reader-editable="true"]')]
      .find((element) => element.textContent?.includes('重点'));
    if (!(block instanceof HTMLElement)) return false;
    block.focus();
    block.textContent = '这是 核心 与 旧文字。';
    block.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '核心' }));
    block.blur();
    return true;
  })()`);
  assert.equal(inlineEditResult, true, 'reader inline contenteditable input');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader inline edit dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('**核心**') &&
    document.querySelector('[data-editor-textarea]')?.value.includes('[旧文字](https://example.test)')`, 'reader inline source mapping');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'reader inline undo');
  await click(cdp, '[data-mode="reader"]');
  await waitFor(cdp, `Boolean(document.querySelector('.markdown-body'))`, 'reader inline format commands');

  const selectReaderInlineText = async (text, clientY = 180) => {
    const selected = await cdp.evaluate(`(() => {
      const article = document.querySelector('.markdown-body');
      if (!(article instanceof HTMLElement)) return false;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let node;
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event('selectionchange'));
      while ((node = walker.nextNode())) {
        const start = node.nodeValue?.indexOf(${JSON.stringify(text)}) ?? -1;
        if (start < 0) continue;
        const block = node.parentElement?.closest('[contenteditable="true"]');
        if (block instanceof HTMLElement) block.focus();
        const range = document.createRange();
        range.setStart(node, start); range.setEnd(node, start + ${JSON.stringify(text)}.length);
        const selection = window.getSelection();
        selection?.removeAllRanges(); selection?.addRange(range);
        const selectedText = selection?.toString() ?? '';
        document.dispatchEvent(new Event('selectionchange'));
        article.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: ${JSON.stringify(clientY)} }));
        return selectedText;
      }
      return false;
    })()`);
    assert.equal(selected, text, `reader inline selection: ${text}`);
    await waitFor(cdp, `Boolean(document.querySelector('[data-reader-context-menu]'))`, `reader format menu: ${text}`);
  };

  await selectReaderInlineText('重点');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '加粗')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader bold format dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('****重点****')`, 'reader bold source format');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    document.querySelector('[data-editor-textarea]')?.value.includes('这是 **重点** 与')`, 'reader bold undo');

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' && Boolean(document.querySelector('.markdown-body'))`, 'reader format mode');
  await selectReaderInlineText('重点');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '斜体')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader italic format dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('***重点***')`, 'reader italic source format');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'reader italic undo');

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' && Boolean(document.querySelector('.markdown-body'))`, 'reader quote mode');
  await selectReaderInlineText('重点');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '引用')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader quote format dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('> 这是 **重点** 与')`, 'reader quote source format');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'reader quote undo');

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' && Boolean(document.querySelector('.markdown-body'))`, 'reader text commands mode');
  await selectReaderInlineText('重点');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '剪切正文')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader cut dirty');
  assert.equal(await cdp.evaluate(`navigator.clipboard.readText()`), '重点', 'reader cut clipboard');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('这是 **** 与')`, 'reader cut source');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    document.querySelector('[data-editor-textarea]')?.value.includes('这是 **重点** 与')`, 'reader cut undo');

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' && Boolean(document.querySelector('.markdown-body'))`, 'reader delete mode');
  const bottomY = await cdp.evaluate('window.innerHeight - 4');
  await selectReaderInlineText('重点', bottomY);
  const menuBounds = await cdp.evaluate(`(() => {
    const menu = document.querySelector('[data-reader-context-menu]');
    if (!(menu instanceof HTMLElement)) return null;
    const rect = menu.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  })()`);
  assert.ok(menuBounds && menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.viewport,
    `reader context menu must fit viewport: ${JSON.stringify(menuBounds)}`);
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '删除正文')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader delete dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('这是 **** 与')`, 'reader delete source');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false'`, 'reader delete undo');

  await dropFile(cdp, thirdPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'b5-reader-edit.md' && Boolean(document.querySelector('.markdown-body'))`, 'reader paste mode');
  await selectReaderInlineText('重点');
  assert.equal(await cdp.evaluate(`navigator.clipboard.writeText('替换').then(() => true)`), true, 'reader paste clipboard setup');
  await cdp.evaluate(`Array.from(document.querySelectorAll('[data-reader-context-menu] button')).find((button) => button.textContent === '粘贴正文')?.click()`);
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'reader paste dirty');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value.includes('这是 **替换** 与')`, 'reader paste source');
  await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.focus()`);
  await pressShortcut(cdp, 'z');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'false' &&
    document.querySelector('[data-editor-textarea]')?.value.includes('这是 **重点** 与')`, 'reader paste undo');
  assertSnapshotUnchanged(thirdBefore.markdown, await snapshot(thirdPath), 'reader commands Markdown');
  assertSnapshotUnchanged(thirdBefore.annotations, await snapshot(thirdSidecar), 'reader commands annotations');
  assertSnapshotUnchanged(thirdBefore.canvas, await snapshot(thirdCanvas), 'reader commands canvas');

  await dropFile(cdp, secondPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-3b-conflict.md' &&
    Boolean(document.querySelector('.markdown-body'))`, 'conflict reader document');
  const secondBefore = {
    annotations: await snapshot(secondSidecar),
    canvas: await snapshot(secondCanvas),
  };
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'conflict source editor');
  await insertEditorText(cdp, 'CANDIDATE_MARKER', 'LOCAL_');
  await waitFor(cdp, `document.querySelector('.app-shell')?.getAttribute('data-dirty') === 'true'`, 'conflict dirty buffer');
  const conflictCandidate = await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.value`);
  const explicitCheckpoint = await cdp.evaluate(`(async () => {
    const editor = await window.mermarkd.openMarkdownEditor();
    return window.mermarkd.persistMarkdownEditorDraft({
      epoch: editor.epoch,
      revision: editor.revision,
      content: editor.content,
    });
  })()`);
  assert.equal(explicitCheckpoint.dirty, true);
  assert.equal(explicitCheckpoint.draftPersisted, true);
  await waitForNode(async () => (await walkFiles(workspace)).some((file) => file.includes('.markdown.pending.')),
    'durable Markdown checkpoint');

  const externalBytes = Buffer.from('# 外部版本\n\nEXTERNAL_WRITER_WINS\n', 'utf8');
  await writeFile(secondPath, externalBytes);
  await pressShortcut(cdp, 's');
  await waitFor(cdp, `(document.querySelector('.notice.alert')?.textContent ?? '').includes('外部修改') ||
    (document.querySelector('[data-editor-status]')?.textContent ?? '').includes('外部修改')`, 'external save conflict');
  assert.deepEqual(await readFile(secondPath), externalBytes);
  assert.equal(await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.value`), conflictCandidate);
  assert.equal(await cdp.evaluate(`document.querySelector('.app-shell')?.getAttribute('data-dirty')`), 'true');
  assertSnapshotUnchanged(secondBefore.annotations, await snapshot(secondSidecar), 'conflict annotations');
  assertSnapshotUnchanged(secondBefore.canvas, await snapshot(secondCanvas), 'conflict canvas');
  const directConflictMutation = await cdp.evaluate(`window.mermarkd.deleteHighlight('conflict-highlight')`);
  assert.equal(directConflictMutation.status, 'conflict');
  assert.match(directConflictMutation.reason, /未保存/);

  await dropFile(cdp, firstPath);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await cdp.evaluate(`document.querySelector('h1')?.textContent`), 'a7-3b-conflict.md',
    'dirty drop must not replace the current document');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-editor-textarea]')?.value`), conflictCandidate);

  const pendingFiles = (await walkFiles(workspace)).filter((file) => file.includes('.markdown.pending.'));
  assert.ok(pendingFiles.length >= 1, 'conflict must retain a Markdown recovery draft');
  const pendingDrafts = [];
  for (const file of pendingFiles) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (path.normalize(value.documentPath ?? '') === path.normalize(secondPath)) pendingDrafts.push(value);
    } catch {
      // Ignore unrelated or temporary files; the matching final draft is required below.
    }
  }
  assert.ok(pendingDrafts.some((draft) => draft.content === conflictCandidate &&
    draft.expectedSourceSha256 === digest(secondBytes) && draft.candidateSha256 === digest(Buffer.from(conflictCandidate)) &&
    draft.bomByteLength === 0), 'conflict draft must preserve candidate content and the original source baseline');

  console.log(JSON.stringify({
    status: 'passed',
    exactCrLfBomRoundTrip: true,
    cleanModeSwitchNoWrite: true,
    dirtyPreviewSidecarsFrozen: true,
    externalConflictPreserved: true,
    recoveryDrafts: pendingDrafts.length,
  }));
} finally {
  cdp?.close();
  if (child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
