import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');

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
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  close() { this.socket.close(); }
}

async function endpoint(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = tabs.find((item) => item.type === 'page');
      if (page) return page;
    } catch { /* Electron is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for packaged Electron.');
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

async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function dropFile(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => {
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo(0, 0);
    const element = document.querySelector('[data-markdown-drop-target]');
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  assert.ok(rect, 'drop target missing');
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data });
}

async function click(cdp, selector) {
  const clicked = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLButtonElement) || element.disabled) return false;
    element.click(); return true;
  })()`);
  assert.equal(clicked, true, `enabled button missing: ${selector}`);
}

async function setSelect(cdp, selector, value) {
  const changed = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(element, ${JSON.stringify(String(value))});
    element.dispatchEvent(new Event('change', { bubbles: true })); return true;
  })()`);
  assert.equal(changed, true, `select missing: ${selector}`);
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a7-5-e2e-'));
const documentPath = path.join(workspace, 'structure.md');
const userData = path.join(workspace, 'user-data');
const content = '# A\r\nA body\r\n## B\r\nB body\r\n# C\r\nC body';
const editorContent = content.replaceAll('\r\n', '\n');
const originalBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
const originalHash = createHash('sha256').update(originalBytes).digest('hex');
const timestamp = '2026-10-01T00:00:00Z';
const model = {
  schemaVersion: 1,
  source: { sha256: originalHash, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
  tags: [],
  annotations: ['A body', 'B body'].map((quote, index) => {
    const startByte = originalBytes.indexOf(Buffer.from(quote));
    return { id: `note-${index}`, kind: 'note', note: `Retained ${quote}`,
      anchor: makeAnnotationAnchor(content, 3, originalHash, {
        startByte, endByte: startByte + Buffer.byteLength(quote), sourceExact: quote, displayQuote: quote,
      }), createdAt: timestamp, updatedAt: timestamp };
  }),
};
const sidecarPath = `${documentPath}.annotations.yaml`;
const canvasPath = `${documentPath}.mermarkd.json`;
await writeFile(documentPath, originalBytes);
await writeFile(sidecarPath, serializeAnnotationYaml(model));
await writeFile(canvasPath, '{"probe":"must remain untouched"}\n');
const sidecarBytes = await readFile(sidecarPath);
const sidecarMtime = (await stat(sidecarPath)).mtimeMs;
const port = 10_400 + Math.floor(Math.random() * 200);
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
let cdp;
try {
  cdp = await connect(await endpoint(port));
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer startup');
  await dropFile(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'structure.md'`, 'document');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-structure]'))`, 'structure panel');
  await setSelect(cdp, '[data-structure-source]', 1);
  await setSelect(cdp, '[data-structure-target]', 2);
  await click(cdp, '[data-editor-preview-move]');
  await waitFor(cdp, `document.querySelector('[data-editor-apply-structure]')?.disabled === false`, 'move preview and impact');
  const candidate = await cdp.evaluate(`document.querySelector('[data-editor-structure-after]')?.textContent`);
  assert.equal(candidate, '# A\nA body\n# C\nC body\n\n## B\nB body\n');
  assert.match(await cdp.evaluate(`document.querySelector('[data-editor-annotation-impact]').textContent`), /1 条批注.*1 条/);
  assert.equal(await cdp.evaluate(`document.querySelector('[data-editor-annotation-impact] li').textContent`), 'B body');
  const qaDirectory = path.join(root, 'out', 'qa');
  await mkdir(qaDirectory, { recursive: true });
  for (const [name, width, height] of [['wide', 1200, 900], ['narrow', 800, 700]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} overflow`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(qaDirectory, `a7-5-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await click(cdp, '[data-editor-cancel-structure]');
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-editor-structure-preview]'))`), false);
  assert.equal(await cdp.evaluate(`document.querySelector('[data-editor-textarea]').value`), editorContent);
  assert.deepEqual(await readFile(documentPath), originalBytes);
  assert.deepEqual(await readFile(sidecarPath), sidecarBytes);
  assert.equal((await stat(sidecarPath)).mtimeMs, sidecarMtime);
  await setSelect(cdp, '[data-structure-target]', 1);
  await click(cdp, '[data-editor-preview-move]');
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-editor-apply-structure]'))`), false);
  await click(cdp, '[data-editor-cancel-structure]');
  await setSelect(cdp, '[data-structure-target]', 2);
  await click(cdp, '[data-editor-preview-move]');
  await waitFor(cdp, `document.querySelector('[data-editor-apply-structure]')?.disabled === false`, 'second preview');
  await cdp.evaluate(`(() => {
    const textarea = document.querySelector('[data-editor-textarea]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, textarea.value + '\\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(cdp, `document.querySelector('[data-editor-apply-structure]')?.disabled === true`, 'stale preview blocked');
  await click(cdp, '[data-editor-cancel-structure]');
  await click(cdp, '[data-editor-undo]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value === ${JSON.stringify(editorContent)}`, 'stale preview edit undo');
  const invalidPreview = await cdp.evaluate(`(async () => {
    const editor = await window.mermarkd.openMarkdownEditor();
    try { await window.mermarkd.previewMarkdownAnnotationImpact({ epoch: editor.epoch, content: editor.content, path: 'arbitrary.md' }); }
    catch { return true; } return false;
  })()`);
  assert.equal(invalidPreview, true);
  await click(cdp, '[data-editor-preview-move]');
  await waitFor(cdp, `document.querySelector('[data-editor-apply-structure]')?.disabled === false`, 'fresh preview');
  await click(cdp, '[data-editor-apply-structure]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value === ${JSON.stringify(candidate)}`, 'applied transform');
  await click(cdp, '[data-editor-undo]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value === ${JSON.stringify(editorContent)}`, 'undo transform');
  assert.deepEqual(await readFile(documentPath), originalBytes);
  await click(cdp, '[data-editor-redo]');
  await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.value === ${JSON.stringify(candidate)}`, 'redo transform');
  assert.deepEqual(await readFile(sidecarPath), sidecarBytes);
  assert.equal((await stat(sidecarPath)).mtimeMs, sidecarMtime);
  await click(cdp, '[data-editor-save]');
  await waitFor(cdp, `document.querySelector('[data-editor-status]')?.textContent.includes('已保存')`, 'explicit save');
  assert.deepEqual(await readFile(documentPath), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(candidate.replaceAll('\n', '\r\n'))]));
  const saved = parseAnnotationYaml(await readFile(sidecarPath, 'utf8'));
  assert.equal(saved.annotations[0].anchor.basisSha256, saved.source.sha256);
  assert.deepEqual(saved.annotations[1], model.annotations[1]);
  assert.equal(await readFile(canvasPath, 'utf8'), '{"probe":"must remain untouched"}\n');
  await click(cdp, '[data-mode="reader"]');
  const loaded = await cdp.evaluate('window.mermarkd.loadAnnotations()');
  assert.equal(loaded.unresolvedCount, 1);
  assert.equal(loaded.items[0].note, model.annotations[0].note);
  assert.equal(loaded.items[1].note, model.annotations[1].note);
  await dropFile(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'structure.md'`, 'reopen');
  assert.equal((await cdp.evaluate('window.mermarkd.loadAnnotations()')).unresolvedCount, 1);
  console.log(JSON.stringify({ status: 'passed', preview: true, annotationImpact: true, cancel: true,
    rejection: true, stalePreviewBlocked: true, narrowIpc: true, apply: true, undo: true, redo: true, dirtySidecarUnchanged: true,
    bomCrlfSave: true, unresolvedAnchorRetained: true, reopen: true, layouts: [1200, 800] }));
} finally {
  cdp?.close();
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
  await new Promise((resolve) => setTimeout(resolve, 250));
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
