import assert from 'node:assert/strict';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMarkdownBytes } from '../../src/core/markdown-source.ts';
import { makeAnnotationAnchor } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { bundleDigest, prepareSectionStructurePlan } from '../../src/main/section-structure-store.ts';
import { commitDocumentTransaction, listDocumentTransactions, prepareDocumentTransaction } from '../../src/main/document-transaction.ts';

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
async function endpoint(port, kind = 'page') { const deadline = Date.now() + 15000; while (Date.now() < deadline) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((item) => item.type === kind); if (page) return page; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out waiting for ${kind}.`); }
async function connect(page) { const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); const cdp = new Cdp(socket); await cdp.send('Runtime.enable'); return cdp; }
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 15000; let last; while (Date.now() < deadline) { last = await cdp.evaluate(expression); if (last === true) return; await new Promise((resolve) => setTimeout(resolve, 60)); } throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`); }
async function click(cdp, selector) { assert.equal(await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false; element.click(); return true; })()`), true, `enabled element missing: ${selector}`); }
async function drop(cdp, filePath) { const rect = await cdp.evaluate(`(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0); const target = document.querySelector('[data-markdown-drop-target]'); const box = target.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`); const data = { items: [], files: [filePath], dragOperationsMask: 1 }; await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data }); await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data }); }
async function fixture(directory, name) {
  const documentPath = path.join(directory, `${name}.md`);
  const content = '# 根\r\n首节正文。\r\n## 子\r\n要移动的文字😀。\r\n# 末节\r\n末节正文。\r\n';
  const bytes = encodeMarkdownBytes(content, 3); const sha256 = bundleDigest(bytes);
  const startByte = 3 + Buffer.byteLength(content.slice(0, content.indexOf('移动的文字😀')));
  const model = { schemaVersion: 1, source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
    annotations: [{ id: 'note', kind: 'note', note: '保留便签', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
      anchor: makeAnnotationAnchor(content, 3, sha256, { startByte, endByte: startByte + Buffer.byteLength('移动的文字😀'), sourceExact: '移动的文字😀', displayQuote: '移动的文字😀' }) }] };
  const canvas = (await reconcileCanvasState(null, { bytes, content, sha256 })).model;
  const paths = [documentPath, `${documentPath}.annotations.yaml`, `${documentPath}.mermarkd.json`];
  await writeFile(paths[0], bytes); await writeFile(paths[1], serializeAnnotationYaml(model)); await writeFile(paths[2], serializeCanvasJson(canvas));
  const document = { path: documentPath, name: `${name}.md`, content, sourceSha256: sha256, bomByteLength: 3 };
  const plan = await prepareSectionStructurePlan(document, { kind: 'move', sourceIndex: 1, targetIndex: 2 });
  const ref = await prepareDocumentTransaction({ documentPath, before: plan.before, after: plan.after });
  return { document, paths, plan, ref, journal: `${documentPath}.mermarkd-txn.${ref.id}.journal.json` };
}
async function crash(f, kind) {
  await assert.rejects(promisify(execFile)(process.execPath, ['tests/fixtures/transaction-crash.mjs', f.document.path, JSON.stringify(f.ref), 'afterDisplaced', kind], { cwd: root }), (error) => error.code === 37);
}
async function optionalBytes(name) { try { return await readFile(name); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function verifyAfter(f) {
  for (const [i, kind] of ['markdown', 'annotations', 'canvas'].entries()) assert.deepEqual(await readFile(f.paths[i]), Buffer.from(f.plan.after[kind]));
  assert.equal((await listDocumentTransactions(f.document.path))[0].completed, true);
  const yaml = parseAnnotationYaml(await readFile(f.paths[1], 'utf8')); assert.equal(yaml.annotations[0].note, '保留便签');
  assert.equal(yaml.annotations[0].anchor.basisSha256, bundleDigest(f.plan.after.markdown));
}

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a8-5-e2e-'));
const missing = await fixture(workspace, '原路径缺失'); await crash(missing, 'markdown');
const partial = await fixture(workspace, '部分发布'); await crash(partial, 'annotations');
const conflict = await fixture(workspace, '外部冲突');
const locked = await fixture(workspace, '保存锁');
const live = await fixture(workspace, '本轮写入失败');
assert.equal((await commitDocumentTransaction(live.document.path, live.ref)).status, 'committed');
const port = 11500 + Math.floor(Math.random() * 150); const inspectorPort = port + 400;
const child = spawn(executable, [`--inspect=${inspectorPort}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`], { cwd: root, stdio: 'ignore' });
let cdp; let mainCdp;
try {
  cdp = await connect(await endpoint(port)); mainCdp = await connect(await endpoint(inspectorPort, 'node'));
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer');
  await mainCdp.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(missing.journal)}] })`);
  await click(cdp, '[data-open-document-recovery]'); await waitFor(cdp, `Boolean(document.querySelector('[data-document-recovery]'))`, 'recovery dialog');
  await click(cdp, '[data-recovery-select]'); await waitFor(cdp, `document.querySelector('[data-recovery-confirm]')?.disabled === false`, 'missing-source preview');
  const before = await Promise.all(missing.paths.map(optionalBytes));
  await click(cdp, '[aria-label="关闭保存恢复"]');
  for (let i = 0; i < before.length; i++) assert.deepEqual(await optionalBytes(missing.paths[i]), before[i]);
  await click(cdp, '[data-open-document-recovery]'); await waitFor(cdp, `document.querySelector('[data-recovery-select]')?.disabled === false`, 'second recovery open');
  await click(cdp, '[data-recovery-select]'); await waitFor(cdp, `document.querySelector('[data-recovery-confirm]')?.disabled === false`, 'missing-source second preview');
  await click(cdp, '[data-recovery-confirm]'); await waitFor(cdp, `document.querySelector('.file-name')?.textContent === '原路径缺失.md' && !document.querySelector('[data-document-recovery]')`, 'missing-source recovered');
  await verifyAfter(missing); assert.deepEqual(await cdp.evaluate('window.mermarkd.listDocumentRecovery()'), []);
  await drop(cdp, partial.document.path); await waitFor(cdp, `Boolean(document.querySelector('[data-document-recovery-pending]'))`, 'partial save warning');
  assert.equal(await cdp.evaluate(`window.mermarkd.openMarkdownEditor().then(() => false, () => true)`), true);
  assert.equal((await cdp.evaluate(`window.mermarkd.saveCanvas({})`)).status, 'conflict');
  await click(cdp, '[data-open-document-recovery]'); await waitFor(cdp, `Boolean(document.querySelector('[data-recovery-inspect]'))`, 'pending list');
  await click(cdp, `[data-recovery-inspect="${partial.ref.id}"]`); await waitFor(cdp, `document.querySelector('[data-recovery-confirm]')?.disabled === false`, 'partial preview');
  const qa = path.join(root, 'out', 'qa'); await mkdir(qa, { recursive: true });
  for (const [name, width, height] of [['wide', 1200, 900], ['narrow', 800, 700], ['mobile', 420, 800]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} recovery overflow`);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(qa, `a8-5-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await click(cdp, '[data-recovery-confirm]'); await waitFor(cdp, `!document.querySelector('[data-document-recovery]') && !document.querySelector('[data-document-recovery-pending]')`, 'partial recovered');
  await verifyAfter(partial);
  await click(cdp, '[data-mode="editor"]'); await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'recovered editor');
  await cdp.evaluate(`(() => { const element = document.querySelector('[data-editor-textarea]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(element, element.value + ${JSON.stringify('后续编辑\n')}); element.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  await click(cdp, '[data-editor-save]'); await waitFor(cdp, `document.querySelector('[data-editor-status]')?.textContent.includes('已保存') && document.querySelector('[data-editor-save]')?.disabled === false`, 'later source save');
  await drop(cdp, partial.document.path); await waitFor(cdp, `document.querySelector('[data-active-mode]')?.dataset.activeMode === 'reader'`, 'later reopen');
  assert.deepEqual(await cdp.evaluate('window.mermarkd.listDocumentRecovery()'), []); assert.equal(await cdp.evaluate(`Boolean(document.querySelector('[data-document-recovery-pending]'))`), false);
  await drop(cdp, conflict.document.path); await waitFor(cdp, `document.querySelector('.file-name')?.textContent === '外部冲突.md'`, 'conflict doc');
  const conflictPreview = await cdp.evaluate(`window.mermarkd.previewDocumentRecovery(${JSON.stringify(conflict.ref.id)})`);
  await writeFile(conflict.paths[2], '{"external":"preserve"}\n');
  const result = await cdp.evaluate(`window.mermarkd.confirmDocumentRecovery(${JSON.stringify(conflictPreview.token)})`);
  assert.equal(result.status, 'conflict'); assert.equal(await readFile(conflict.paths[2], 'utf8'), '{"external":"preserve"}\n');
  assert.deepEqual(await readFile(conflict.paths[0]), Buffer.from(conflict.plan.before.markdown));
  const freshConflict = await cdp.evaluate(`window.mermarkd.previewDocumentRecovery(${JSON.stringify(conflict.ref.id)})`); assert.equal(freshConflict.recoverable, false);
  await drop(cdp, locked.document.path); await waitFor(cdp, `document.querySelector('.file-name')?.textContent === '保存锁.md'`, 'locked doc');
  const lock = `${locked.document.path}.mermarkd-save.lock`;
  await writeFile(lock, JSON.stringify({ schemaVersion: 1, kind: 'markdown-save-lock', documentPath: locked.document.path,
    ownerToken: '00000000-0000-0000-0000-000000000000', pid: process.pid, createdAt: new Date().toISOString() }));
  const lockPreview = await cdp.evaluate(`window.mermarkd.previewDocumentRecovery(${JSON.stringify(locked.ref.id)})`);
  const busy = await cdp.evaluate(`window.mermarkd.confirmDocumentRecovery(${JSON.stringify(lockPreview.token)})`);
  assert.equal(busy.status, 'conflict'); assert.deepEqual(await readFile(locked.paths[0]), Buffer.from(locked.plan.before.markdown));
  await rm(lock); const recovered = await cdp.evaluate(`window.mermarkd.confirmDocumentRecovery(${JSON.stringify(lockPreview.token)})`); assert.equal(recovered.status, 'recovered'); await verifyAfter(locked);
  await drop(cdp, live.document.path); await waitFor(cdp, `document.querySelector('.file-name')?.textContent === '本轮写入失败.md'`, 'live failure document');
  await click(cdp, '[data-mode="cards"]'); await waitFor(cdp, `document.querySelector('[data-canvas-save]')?.disabled === false`, 'live failure canvas');
  await cdp.evaluate(`(() => { for (const [selector,value] of [['[data-canvas-structure-source]','2'],['[data-canvas-structure-parent]','0']]) {
    const element = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,value);
    element.dispatchEvent(new Event('change',{bubbles:true})); } })()`);
  await click(cdp, '[data-canvas-preview-structure]'); await waitFor(cdp, `Boolean(document.querySelector('[data-canvas-structure-confirm]'))`, 'live structure preview');
  await click(cdp, '[data-canvas-structure-confirm]'); await waitFor(cdp, `document.querySelector('[data-editor-status]')?.textContent.includes('未保存')`, 'live structure dirty');
  await mainCdp.evaluate(`(() => { const fs = process.mainModule.require('node:fs/promises'); globalThis.__mermarkdOriginalLink = fs.link;
    fs.link = async (source,destination) => { if (destination === ${JSON.stringify(live.paths[1])}) throw Object.assign(new Error('injected publication failure'),{code:'EIO'}); return globalThis.__mermarkdOriginalLink(source,destination); }; })()`);
  await click(cdp, '[data-editor-save]'); await waitFor(cdp, `document.querySelector('[data-editor-textarea]')?.readOnly === true && document.querySelector('[data-editor-status]')?.textContent.includes('结构保存未完成')`, 'live failed save frozen');
  await mainCdp.evaluate(`process.mainModule.require('node:fs/promises').link = globalThis.__mermarkdOriginalLink`);
  await click(cdp, '[data-open-document-recovery]');
  try { await waitFor(cdp, `document.querySelector('[data-recovery-inspect]')?.disabled === false`, 'live pending recovery'); }
  catch (error) { console.error({ items: await cdp.evaluate('window.mermarkd.listDocumentRecovery()'),
    panel: await cdp.evaluate(`document.querySelector('[data-document-recovery]')?.textContent`),
    inventory: await listDocumentTransactions(live.document.path) }); throw error; }
  await click(cdp, '[data-recovery-inspect]'); await waitFor(cdp, `document.querySelector('[data-recovery-confirm]')?.disabled === false`, 'live recovery preview');
  await click(cdp, '[data-recovery-confirm]'); await waitFor(cdp, `document.querySelector('[data-active-mode]')?.dataset.activeMode === 'reader' && !document.querySelector('[data-document-recovery]')`, 'dirty own transaction recovered');
  const liveBytes = await readFile(live.paths[0]); const liveYaml = parseAnnotationYaml(await readFile(live.paths[1], 'utf8'));
  assert.equal(liveYaml.annotations[0].anchor.basisSha256, bundleDigest(liveBytes));
  assert.deepEqual(await cdp.evaluate('window.mermarkd.listDocumentRecovery()'), []);
  console.log(JSON.stringify({ status: 'passed', missingSourceRecovery: true, partialYamlRecovery: true, previewCancelNoWrites: true,
    pendingWritesFrozen: true, externalConflictPreserved: true, activeLockBlocked: true, historicalReceiptSurvivesLaterEdit: true,
    annotationRetained: true, liveFailureFreezesEditor: true, dirtyOwnTransactionRecovery: true, widths: [1200, 800, 420] }));
} finally { cdp?.close(); mainCdp?.close(); try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } await new Promise((resolve) => setTimeout(resolve, 300)); await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
