import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux1-'));
const fixture = path.join(workspace, '工作笔记.md');
const content = '# 工作笔记\n\n这是一段可以编辑和批注的正文。\n\n## 下一步\n\n整理资料，记录想法。\n\n包含**强调**的选区。\n\n| 项目 | 进度 |\n| --- | --- |\n| 设计检查 | 已完成 |\n';
await writeFile(fixture, content);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const port = 14800 + Math.floor(Math.random() * 100);
const child = spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
  [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
  { cwd: root, stdio: 'ignore', windowsHide: true });
const clients = [];
async function connect(port, type) {
  let page;
  for (let i = 0; i < 150; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === type); } catch {}
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, `endpoint ${type}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
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
let page;
async function wait(expression, label) {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(`${label}: ${await page.evaluate('document.body.innerText.slice(0,1800)')}`);
}
async function click(selector) {
  const point = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(point, `visible enabled ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function screenshot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `ux1-${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function select(selector) {
  await page.send('Page.bringToFront');
  await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
  await wait(`Boolean(document.querySelector('[data-selection-capability]')) && document.querySelector('.selection-quote')?.title===document.querySelector(${JSON.stringify(selector)}).textContent`, 'selection capability');
}
async function escape() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}
try {
  page = await connect(port, 'page'); const main = await connect(port + 200, 'node');
  await wait(`Boolean(document.querySelector('[data-start-open]'))`, 'start');
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog = async () => ({canceled:false,filePaths:[${JSON.stringify(fixture)}]})`);
  await click('[data-start-open]');
  await wait(`Boolean(document.querySelector('p[data-reader-editable]')) && !document.querySelector('.annotation-summary')`, 'reader ready');
  const before = await stat(fixture);
  assert.equal(await page.evaluate(`document.querySelector('.modebar').textContent.replace(/\s/g,'')`), '阅读源码卡片');
  assert.equal(await page.evaluate(`Boolean(document.querySelector('.workspace-utilitybar,.document-name,[data-editor-save]'))`), false);
  await click('[aria-label="文档菜单"]');
  assert.equal(await page.evaluate(`Boolean(document.querySelector('[data-workspace-save-as]'))`), false);
  await click('[aria-label="文档菜单"]');
  await click('[aria-label="文档状态"]');
  assert.equal(await page.evaluate(`document.querySelector('[data-workspace-status="canvas"]').textContent`), '画布：尚未载入');
  await escape();
  assert.equal(await page.evaluate(`document.activeElement?.getAttribute('aria-label')`), '文档状态');
  await select('.markdown-body > p');
  assert.match(await page.evaluate(`document.querySelector('[data-selection-capability]').textContent`), /可编辑正文/);
  await escape();
  await select('.markdown-body p:has(strong)');
  assert.match(await page.evaluate(`document.querySelector('[data-selection-capability]').textContent`), /可批注.*源码/);
  await escape();
  assert.equal(await page.evaluate(`document.querySelector('.markdown-body p strong')?.textContent`), '强调');
  await page.evaluate(`document.activeElement?.blur(); getSelection()?.removeAllRanges()`);
  for (const [name, width, height] of [['wide',1200,800],['narrow',800,700],['compact',420,800]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('window.scrollTo(0,0)');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('.topbar button')].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})`), true, `${name} toolbar controls`);
    await screenshot(`reader-${name}`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await click('[data-mode="editor"]');
  await wait(`Boolean(document.querySelector('[data-editor-textarea]'))`, 'editor');
  assert.equal(await page.evaluate(`document.querySelector('[data-editor-structure]').hidden`), true);
  await screenshot('source');
  await click('[data-editor-structure-toggle]');
  assert.equal(await page.evaluate(`document.querySelector('[data-editor-structure]').hidden`), false);
  await click('[data-editor-structure-toggle]');
  await click('[data-mode="cards"]');
  await wait(`document.querySelector('[data-canvas-save]')?.disabled===false`, 'canvas');
  await click('[aria-label="文档状态"]');
  assert.match(await page.evaluate(`document.querySelector('[data-workspace-status="canvas"]').textContent`), /尚未保存/);
  await escape();
  await click('[data-mode="reader"]');
  assert.equal(await readFile(fixture,'utf8'),content);
  assert.equal((await stat(fixture)).mtimeMs,before.mtimeMs);
  for(const suffix of ['.annotations.yaml','.mermarkd.json']) assert.equal(await stat(fixture+suffix).then(()=>true,()=>false),false);
  await click('[data-mode="editor"]');
  await page.evaluate(`(() => { const e=document.querySelector('[data-editor-textarea]'); e.focus(); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(e,e.value+'\\n新增内容'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(`document.querySelector('[data-dirty]')?.dataset.dirty==='true'`, 'dirty');
  await click('[data-mode="reader"]');
  assert.match(await page.evaluate(`document.querySelector('[data-workspace-summary]').textContent`), /未保存/);
  await click('[data-workspace-save]');
  await wait(`document.querySelector('[data-dirty]')?.dataset.dirty==='false'`, 'saved from reader');
  assert.match(await readFile(fixture,'utf8'),/新增内容/);
  await page.evaluate(`(() => { const e=document.querySelector('p[data-reader-editable]'); e.focus(); e.textContent += '补充'; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(`document.querySelector('[data-workspace-save]')?.disabled===false`, 'inline draft enables save');
  await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 });
  await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'s', code:'KeyS', windowsVirtualKeyCode:83, modifiers:2 });
  await wait(`document.querySelector('[data-dirty]')?.dataset.dirty==='false' && document.querySelector('[data-workspace-save]')?.disabled===true`, 'inline shortcut saved');
  assert.match(await readFile(fixture,'utf8'),/正文。补充/);
  await page.evaluate(`(() => { const e=document.querySelector('p[data-reader-editable]'); e.focus(); e.textContent += '继续'; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await wait(`document.querySelector('[data-workspace-save]')?.disabled===false`, 'inline save button');
  await click('[data-workspace-save]');
  await wait(`document.querySelector('[data-dirty]')?.dataset.dirty==='false'`, 'inline button saved');
  assert.match(await readFile(fixture,'utf8'),/正文。补充继续/);
  // A failing canvas write must be reflected in the shared status, even with a clean source.
  await click('[data-mode="cards"]');
  await wait(`document.querySelector('[data-canvas-save]')?.disabled===false`, 'canvas reload');
  await writeFile(fixture+'.mermarkd.json','external conflict\n');
  await click('[data-canvas-save]');
  await wait(`document.querySelector('.workspace-document-status')?.classList.contains('error')`, 'canvas failure reaches shell');
  assert.equal(await readFile(fixture+'.mermarkd.json','utf8'),'external conflict\n');
  await screenshot('canvas-conflict');
  console.log(JSON.stringify({status:'passed', widths:[1200,800,420], selectionCapabilities:true, singleSave:true, hiddenStructure:true, passiveNoWrites:true, saveFromReader:true, canvasConflict:true}));
} catch (error) {
  if (page) await screenshot('failure');
  throw error;
} finally {
  clients.forEach((client)=>client.close());
  try { execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}); } catch {}
  assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(workspace,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
