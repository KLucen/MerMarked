import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { openWorkspaceTask } from './workspace-controls.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux4-'));
const fixture = path.join(workspace, '章节整理.md');
const hugeFixture = path.join(workspace, '超宽画布.md');
const content = '# 研究计划\r\n重复😀。\r\n\r\n## 同名章节\r\n重复😀。\r\n' +
  '这里是需要保留的长正文，画布默认只显示摘要。'.repeat(20) + '\r\n\r\n### 深层章节\r\n后代内容与链接保持。\r\n\r\n# 同名章节\r\n另一分支的同名标题。\r\n';
const hugeContent = '# 左侧章节\n\n起点。\n\n# 远方章节\n\n视口外的目标。\n';
async function seed(file, source, huge = false) {
  const bytes = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(source)]);
  const hash = createHash('sha256').update(bytes).digest('hex');
  let nextId = 0;
  const initial = (await reconcileCanvasState(null, { bytes, content: source, sha256: hash }, () => `card-${nextId++}`)).model;
  const canvas = { ...initial,
    cards: initial.cards.map((card, index) => ({ ...card, position: huge
      ? { x: index ? 13000 : 80, y: 80 }
      : { x: index === 3 ? 900 : index ? 24 : 80, y: index === 1 || index === 2 ? 200 : 80 } })),
    links: [{ id: 'cross-branch', from: huge ? 'card-0' : 'card-2', to: huge ? 'card-1' : 'card-3', label: '跨分支关系：保留章节身份' }],
    viewport: { x: 35, y: 35, zoom: 0.65 },
  };
  const annotations = { schemaVersion: 1, source: { sha256: hash, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
    annotations: huge ? [] : [source.indexOf('重复😀'), source.lastIndexOf('重复😀')].map((start, index) => {
      const startByte = 3 + Buffer.byteLength(source.slice(0, start));
      return { id: `note-${index}`, kind: 'note', note: `同名章节测试便签 ${index}`, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z',
        anchor: makeAnnotationAnchor(source, 3, hash, { startByte, endByte: startByte + Buffer.byteLength('重复😀'), sourceExact: '重复😀', displayQuote: '重复😀' }) };
    }) };
  await writeFile(file, bytes);
  await writeFile(file + '.annotations.yaml', serializeAnnotationYaml(annotations));
  await writeFile(file + '.mermarkd.json', serializeCanvasJson(canvas));
}
await seed(fixture, content); await seed(hugeFixture, hugeContent, true);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const port = 15600 + Math.floor(Math.random() * 100);
const child = spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
  [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
  { cwd: root, stdio: 'ignore', windowsHide: true });
const clients = [];
async function connect(port, type) {
  let target;
  for (let index = 0; index < 150; index++) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === type); } catch {}
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, `endpoint ${type}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const pending = new Map(); let nextId = 1;
  socket.addEventListener('message', (event) => {
    const result = JSON.parse(event.data); const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id); result.error ? request.reject(Error(JSON.stringify(result.error))) : request.resolve(result.result);
  });
  const client = {
    send(method, params = {}) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); },
  };
  clients.push(client); return client;
}
let page; let main;
async function wait(expression, label) {
  for (let index = 0; index < 200; index++) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(`${label}: ${await page.evaluate('document.body.innerText.slice(0,2200)')}`);
}
async function frame() { await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function click(selector) {
  const point = await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(point, `visible enabled ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await frame();
}
async function keyboardSelect(selector, value) {
  await page.send('Page.bringToFront');
  const index = await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); e.focus(); return [...e.options].findIndex(option=>option.value===${JSON.stringify(value)}); })()`);
  assert.ok(index >= 0, `select option ${selector}: ${value}`);
  await key('Home', 'Home', 36);
  for (let count = 0; count < index; count++) await key('ArrowDown', 'ArrowDown', 40);
  await wait(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`, 'keyboard selection ' + value);
}
async function fill(selector, value) {
  await click(selector);
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
  await page.send('Input.insertText', { text: value }); await frame();
}
async function details(selector, open = true) {
  if (await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).open`) !== open) await click(selector + ' > summary');
}
async function visible(selector) { return page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`); }
async function screenshot(name) {
  const result = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `ux4-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}
async function canvasJson(predicate, label) {
  for (let count = 0; count < 200; count++) {
    const model = JSON.parse(await readFile(fixture + '.mermarkd.json', 'utf8'));
    if (predicate(model)) return model;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error('Canvas file did not reach ' + label);
}
async function dirty(value) { await wait(`document.querySelector('.app-shell').dataset.dirty===${JSON.stringify(String(value))}`, 'dirty=' + value); }
async function closePanels() {
  if (await visible('#workspace-right-panel')) await click('[data-workspace-right-toggle]');
  if (await visible('#workspace-left-panel')) await click('[aria-label="收起左侧栏"]');
}
async function positions() {
  return page.evaluate('[...document.querySelectorAll(".react-flow__node")].map(e=>({id:e.dataset.id,transform:e.style.transform})).sort((a,b)=>a.id.localeCompare(b.id))');
}
async function assertLayout() {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'no page horizontal overflow');
  assert.equal(await page.evaluate('[...document.querySelectorAll(".topbar button")].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})'), true, 'topbar remains within viewport');
  assert.equal(await page.evaluate('(()=>{const e=document.querySelector("#workspace-right-panel");if(!e.getClientRects().length)return true;const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight+1&&(innerWidth>1100||r.top===0&&r.height>=innerHeight-1)})()'), true, 'inspector remains within viewport and narrow drawer occupies its full height');
}
async function openFile(file, initial = false) {
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:[' + JSON.stringify(file) + ']})');
  await click(initial ? '[data-start-open]' : '[aria-label="打开文档"]');
  await wait('document.querySelector(".workspace-current-name")?.textContent===' + JSON.stringify(path.basename(file)), 'document opened');
  await click('[data-mode="cards"]');
  await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'canvas ready');
}
async function dragToOverlap() {
  await page.send('Page.bringToFront');
  const points = await page.evaluate(`(() => { const a=document.querySelector('[data-id="card-1"] .canvas-card-header strong').getBoundingClientRect(); const b=document.querySelector('[data-id="card-3"] .canvas-card-body').getBoundingClientRect(); return {sx:a.x+a.width/2,sy:a.y+a.height/2,tx:b.x+b.width/2,ty:b.y+b.height/2}; })()`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.sx, y: points.sy, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= 15; step++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.sx + (points.tx - points.sx) * step / 15, y: points.sy + (points.ty - points.sy) * step / 15, buttons: 1 });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  await new Promise((resolve) => setTimeout(resolve, 360));
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.tx, y: points.ty, button: 'left', clickCount: 1, buttons: 0 });
  await wait('Boolean(document.querySelector("[data-canvas-structure-preview]"))', 'drag overlap preview');
}
try {
  page = await connect(port, 'page'); main = await connect(port + 200, 'node');
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start');
  await metrics(1200, 800);
  const untouched = await snapshot();
  await openFile(fixture, true);
  await wait('document.querySelectorAll(".react-flow__node").length===4', 'four nested cards');
  assert.equal(await page.evaluate('document.querySelectorAll(".canvas-card-path").length'), 0, 'card titles do not repeat the entire ancestor path');
  assert.equal(await page.evaluate('[...document.querySelectorAll(".canvas-card-count")].some(e=>/^0\\s/.test(e.textContent.trim()))'), false, 'leaf cards do not display zero child counts');
  await details('.canvas-toolbar-exports');
  const exportText = await page.evaluate('document.querySelector("[data-canvas-export-preflight]").textContent');
  assert.match(exportText, /\d+\s*×\s*\d+/);
  assert.match(exportText, /4\s*张/); assert.match(exportText, /1\s*条/);
  await details('.canvas-toolbar-exports', false);
  await openWorkspaceTask(page);
  await keyboardSelect('[data-canvas-card-picker]', 'card-2');
  await wait('Boolean(document.querySelector("[data-canvas-card-inspector]"))', 'selected card inspector');
  assert.equal(await visible('[data-canvas-link-inspector]'), false);
  assert.equal(await page.evaluate('document.querySelectorAll(".canvas-card-actions:not([hidden])").length'), 1, 'only the selected card exposes actions');
  assert.equal(await page.evaluate('document.querySelector("[data-id=card-2] .canvas-card-actions").hidden'), false);
  assert.deepEqual(await snapshot(), untouched, 'opening, selecting and inspecting do not write files');
  await screenshot('card-inspector');

  // The new relationship draft must not be reused as the selected edge label.
  await details('[data-canvas-link-composer]');
  const draft = '尚未提交的新关系草稿';
  await fill('[data-canvas-link-label]', draft);
  await keyboardSelect('[data-canvas-link-picker]', 'cross-branch');
  await wait('Boolean(document.querySelector("[data-canvas-link-inspector]"))', 'selected link inspector');
  assert.equal(await visible('[data-canvas-card-inspector]'), false, 'card and relationship inspectors are exclusive');
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-selected-link-label]").value'), '跨分支关系：保留章节身份');
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-link-label]").value'), draft);
  await fill('[data-canvas-selected-link-label]', '已更新的跨分支关系');
  await click('[data-canvas-update-link]');
  await canvasJson((model) => model.links[0]?.label === '已更新的跨分支关系', 'updated relationship label');
  const updated = await snapshot();
  assert.deepEqual(updated.slice(0, 2), untouched.slice(0, 2), 'updating a relationship writes JSON only');
  assert.notDeepEqual(updated[2].bytes, untouched[2].bytes);
  await click('[data-workspace-right-toggle]'); await openWorkspaceTask(page);
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-link-label]").value'), draft, 'draft survives inspector visibility changes');
  await wait('document.querySelector("[data-canvas-delete-link]")?.disabled===false', 'link deletion ready');
  await click('[data-canvas-delete-link]');
  await canvasJson((model) => model.links.length === 0, 'deleted relationship');
  assert.deepEqual((await snapshot()).slice(0, 2), untouched.slice(0, 2), 'deleting a relationship writes JSON only');
  await keyboardSelect('[data-canvas-link-from]', 'card-2'); await keyboardSelect('[data-canvas-link-to]', 'card-3');
  await click('[data-canvas-add-link]');
  const linked = await canvasJson((model) => model.links.length === 1 && model.links[0].label === draft, 'new relationship draft saved');
  await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'relationship save complete');
  assert.deepEqual((await snapshot()).slice(0, 2), untouched.slice(0, 2));
  console.log('UX4: keyboard selection, exclusive inspectors and independent relationship draft passed');

  await closePanels(); await click('[aria-label="适应全图"]'); await frame();
  const beforeStructure = await snapshot(); const beforeDragPositions = await positions();
  await dragToOverlap();
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), 'cards', 'drag preview stays on the canvas');
  assert.deepEqual(await snapshot(), beforeStructure, 'drag preview performs no writes');
  await openWorkspaceTask(page); await click('[data-canvas-structure-cancel]');
  await wait('!document.querySelector("[data-canvas-structure-preview]") && !document.querySelector("[data-canvas-save]").disabled', 'preview cancelled');
  assert.deepEqual(await positions(), beforeDragPositions, 'cancelling restores original scene coordinates');
  assert.deepEqual(await snapshot(), beforeStructure, 'cancelling preserves all three files and mtimes');

  // Hold a real preview reply after the main process creates its token. A mode
  // switch must invalidate the renderer request and cancel that late token.
  await main.evaluate(`(() => {
    const ipc = process.mainModule.require('electron').ipcMain;
    globalThis.__ux4Preview = ipc._invokeHandlers.get('section-structure:preview');
    globalThis.__ux4Cancel = ipc._invokeHandlers.get('section-structure:cancel');
    globalThis.__ux4ReplyReady = false; globalThis.__ux4Cancelled = false;
    ipc.removeHandler('section-structure:preview');
    ipc.handle('section-structure:preview', async (...args) => {
      const result = await globalThis.__ux4Preview(...args);
      globalThis.__ux4LateToken = result.token; globalThis.__ux4ReplyReady = true;
      await new Promise(resolve => { globalThis.__ux4Release = resolve; });
      return result;
    });
    ipc.removeHandler('section-structure:cancel');
    ipc.handle('section-structure:cancel', (...args) => {
      if (args[1] === globalThis.__ux4LateToken) globalThis.__ux4Cancelled = true;
      return globalThis.__ux4Cancel(...args);
    });
  })()`);
  await details('[data-canvas-structure-tools]');
  await keyboardSelect('[data-canvas-structure-source]', '1'); await keyboardSelect('[data-canvas-structure-parent]', '3');
  await click('[data-canvas-preview-structure]');
  for (let attempt = 0; attempt < 100 && !await main.evaluate('globalThis.__ux4ReplyReady'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await main.evaluate('globalThis.__ux4ReplyReady'), true, 'real preview token created');
  await click('[data-mode="reader"]');
  await main.evaluate('globalThis.__ux4Release()');
  for (let attempt = 0; attempt < 100 && !await main.evaluate('globalThis.__ux4Cancelled'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await main.evaluate('globalThis.__ux4Cancelled'), true, 'late token is explicitly cancelled');
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), 'reader');
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-canvas-structure-preview]"))'), false);
  assert.deepEqual(await snapshot(), beforeStructure, 'late preview and mode change do not write files');
  await main.evaluate(`(() => {
    const ipc = process.mainModule.require('electron').ipcMain;
    ipc.removeHandler('section-structure:preview'); ipc.handle('section-structure:preview', globalThis.__ux4Preview);
    ipc.removeHandler('section-structure:cancel'); ipc.handle('section-structure:cancel', globalThis.__ux4Cancel);
  })()`);
  await click('[data-mode="cards"]');
  await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'canvas after late reply');
  await openWorkspaceTask(page);

  await details('[data-canvas-structure-tools]');
  await keyboardSelect('[data-canvas-structure-source]', '1'); await keyboardSelect('[data-canvas-structure-parent]', '3');
  await click('[data-canvas-preview-structure]');
  await wait('Boolean(document.querySelector("[data-canvas-structure-preview]"))', 'explicit preview');
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), 'cards');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-canvas-structure-preview]").length'), 1, 'only one candidate review is mounted');
  assert.match(await page.evaluate('document.querySelector("[data-canvas-structure-levels]").textContent'), /2\s*级\s*→\s*2\s*级/);
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-structure-diff]").open'), false, 'source diff is initially collapsed');
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").disabled'), true);
  assert.equal(await page.evaluate('[...document.querySelectorAll("[data-canvas-export]")].every(e=>e.disabled)'), true, 'pending preview freezes exports');
  await details('[data-canvas-structure-diff]');
  const candidate = await page.evaluate('document.querySelector("[data-canvas-structure-after]").textContent');
  assert.ok(candidate.indexOf('# 同名章节') < candidate.indexOf('## 同名章节'));
  await details('[data-canvas-structure-diff]', false);
  for (const [width, height] of [[1200, 800], [800, 700], [420, 800]]) {
    await metrics(width, height); await openWorkspaceTask(page); await assertLayout(); await screenshot('structure-' + width);
    assert.deepEqual(await snapshot(), beforeStructure, 'responsive review does not write files');
  }
  await metrics(1200, 800); await openWorkspaceTask(page);
  await click('[data-canvas-structure-confirm]'); await dirty(true);
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), 'cards', 'confirmation stays on the canvas');
  await wait('document.querySelector("[data-canvas-source-undo]")?.disabled===false', 'source undo from canvas');
  assert.deepEqual(await snapshot(), beforeStructure, 'confirmation only changes the shared buffer');
  await wait('!document.querySelector("[data-canvas-status]").textContent.includes("正在")', 'staged scene settled');
  await frame();
  await click('[data-canvas-source-undo]'); await dirty(false);
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").value'), content.replaceAll('\r\n', '\n'));
  await wait('document.querySelector("[data-canvas-source-redo]")?.disabled===false', 'source redo from canvas');
  await click('[data-canvas-source-redo]'); await dirty(true);
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").value'), candidate.replaceAll('\r\n', '\n'));
  assert.deepEqual(await snapshot(), beforeStructure, 'undo and redo do not write any content file');
  await click('[data-workspace-save]'); await dirty(false);
  assert.deepEqual(await readFile(fixture), Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(candidate)]));
  const saved = JSON.parse(await readFile(fixture + '.mermarkd.json', 'utf8'));
  assert.deepEqual(saved.links, linked.links, 'structural save preserves relationship identity');
  const annotations = parseAnnotationYaml(await readFile(fixture + '.annotations.yaml', 'utf8'));
  const savedBytes = await readFile(fixture); const savedHash = createHash('sha256').update(savedBytes).digest('hex');
  assert.equal(saved.source.sha256, savedHash);
  assert.equal(annotations.annotations.length, 2);
  for (const item of annotations.annotations) {
    assert.equal(item.anchor.basisSha256, savedHash);
    assert.equal(savedBytes.subarray(item.anchor.startByte, item.anchor.endByte).toString(), '重复😀');
  }
  console.log('UX4: drag cancellation, in-canvas review, shared undo/redo and explicit save passed');

  await closePanels();
  const hugeBefore = await snapshot(hugeFixture); await openFile(hugeFixture);
  await details('.canvas-toolbar-exports');
  await wait('document.querySelector("[data-canvas-export-preflight]")?.textContent.includes("超出")', 'oversize export preflight');
  const oversizedText = await page.evaluate('document.querySelector("[data-canvas-export-preflight]").textContent');
  assert.match(oversizedText, /2\s*张/); assert.match(oversizedText, /1\s*条/);
  const size = oversizedText.match(/(\d+)\s*×\s*(\d+)/); assert.ok(size && Number(size[1]) > 12000, 'unclipped scene dimensions remain visible');
  assert.equal(await page.evaluate('[...document.querySelectorAll("[data-canvas-export]")].every(e=>e.disabled)'), true);
  for (const [width, height] of [[1200, 800], [800, 700], [420, 800]]) {
    await metrics(width, height); await assertLayout(); await screenshot('export-limit-' + width);
  }
  assert.deepEqual(await snapshot(hugeFixture), hugeBefore, 'preflight, panel visibility and viewport changes do not write files');
  console.log('UX4 packaged E2E passed: card clarity, contextual controls, structural continuity and export limits.');
} catch (error) {
  if (page) { try { await screenshot('failure'); } catch {} }
  throw error;
} finally {
  for (const client of clients) client.close();
  if (child.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
}
