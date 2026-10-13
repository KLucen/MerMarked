import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux2-'));
const fixture = path.join(workspace, '工作笔记.md');
const content = '# 工作笔记\n\n这是一段可以编辑和批注的正文。\n\n## 下一步\n\n整理资料，记录想法。\n\n包含**强调**的选区。\n\n| 项目 | 进度 |\n| --- | --- |\n| 设计检查 | 已完成 |\n';
await writeFile(fixture, content + Array.from({length: 35}, (_,i)=>'\n## 章节 ' + (i+1) + '\n\n这里是用于验证目录和正文独立滚动的内容。\n').join(''));
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
  await writeFile(path.join(qa, `ux2-${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function select(selector) {
  await page.send('Page.bringToFront');
  await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
  await wait(`Boolean(document.querySelector('[data-selection-capability]')) && document.querySelector('.selection-quote')?.title===document.querySelector(${JSON.stringify(selector)}).textContent`, 'selection capability');
}
async function escape() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function focusMode() {
  if (await page.evaluate(`document.querySelector('[aria-label="文档菜单"]').getAttribute('aria-expanded') !== 'true'`)) await click('[aria-label="文档菜单"]');
  await click('[aria-label$="专注模式"]');
  await escape();
}
async function focusShortcut() {
  await page.send('Input.dispatchKeyEvent', {type:'keyDown',key:'F',code:'KeyF',windowsVirtualKeyCode:70,modifiers:10});
  await page.send('Input.dispatchKeyEvent', {type:'keyUp',key:'F',code:'KeyF',windowsVirtualKeyCode:70,modifiers:10});
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(resolve))');
}
async function snapshot() {
  return Promise.all([fixture, fixture+'.annotations.yaml', fixture+'.mermarkd.json'].map(async file => {
    try { return { content: await readFile(file,'utf8'), mtime: (await stat(file)).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
}
async function visible(selector) { return page.evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+')?.getClientRects().length)'); }
async function assertLayout() {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'no page overflow');
  assert.equal(await page.evaluate('[...document.querySelectorAll(".topbar button")].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'),true,'all topbar controls fit');
}
try {
  page = await connect(port, 'page'); const main = await connect(port + 200, 'node');
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog = async () => ({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await metrics(1200,800); await click('[data-start-open]');
  await wait('Boolean(document.querySelector("p[data-reader-editable]")) && document.querySelectorAll(".toc-link").length > 30','reader ready');
  const untouched=await snapshot();
  assert.equal(await visible('#workspace-left-panel'),true);
  assert.equal(await visible('#workspace-right-panel'),false,'empty annotation panel starts closed');
  await click('[data-workspace-right-toggle]');
  assert.equal(await visible('#workspace-left-panel'),true,'wide panels may coexist');
  assert.equal(await visible('#annotation-sidebar'),true);
  assert.equal(await page.evaluate('document.querySelectorAll("[aria-modal=true]").length'),0,'wide sidebars are nonmodal');
  await page.evaluate('document.querySelector(".workspace-task-content").scrollTop=20;document.querySelector(".toc-inner").scrollTop=180');
  const tocScroll = await page.evaluate('document.querySelector(".toc-inner").scrollTop');
  await focusMode();
  assert.equal(await visible('#workspace-left-panel'),false);
  assert.equal(await visible('#workspace-right-panel'),false);
  await focusMode();
  assert.equal(await visible('#workspace-left-panel'),true);
  assert.equal(await visible('#workspace-right-panel'),true);
  assert.equal(await page.evaluate('document.querySelector(".toc-inner").scrollTop'),tocScroll);
  await click('[aria-label="关闭批注栏"]');
  for (const [width,height] of [[800,700],[420,800]]) {
    await metrics(width,height); await assertLayout();
    await click('.topbar > button');
    assert.equal(await page.evaluate('document.querySelectorAll("[role=dialog][aria-modal=true]").length'),1);
    assert.equal(await page.evaluate('document.querySelector(".workspace-content").inert'),true);
    await page.evaluate('document.querySelector("#workspace-left-panel .workspace-close-button").focus()');
    await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
    assert.equal(await page.evaluate('document.querySelector("#workspace-left-panel").contains(document.activeElement)'),true);
    await focusShortcut();
    assert.equal(await visible('#workspace-left-panel'),false,'shortcut hides an open drawer');
    assert.equal(await page.evaluate('document.activeElement?.matches(".markdown-body")'),true,'focus moves to the main task');
    await focusShortcut();
    assert.equal(await visible('#workspace-left-panel'),true,'shortcut restores the same drawer');
    assert.equal(await page.evaluate('document.querySelector("#workspace-left-panel").contains(document.activeElement)'),true);
    await screenshot('drawer-'+width);
    await escape();
    assert.equal(await page.evaluate('document.activeElement===document.querySelector(".topbar > button")'),true);
    await click('[data-workspace-right-toggle]');
    assert.equal(await visible('#workspace-left-panel'),false);
    await escape();
    assert.equal(await page.evaluate('document.activeElement?.matches("[data-workspace-right-toggle]")'),true);
  }
  await metrics(1200,800);
  await click('[data-mode="cards"]');
  await wait('Boolean(document.querySelector(".react-flow__node.draggable"))','canvas ready');
  const canvasBefore=await page.evaluate('document.querySelector(".canvas-flow").getBoundingClientRect().height');
  await metrics(1200,1000);
  await wait('document.querySelector(".canvas-flow").getBoundingClientRect().height > '+(canvasBefore+150),'canvas grows with window');
  assert.equal(await page.evaluate('document.documentElement.scrollHeight <= innerHeight+1'),true);
  assert.deepEqual(await snapshot(),untouched,'opening panels and all modes creates no sidecars');
  await metrics(1200,800);
  await click('[data-canvas-save]');
  await wait('document.querySelector("[data-canvas-status]").textContent.includes("已保存")','seed canvas');
  await click('[data-workspace-right-toggle]');
  await click('[data-canvas-link-composer] > summary');
  const input= '[data-canvas-link-label]';
  await click(input); await page.send('Input.insertText',{text:'暂存的关系标签'});
  await focusMode(); await focusMode();
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-link-label]").value'),'暂存的关系标签');
  if (!await visible('#workspace-left-panel')) await click('.topbar > button');
  await click('.toc-list li:nth-child(2) button');
  await page.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
  await screenshot('canvas-wide');
  await click('[data-mode="reader"]');
  await select('.markdown-body > p');
  await click('.selection-toolbar [aria-controls="annotation-sidebar"]');
  await wait('Boolean(document.querySelector("#new-note-body"))','note composer');
  await click('#new-note-body'); await page.send('Input.insertText',{text:'保留这个批注草稿'});
  await focusMode(); await focusMode();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'保留这个批注草稿');
  await metrics(420,800);
  await click('#new-note-body');
  await focusShortcut(); await focusShortcut();
  assert.equal(await page.evaluate('document.activeElement?.id'), 'new-note-body','return to the note draft');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'保留这个批注草稿');
  await metrics(1200,800);
  await click('.note-composer button[type="submit"]');
  await wait('!document.querySelector("#new-note-body") && document.querySelectorAll(".note-card").length===1','note saved');
  const seeded=await snapshot(); assert.ok(seeded[1]&&seeded[2]);
  await screenshot('reader-wide');
  await click('.toc-list li:nth-child(10) button');
  await page.evaluate('new Promise(resolve=>setTimeout(resolve,850))');
  const readerScroll = await page.evaluate('scrollY');
  const readerChapter = await page.evaluate('document.querySelector(".toc-link[aria-current]")?.textContent');
  await focusMode(); await focusMode();
  assert.ok(Math.abs(await page.evaluate('scrollY')-readerScroll)<2,'reader scroll survives focus');
  assert.equal(await page.evaluate('document.querySelector(".toc-link[aria-current]")?.textContent'), readerChapter);
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]"))','editor');
  if (!await visible('#workspace-left-panel')) await click('.topbar > button');
  await click('[data-editor-section="8"]');
  await wait('document.querySelector("[data-editor-textarea]").scrollTop > 0', 'source jump reveals caret');
  const selection=await page.evaluate('document.querySelector("[data-editor-textarea]").selectionStart');
  const sourceScroll=await page.evaluate('document.querySelector("[data-editor-textarea]").scrollTop');
  await focusShortcut(); await focusShortcut();
  assert.equal(await visible('[data-editor-search]'),false,'focus shortcut does not open source search');
  await focusMode(); await focusMode();
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").selectionStart'),selection);
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").scrollTop'),sourceScroll);
  await screenshot('source-wide');
  for (const [width,height] of [[1200,800],[800,700],[420,800]]) {
    await metrics(width,height);
    // Close any remembered narrow drawer before interacting with the workspace.
    if (await page.evaluate('Boolean(document.querySelector("[aria-modal=true]"))')) await escape();
    await assertLayout();
    await click('[data-mode="cards"]');
    await wait('Boolean(document.querySelector(".react-flow__node"))','canvas resize');
    assert.equal(await page.evaluate('document.documentElement.scrollHeight<=innerHeight+1'),true);
    await screenshot('canvas-'+width);
    await focusMode(); await focusMode();
    await click('[data-mode="reader"]');
    await focusMode(); await focusMode();
    await click('[data-mode="editor"]');
  }
  assert.deepEqual(await snapshot(),seeded,'panel, focus, resize and mode changes preserve three-file bytes and mtimes');
  await metrics(1200,800);
  await click('[data-editor-textarea]');
  await page.send('Input.insertText',{text:'验证历史'});
  await wait('document.querySelector(".app-shell").dataset.dirty==="true"','editor dirty');
  await focusMode(); await focusMode();
  await click('[data-editor-undo]');
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo survives focus');
  assert.deepEqual(await snapshot(),seeded,'unsaved edit and undo do not write document files');
  console.log('UX2 packaged E2E passed: shared panels, narrow focus, draft retention, viewport sizing and zero writes.');
} finally {
  for (const client of clients) client.close();
  if (child.exitCode === null) { try { execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); } catch {} }
}
