import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { previewSectionTransform } from '../../src/core/section-transform.ts';

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
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 15000; let last; while (Date.now() < deadline) { last = await cdp.evaluate(expression); if (last === true) return; await new Promise((resolve) => setTimeout(resolve, 60)); }
  console.error(await cdp.evaluate(`({mode: document.querySelector('[data-active-mode]')?.dataset.activeMode, status: document.querySelector('[data-canvas-status]')?.textContent,
    warning: document.querySelector('.canvas-warning')?.textContent, nodes: document.querySelectorAll('.react-flow__node').length, saveDisabled: document.querySelector('[data-canvas-save]')?.disabled})`));
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`); }
async function click(cdp, selector) { assert.equal(await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false; element.click(); return true; })()`), true, `enabled element missing: ${selector}`); }
async function drop(cdp, filePath) { const rect = await cdp.evaluate(`(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); const target = document.querySelector('[data-markdown-drop-target]'); const box = target.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`); const data = { items: [], files: [filePath], dragOperationsMask: 1 }; await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data }); }
async function dragToOverlap(cdp) {
  const points = await cdp.evaluate(`(() => { const source = document.querySelector('[data-id="card-1"] .canvas-card-header strong').getBoundingClientRect(); const target = document.querySelector('[data-id="card-3"] .canvas-card-body').getBoundingClientRect(); return { sx: source.x + source.width / 2, sy: source.y + source.height / 2, tx: target.x + target.width / 2, ty: target.y + target.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.sx, y: points.sy, button: 'left', clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 15; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.sx + (points.tx - points.sx) * i / 15, y: points.sy + (points.ty - points.sy) * i / 15, buttons: 1 });
  await new Promise((resolve) => setTimeout(resolve, 360));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.tx, y: points.ty, button: 'left', clickCount: 1, buttons: 0 });
  try { await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-structure-preview]'))`, 'overlap preview'); }
  catch (error) {
    console.error({ points, state: await cdp.evaluate(`({ mode: document.querySelector('[data-active-mode]')?.dataset.activeMode,
      status: document.querySelector('[data-canvas-status]')?.textContent, notice: document.querySelector('.app-notice')?.textContent,
      hit: document.elementFromPoint(${points.sx},${points.sy})?.outerHTML })`) });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(root, 'out', 'qa', 'a8-4-failure.png'), Buffer.from(shot.data, 'base64')); throw error;
  }
}
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a8-4-e2e-'));
const documentPath = path.join(workspace, 'structure.md');
const paths = [documentPath, `${documentPath}.annotations.yaml`, `${documentPath}.mermarkd.json`];
const content = '# A\r\n重复😀。\r\n## B\r\n重复😀。\r\n### C\r\n后代正文。\r\n# D\r\n末节正文。\r\n';
const bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(content)]);
const hash = createHash('sha256').update(bytes).digest('hex');
const annotations = { schemaVersion: 1, source: { sha256: hash, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
  annotations: [content.indexOf('重复😀'), content.lastIndexOf('重复😀')].map((start, i) => {
    const startByte = 3 + Buffer.byteLength(content.slice(0, start));
    return { id: `note-${i}`, kind: 'note', note: `便签${i}`, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      anchor: makeAnnotationAnchor(content, 3, hash, { startByte, endByte: startByte + Buffer.byteLength('重复😀'), sourceExact: '重复😀', displayQuote: '重复😀' }) };
  }) };
const initial = (await reconcileCanvasState(null, { bytes, content, sha256: hash }, (() => { let id = 0; return () => `card-${id++}`; })())).model;
const canvas = { ...initial, cards: initial.cards.map((card, i) => ({ ...card, position: { x: i === 3 ? 800 : i ? 24 : 0, y: i === 1 || i === 2 ? 200 : 0 } })),
  links: [{ id: 'arrow', from: 'card-2', to: 'card-3', label: '保持原章节关系' }], viewport: { x: 35, y: 35, zoom: 0.65 } };
await writeFile(paths[0], bytes); await writeFile(paths[1], serializeAnnotationYaml(annotations)); await writeFile(paths[2], serializeCanvasJson(canvas));
const before = await Promise.all(paths.map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
const port = 10900 + Math.floor(Math.random() * 150);
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`], { cwd: root, stdio: 'ignore' });
let cdp;
try {
  cdp = await connect(await endpoint(port)); await waitFor(cdp, `document.readyState === 'complete'`, 'renderer'); await drop(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.file-name')?.textContent === 'structure.md'`, 'document');
  const operation = { kind: 'move', sourceIndex: 1, targetIndex: 3 };
  for (let i = 0; i < paths.length; i++) {
    const preview = await cdp.evaluate(`window.mermarkd.previewSectionStructure(${JSON.stringify(operation)})`);
    assert.equal(preview.status, 'ready'); assert.equal(preview.impact.mappedCount, 2);
    await writeFile(paths[i], Buffer.concat([before[i].bytes, Buffer.from('\r\n')]));
    const stale = await cdp.evaluate(`window.mermarkd.confirmSectionStructure(${JSON.stringify(preview.token)})`);
    assert.equal(stale.status, 'expired'); await writeFile(paths[i], before[i].bytes);
  }
  const invalid = await cdp.evaluate(`window.mermarkd.previewSectionStructure({kind:'move',sourceIndex:1,targetIndex:2})`);
  assert.equal(invalid.status, 'rejected');
  const cancelled = await cdp.evaluate(`(async () => { const preview = await window.mermarkd.previewSectionStructure(${JSON.stringify(operation)}); await window.mermarkd.cancelSectionStructure(preview.token); return window.mermarkd.confirmSectionStructure(preview.token); })()`);
  assert.equal(cancelled.status, 'expired');
  await click(cdp, '[data-mode="cards"]');
  await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4 && document.querySelector('[data-canvas-save]')?.disabled === false`, 'canvas');
  const originalCanvas = await readFile(paths[2]);
  await dragToOverlap(cdp);
  await click(cdp, '[data-canvas-structure-cancel]'); await click(cdp, '[data-mode="cards"]');
  await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4 && document.querySelector('[data-canvas-save]')?.disabled === false`, 'cancelled canvas');
  assert.deepEqual(await readFile(paths[2]), originalCanvas);
  await dragToOverlap(cdp);
  const qa = path.join(root, 'out', 'qa'); await mkdir(qa, { recursive: true });
  for (const [name, width, height] of [['wide', 1200, 900], ['narrow', 800, 700]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(qa, `a8-4-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  const stagedBaseline = await Promise.all(paths.map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
  await click(cdp, '[data-canvas-structure-confirm]');
  await waitFor(cdp, `document.querySelector('[data-editor-status]').textContent.includes('未保存') && document.querySelector('[data-editor-undo]')?.disabled === false`, 'staged dirty source');
  for (let i = 0; i < paths.length; i++) { assert.deepEqual(await readFile(paths[i]), stagedBaseline[i].bytes); assert.equal((await stat(paths[i])).mtimeMs, stagedBaseline[i].mtime); }
  await click(cdp, '[data-mode="cards"]');
  await waitFor(cdp, `document.querySelector('[data-canvas-status]')?.textContent.includes('写入已暂停')`, 'dirty projection');
  const pendingCanvas = await cdp.evaluate('window.mermarkd.loadCanvas()');
  assert.deepEqual(pendingCanvas.model.cards[1].anchor.titlePath, ['D', 'B']); assert.deepEqual(pendingCanvas.model.links, canvas.links);
  assert.equal((await cdp.evaluate(`window.mermarkd.saveCanvas(${JSON.stringify({ sourceSha256: hash, expectedSidecarSha256: null, model: canvas })})`)).status, 'conflict');
  await click(cdp, '[data-mode="reader"]'); await click(cdp, '[data-mode="editor"]');
  await click(cdp, '[data-editor-undo]'); await waitFor(cdp, `document.querySelector('[data-editor-status]').textContent.includes('已保存')`, 'single undo');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-editor-textarea]').value`), content.replaceAll('\r\n', '\n'));
  await click(cdp, '[data-editor-redo]'); await waitFor(cdp, `document.querySelector('[data-editor-status]').textContent.includes('未保存')`, 'single redo');
  await click(cdp, '[data-editor-save]'); await waitFor(cdp, `document.querySelector('[data-editor-status]').textContent.includes('已保存') && document.querySelector('[data-editor-save]')?.disabled === false`, 'three-file save');
  const preview = previewSectionTransform(content, operation); assert.equal(preview.status, 'ready');
  const after = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(preview.candidate)]);
  assert.deepEqual(await readFile(paths[0]), after);
  const yaml = parseAnnotationYaml(await readFile(paths[1], 'utf8'));
  const afterHash = createHash('sha256').update(after).digest('hex');
  for (const item of yaml.annotations) { assert.equal(item.anchor.basisSha256, afterHash); assert.equal(after.subarray(item.anchor.startByte, item.anchor.endByte).toString(), '重复😀'); }
  assert.notEqual(yaml.annotations[0].anchor.startByte, yaml.annotations[1].anchor.startByte);
  const savedCanvas = JSON.parse(await readFile(paths[2], 'utf8'));
  assert.equal(savedCanvas.source.sha256, afterHash); assert.deepEqual(savedCanvas.cards.map((card) => card.id), canvas.cards.map((card) => card.id));
  assert.deepEqual(savedCanvas.links, canvas.links); assert.deepEqual(savedCanvas.cards[2].anchor.titlePath, ['D', 'B', 'C']);
  await drop(cdp, documentPath); await waitFor(cdp, `document.querySelector('[data-mode="reader"]')?.getAttribute('aria-current') === 'page'`, 'reopen');
  const annotationView = await cdp.evaluate('window.mermarkd.loadAnnotations()'); assert.equal(annotationView.unresolvedCount, 0);
  await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `document.querySelectorAll('.react-flow__node').length === 4`, 'reopen nested canvas');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-id="card-1"]').classList.contains('react-flow__node')`), true);
  console.log(JSON.stringify({ status: 'passed', overlapCandidate: true, cancelRestoresLayout: true, threeIndependentStaleGates: true,
    confirmationWritesNothing: true, modeSwitchPreservesUndo: true, dirtySidecarsFrozen: true, structuralSave: true,
    repeatedAnnotationsMapped: 2, cardIdsAndArrowPreserved: true, bomCrLfPreserved: true, reopen: true, widths: [1200, 800] }));
} finally { cdp?.close(); try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } await new Promise((resolve) => setTimeout(resolve, 300)); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
