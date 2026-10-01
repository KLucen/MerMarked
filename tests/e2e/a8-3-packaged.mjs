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
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data); if (!message.id) return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
    });
  }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function endpoint(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((item) => item.type === 'page'); if (page) return page; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for packaged Electron.');
}
async function mainEndpoint(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const node = tabs.find((item) => item.type === 'node'); if (node) return node; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for main-process inspector.');
}
async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  const cdp = new Cdp(socket); await cdp.send('Runtime.enable'); return cdp;
}
async function waitFor(cdp, expression, label) {
  const deadline = Date.now() + 15000; let last;
  while (Date.now() < deadline) { last = await cdp.evaluate(expression); if (last === true) return; await new Promise((resolve) => setTimeout(resolve, 60)); }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
async function click(cdp, selector) {
  const result = await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false; element.click(); return true; })()`);
  assert.equal(result, true, `enabled element missing: ${selector}`);
}
async function drop(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); const target = document.querySelector('[data-markdown-drop-target]'); const box = target.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data });
}
async function waitForFile(filePath) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { try { const item = await stat(filePath); if (item.size > 0) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 80)); }
  throw new Error(`Timed out waiting for export file: ${filePath}`);
}
async function exportThroughDialog(cdp, format, target) {
  await rm(target, { force: true });
  await click(cdp, `[data-canvas-export="${format}"]`);
  try { await waitForFile(target); }
  catch (error) { console.error('export status:', await cdp.evaluate(`document.querySelector('[data-canvas-status]')?.textContent`)); throw error; }
}
function readPngSize(bytes) { assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }; }
function readJpegSize(bytes) {
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8); let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]; const length = bytes.readUInt16BE(offset + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  throw new Error('JPEG dimensions not found.');
}
function countPdfPages(bytes) { const text = bytes.toString('latin1'); return (text.match(/\/Type\s*\/Page\b/g) ?? []).length; }

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a8-3-e2e-'));
const documentPath = path.join(workspace, '导出样本.md');
const userData = path.join(workspace, 'user-data');
const content = '# 根节点\n根节点正文\n## 子节点\n子节点正文\n### 孙节点\n孙节点正文\n# 旁支\n旁支正文\n';
await writeFile(documentPath, content, 'utf8');
const annotationsPath = `${documentPath}.annotations.yaml`;
const hash = createHash('sha256').update(content, 'utf8').digest('hex');
const yaml = `schemaVersion: 1\nsource:\n  sha256: "${hash}"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n`;
await writeFile(annotationsPath, yaml, 'utf8');
const port = 10700 + Math.floor(Math.random() * 200);
const inspectorPort = port + 400;
const child = spawn(executable, [`--inspect=${inspectorPort}`, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
let cdp; let mainCdp;
try {
  cdp = await connect(await endpoint(port)); mainCdp = await connect(await mainEndpoint(inspectorPort)); await waitFor(cdp, `document.readyState === 'complete'`, 'renderer'); await drop(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.file-name')?.textContent === '导出样本.md'`, 'document'); await click(cdp, '[data-mode="cards"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-view]'))`, 'canvas mode'); await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4`, 'four cards');
  await waitFor(cdp, `document.querySelector('[data-canvas-save]')?.disabled === false`, 'measured initial layout ready');
  await click(cdp, '[data-canvas-save]'); await waitFor(cdp, `document.querySelector('[data-canvas-status]').textContent.includes('画布已保存')`, 'initial canvas save');
  const sidecarPath = `${documentPath}.mermarkd.json`;
  const beforeMarkdown = await readFile(documentPath); const beforeYaml = await readFile(annotationsPath); const beforeCanvas = await readFile(sidecarPath);
  const loaded = await cdp.evaluate('window.mermarkd.loadCanvas()');
  const model = JSON.parse(beforeCanvas.toString('utf8'));
  model.cards[0].position = { x: -300, y: -200 }; model.cards[1].position = { x: 240, y: 160 }; model.cards[2].position = { x: 320, y: 240 }; model.cards[3].position = { x: 900, y: 700 };
  model.links = [{ id: 'a8-3-export-link', from: model.cards[2].id, to: model.cards[3].id, label: '跨层中文关系标签-这是一个很长的标签用于边界检查', }];
  const saved = await cdp.evaluate(`window.mermarkd.saveCanvas(${JSON.stringify({ sourceSha256: hash, expectedSidecarSha256: loaded.sidecarSha256, model })})`);
  assert.equal(saved.status, 'saved');
  await click(cdp, '[data-mode="reader"]'); await waitFor(cdp, `document.querySelector('[data-active-mode]')?.getAttribute('data-active-mode') === 'reader'`, 'reader reload');
  await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4`, 'reloaded scene');
  const outputs = {};
  for (const format of ['png', 'jpg', 'pdf']) {
    const target = path.join(workspace, `导出样本.mermarkd.${format}`);
    await mainCdp.evaluate(`process.mainModule.require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} })`);
    await exportThroughDialog(cdp, format, target);
    const bytes = await readFile(target); assert.ok(bytes.length > 0); outputs[format] = { bytes: bytes.length };
    if (format === 'png') outputs[format].size = readPngSize(bytes);
    if (format === 'jpg') outputs[format].size = readJpegSize(bytes);
    if (format === 'pdf') outputs[format].pages = countPdfPages(bytes);
    if (format === 'png') { await mkdir(path.join(root, 'out', 'qa'), { recursive: true }); await writeFile(path.join(root, 'out', 'qa', 'a8-3-export.png'), bytes); }
  }
  assert.ok(outputs.png.size.width > 1200 && outputs.png.size.height > 900);
  assert.deepEqual(outputs.jpg.size, outputs.png.size);
  assert.equal(outputs.pdf.pages, 1);
  assert.deepEqual(await readFile(documentPath), beforeMarkdown); assert.deepEqual(await readFile(annotationsPath), beforeYaml); assert.notDeepEqual(await readFile(sidecarPath), beforeCanvas);
  const canvasAfterExport = await readFile(sidecarPath);
  await click(cdp, '[data-mode="editor"]'); await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'editor');
  await cdp.evaluate(`(() => { const textarea = document.querySelector('[data-editor-textarea]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(textarea, textarea.value + String.fromCharCode(10) + 'dirty'); textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `document.querySelector('[data-canvas-status]').textContent.includes('写入已暂停')`, 'dirty canvas');
  assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('[data-canvas-export]')).every((element) => element.hasAttribute('disabled'))`), true);
  assert.deepEqual(await readFile(documentPath), beforeMarkdown); assert.deepEqual(await readFile(annotationsPath), beforeYaml); assert.deepEqual(await readFile(sidecarPath), canvasAfterExport);
  console.log(JSON.stringify({ status: 'passed', formats: ['png', 'jpg', 'pdf'], fullBounds: outputs.png.size, pdfPages: outputs.pdf.pages, longChineseLabel: true, nestedAndOffscreen: true, sourceFilesUnchanged: true, dirtyExportFrozen: true }));
} finally {
  mainCdp?.close(); cdp?.close(); try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
  await new Promise((resolve) => setTimeout(resolve, 300)); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
