import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');

class Cdp {
  constructor(socket) { this.socket = socket; this.nextId = 1; this.pending = new Map(); socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
  }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.socket.close(); }
}
async function endpoint(port) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((item) => item.type === 'page'); if (page) return page; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error('Timed out waiting for packaged Electron.'); }
async function connect(page) { const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); const cdp = new Cdp(socket); await cdp.send('Runtime.enable'); return cdp; }
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 15000; let last; while (Date.now() < deadline) { last = await cdp.evaluate(expression); if (last === true) return; await new Promise((resolve) => setTimeout(resolve, 60)); } throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`); }
async function click(cdp, selector) { const result = await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false; element.click(); return true; })()`); assert.equal(result, true, `enabled element missing: ${selector}`); }
async function setSelect(cdp, selector, value) { const result = await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLSelectElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); assert.equal(result, true); }
async function drop(cdp, filePath) { const rect = await cdp.evaluate(`(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); const target = document.querySelector('[data-markdown-drop-target]'); const box = target.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`); const data = { items: [], files: [filePath], dragOperationsMask: 1 }; await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data }); }

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a8-2-e2e-'));
const documentPath = path.join(workspace, 'canvas.md');
const userData = path.join(workspace, 'user-data');
const content = '# Root\nRoot body\n## Child\nChild body\n### Grandchild\nGrand body\n# Sibling\nSibling body\n';
await writeFile(documentPath, content, 'utf8');
const annotationsPath = `${documentPath}.annotations.yaml`;
const hash = createHash('sha256').update(content).digest('hex');
const yaml = `schemaVersion: 1\nsource:\n  sha256: "${hash}"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n`;
await writeFile(annotationsPath, yaml);
const annotationMtime = (await stat(annotationsPath)).mtimeMs;
const port = 10500 + Math.floor(Math.random() * 200);
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
let cdp;
try {
  cdp = await connect(await endpoint(port)); await waitFor(cdp, `document.readyState === 'complete'`, 'renderer'); await drop(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.file-name')?.textContent === 'canvas.md'`, 'document'); await click(cdp, '[data-mode="cards"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-view]'))`, 'canvas mode'); await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4`, 'four cards');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-canvas-status]').textContent.includes('尚未创建')`), true);
  const sidecarPath = `${documentPath}.mermarkd.json`;
  await assert.rejects(stat(sidecarPath), (error) => error.code === 'ENOENT');
  await waitFor(cdp, `document.querySelector('[data-canvas-save]')?.disabled === false`, 'measured initial layout ready');
  await click(cdp, '[data-canvas-save]');
  await waitFor(cdp, `document.querySelector('[data-canvas-save]')?.disabled === false && document.querySelector('[data-canvas-status]').textContent.includes('画布已保存')`, 'initial save');
  const beforeDrag = JSON.parse(await readFile(sidecarPath, 'utf8'));
  const rootId = beforeDrag.cards[0].id;
  const drag = await cdp.evaluate(`(() => { const element = document.querySelector('[data-id="${rootId}"] .canvas-card-header strong'); const box = element.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x, y: drag.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let index = 1; index <= 12; index++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x + index * 8, y: drag.y + index * 4, buttons: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x + 96, y: drag.y + 48, button: 'left', clickCount: 1, buttons: 0 });
  await waitFor(cdp, `document.querySelector('[data-canvas-save]')?.disabled === false && document.querySelector('[data-canvas-status]').textContent.includes('画布已保存')`, 'drag save');
  const afterDrag = JSON.parse(await readFile(sidecarPath, 'utf8'));
  assert.notDeepEqual(afterDrag.cards[0].position, beforeDrag.cards[0].position);
  assert.deepEqual(afterDrag.cards.slice(1, 3).map((card) => card.position), beforeDrag.cards.slice(1, 3).map((card) => card.position));
  await click(cdp, '[data-canvas-undo]');
  await waitFor(cdp, `document.querySelector('[data-canvas-redo]')?.disabled === false`, 'undo drag');
  assert.deepEqual(JSON.parse(await readFile(sidecarPath, 'utf8')).cards[0].position, beforeDrag.cards[0].position);
  await click(cdp, '[data-canvas-redo]');
  await waitFor(cdp, `document.querySelector('[data-canvas-undo]')?.disabled === false && document.querySelector('[data-canvas-save]')?.disabled === false`, 'redo drag');
  assert.deepEqual(JSON.parse(await readFile(sidecarPath, 'utf8')).cards[0].position, afterDrag.cards[0].position);
  await click(cdp, '[data-canvas-collapse]'); await waitFor(cdp, `document.querySelector('[data-canvas-status]').textContent.includes('画布已保存')`, 'collapse save');
  await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 2`, 'collapsed descendants');
  const ids = afterDrag.cards.map((card) => card.id);
  await setSelect(cdp, '[data-canvas-link-from]', ids[2]); await setSelect(cdp, '[data-canvas-link-to]', ids[3]);
  await cdp.evaluate(`(() => { const input = document.querySelector('[data-canvas-link-label]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, 'depends'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click(cdp, '[data-canvas-add-link]'); await waitFor(cdp, `document.querySelector('[data-canvas-status]').textContent.includes('画布已保存')`, 'link save');
  const sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')); assert.equal(sidecar.cards.length, 4); assert.equal(sidecar.links.length, 1); assert.equal(sidecar.cards.some((card) => card.collapsed), true);
  assert.equal(sidecar.links[0].from, ids[2]);
  await waitFor(cdp, `document.querySelector('.react-flow__edge-text')?.textContent.includes('隐藏端点') === true`, 'hidden endpoint label rendered');
  const qa = path.join(root, 'out', 'qa'); await mkdir(qa, { recursive: true });
  for (const [name, width, height] of [['wide', 1200, 900], ['narrow', 800, 700], ['mobile', 420, 800]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} overflow`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(qa, `a8-2-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const sidecarBeforeDirty = await readFile(sidecarPath);
  await click(cdp, '[data-mode="editor"]'); await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'editor');
  await cdp.evaluate(`(() => { const textarea = document.querySelector('[data-editor-textarea]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, textarea.value + String.fromCharCode(10) + 'Dirty'); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-view]'))`, 'dirty canvas');
  await waitFor(cdp, `document.querySelector('[data-canvas-status]').textContent.includes('写入已暂停')`, 'dirty freeze');
  assert.deepEqual(await readFile(sidecarPath), sidecarBeforeDirty);
  await waitFor(cdp, `(async () => (await window.mermarkd.openMarkdownEditor()).dirty)()`, 'main dirty guard');
  const dirtyWrite = await cdp.evaluate(`window.mermarkd.saveCanvas(${JSON.stringify({ sourceSha256: hash, expectedSidecarSha256: createHash('sha256').update(sidecarBeforeDirty).digest('hex'), model: sidecar })})`);
  assert.equal(dirtyWrite.status, 'conflict');
  assert.deepEqual(await readFile(sidecarPath), sidecarBeforeDirty);
  await click(cdp, '[data-mode="editor"]'); await click(cdp, '[data-editor-discard-changes]'); await click(cdp, '[data-editor-confirm-discard]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'discard'); await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-view]'))`, 'reopen cards'); await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 2`, 'restored collapsed cards');
  await waitFor(cdp, `document.querySelectorAll('.react-flow__edge').length === 1`, 'reopened arrow rendered');
  assert.equal(await readFile(documentPath, 'utf8'), content);
  assert.equal(await readFile(annotationsPath, 'utf8'), yaml);
  assert.equal((await stat(annotationsPath)).mtimeMs, annotationMtime);
  console.log(JSON.stringify({ status: 'passed', cards: 4, nested: true, parentDrag: true, undoRedo: true,
    collapsePersisted: true, hiddenLinkProxy: true, linkPersisted: true, dirtyCanvasFrozen: true, mainDirtyGuard: true,
    markdownAndYamlUnchanged: true, reopen: true, layouts: [1200, 800, 420] }));
} finally { cdp?.close(); try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } await new Promise((resolve) => setTimeout(resolve, 300)); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
