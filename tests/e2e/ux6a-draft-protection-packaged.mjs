import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux6a-'));
const fixture = path.join(workspace, '工作笔记.md');
const content = '# 阅读笔记\r\n\r\n已有批注对应的原文。\r\n\r\n准备修改的句子。\r\n\r\n重复引文。\r\n\r\n重复引文。\r\n\r\n跨**强调**和[链接](https://example.com)的内容。\r\n\r\n```text\r\n代码中的原文\r\n```\r\n';
await writeFile(fixture, '\ufeff' + content);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const port = 15200 + Math.floor(Math.random() * 100);
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
  await writeFile(path.join(qa, `ux6a-${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function select(selector) {
  await page.send('Page.bringToFront');
  await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`, 'reading selection target ready');
  await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
  await wait(`Boolean(document.querySelector('[data-selection-capability]')) && document.querySelector('.selection-quote')?.title===document.querySelector(${JSON.stringify(selector)}).textContent`, 'selection capability');
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function snapshot() {
  return Promise.all([fixture, fixture+'.annotations.yaml', fixture+'.mermarkd.json'].map(async file => {
    try { return { content: await readFile(file,'utf8'), mtime: (await stat(file)).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
}
async function dirty(value) {
  await wait(`document.querySelector('.app-shell').dataset.dirty===${JSON.stringify(String(value))}`, 'dirty=' + value);
}
async function compose(selector, text) {
  await select(selector); await click('.add-note-button');
  await wait('Boolean(document.querySelector("#new-note-body")) && !document.querySelector("#new-note-body").disabled', 'composer ready');
  if (text) { await click('#new-note-body'); await page.send('Input.insertText',{text}); }
}
async function saveNote(count) {
  await wait('!document.querySelector(".note-composer button[type=submit]").disabled', 'annotation write ready');
  await click('.note-composer button[type=submit]');
  await wait(`!document.querySelector('#new-note-body') && document.querySelectorAll('.note-card').length===${count}`, 'note saved');
}
let main;
async function unlocked() { await wait('document.querySelector(".app-shell").dataset.leavePending==="false"','leave guard released'); }
async function choice(response) { await main.evaluate(`globalThis.__leaveChoice=${response}`); }
async function openTarget(file, canceled = false) {
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:'+canceled+',filePaths:['+JSON.stringify(file)+']})');
}
async function promptCount() { return main.evaluate('globalThis.__leavePrompts.length'); }
async function openButton() { await click('.topbar button[aria-label="打开文档"]'); await unlocked(); }
async function closeAttempt() {
  await main.evaluate('void process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].close()');
  await new Promise(resolve=>setTimeout(resolve,250));
  await unlocked();
  assert.equal(await main.evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows().length'),1);
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await main.evaluate(`globalThis.__leaveChoice=2; globalThis.__leavePrompts=[];
    process.mainModule.require('electron').dialog.showMessageBox=async(_window,options)=>{
      globalThis.__leavePrompts.push({title:options.title,detail:options.detail,buttons:options.buttons});
      return {response:options.title==='还有未提交的输入'?globalThis.__leaveChoice:2};
    }`);
  await openTarget(fixture); await metrics(1200,800); await click('[data-start-open]');
  await wait('Boolean(document.querySelector("p[data-reader-editable]"))','reader'); await unlocked();
  const original=await snapshot();
  const second=path.join(workspace,'second.md'); await writeFile(second,'# Second document\n\nAnother paragraph.\n');
  await compose('.markdown-body p','必须保留的批注草稿');
  await page.evaluate(`(()=>{const e=document.querySelector('#new-note-tag');e.value='__new__';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await wait('Boolean(document.querySelector("#new-note-tag-name"))','tag name');
  await click('#new-note-tag-name'); await page.send('Input.insertText',{text:'计划'});
  await wait('document.querySelector("[data-workspace-summary]").textContent.includes("未提交批注")','unsaved form status');
  await screenshot('pending-note');
  await openTarget(second);
  await choice(2); await openButton();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'必须保留的批注草稿');
  assert.equal(await page.evaluate('document.querySelector("#new-note-tag-name").value'),'计划');
  assert.deepEqual(await snapshot(),original);
  await choice(0); await openButton();
  await wait('document.activeElement?.id==="new-note-body"','return focuses draft');
  await choice(1); await openTarget(second,true); await openButton();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'必须保留的批注草稿','picker cancellation retains draft');
  await openTarget(path.join(workspace,'missing.md')); await openButton();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'必须保留的批注草稿','open failure retains draft');
  await choice(2); await closeAttempt();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'必须保留的批注草稿','closing cancelled');
  // Forged or stale close replies never authorize a future close.
  await page.evaluate('window.mermarkd.replyToCloseRequest("stale-request",true)');
  await closeAttempt();
  assert.deepEqual(await snapshot(),original);
  await choice(1); await openTarget(second); await openButton();
  await wait('document.querySelector(".markdown-body h1")?.textContent==="Second document"','discard and open second');
  assert.equal(await page.evaluate('Boolean(document.querySelector("#new-note-body"))'),false);
  await openTarget(fixture); await openButton();
  await compose('.markdown-body p','已保存的便签'); await saveNote(1);
  const saved=await snapshot();
  await page.evaluate(`[...document.querySelectorAll('.note-card button')].find(e=>e.textContent==='编辑').click()`);
  await wait('Boolean(document.querySelector(".note-edit-form textarea"))','editing saved note');
  await click('.note-edit-form textarea'); await page.send('Input.insertText',{text:'仍未提交的修改'});
  const edited=await page.evaluate('document.querySelector(".note-edit-form textarea").value');
  await click('[data-mode="editor"]'); await click('[data-mode="cards"]'); await click('[data-mode="reader"]');
  await wait('Boolean(document.querySelector(".note-edit-form textarea"))','edit form survives modes');
  assert.equal(await page.evaluate('document.querySelector(".note-edit-form textarea").value'),edited);
  await choice(2); await openTarget(second); await openButton();
  assert.equal(await page.evaluate('document.querySelector(".note-edit-form textarea").value'),edited);
  // Replacing an edit form with a new annotation must not silently clear it.
  await select('.markdown-body p'); await click('.add-note-button');
  assert.equal(await page.evaluate('document.querySelector(".note-edit-form textarea").value'),edited);
  // A real pending IPC write blocks close; rejection retains the editable form.
  await main.evaluate(`globalThis.__originalUpdate=process.mainModule.require('electron').ipcMain._invokeHandlers.get('annotations:update-note');
    process.mainModule.require('electron').ipcMain._invokeHandlers.set('annotations:update-note',()=>new Promise((_resolve,reject)=>{globalThis.__rejectUpdate=reject}))`);
  await click('.note-edit-form button[type="submit"]');
  await wait('document.querySelector(".note-edit-form button[type=submit]").disabled','write pending');
  const count=await promptCount(); await closeAttempt(); assert.equal(await promptCount(),count,'no discard while saving');
  await main.evaluate('globalThis.__rejectUpdate(new Error("simulated write failure")); void 0');
  await wait('!document.querySelector(".note-edit-form button[type=submit]").disabled','failed write releases form');
  assert.equal(await page.evaluate('document.querySelector(".note-edit-form textarea").value'),edited);
  assert.deepEqual(await snapshot(),saved,'failed write does not alter three files');
  await main.evaluate(`process.mainModule.require('electron').ipcMain._invokeHandlers.set('annotations:update-note',globalThis.__originalUpdate)`);
  await choice(0); await closeAttempt();
  await wait('document.activeElement?.matches(".note-edit-form textarea")','close return focuses edited note');
  await page.evaluate(`document.querySelector('.note-edit-form button[type=button]').click()`);
  await select('.markdown-body p');
  await page.evaluate(`(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify('未应用的第一行\n第二行')});document.querySelector('.markdown-body p').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()`);
  await wait('Boolean(document.querySelector(".reader-edit-feedback textarea"))','unapplied input retained');
  await choice(2); await openButton();
  assert.equal(await page.evaluate('document.querySelector(".reader-edit-feedback textarea").value'),'未应用的第一行\n第二行');
  assert.ok((await main.evaluate('globalThis.__leavePrompts.at(-1).detail')).includes('尚未应用的输入'));
  await page.evaluate(`document.querySelector('[aria-label="关闭阅读编辑提示"]').click()`);
  // Composition is not ended by an inert overlay, native dialog, mode switch or close.
  await page.evaluate(`(()=>{const p=document.querySelector('.markdown-body p');p.focus();p.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'}))})()`);
  const compositionPrompts=await promptCount();
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'o',code:'KeyO',windowsVirtualKeyCode:79,modifiers:2});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'o',code:'KeyO',windowsVirtualKeyCode:79,modifiers:2});
  await closeAttempt(); assert.equal(await promptCount(),compositionPrompts);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body h1").textContent'),'阅读笔记');
  await page.evaluate(`document.querySelector('.markdown-body p').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'}))`);
  assert.deepEqual(await snapshot(),saved,'cancelled operations and composition guards are zero-write');
  await compose('.markdown-body p','换文件和关闭都需要保留');
  const dropCount=await promptCount();
  const dropPoint=await page.evaluate(`(()=>{window.scrollTo(0,0);const r=document.querySelector('[data-markdown-drop-target]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const dropData={items:[],files:[second],dragOperationsMask:1};
  for(const type of ['dragEnter','dragOver','drop']) await page.send('Input.dispatchDragEvent',{type,...dropPoint,data:dropData});
  await unlocked();
  assert.equal(await promptCount(),dropCount+1,'native file drop is guarded');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'换文件和关闭都需要保留');
  // Recent-file navigation uses the same guard as the open picker.
  const recentCount=await promptCount();
  await page.evaluate(`[...document.querySelectorAll('.recent-document-list button')].find(e=>e.title===${JSON.stringify(second)}).click()`);
  await unlocked();
  assert.equal(await promptCount(),recentCount+1);
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'换文件和关闭都需要保留');
  // All input fields participate in composition protection, including note forms.
  await page.evaluate(`document.querySelector('#new-note-body').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'文'}))`);
  const noteCompositionCount=await promptCount(); await closeAttempt();
  assert.equal(await promptCount(),noteCompositionCount);
  await page.evaluate(`document.querySelector('#new-note-body').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'文'}))`);
  await click('[data-mode="editor"]');
  await page.evaluate(`(()=>{const e=document.querySelector('[data-editor-textarea]');e.focus();e.setSelectionRange(0,0)})()`);
  await page.send('Input.insertText',{text:'未保存正文\n\n'}); await dirty(true);
  // Discarding local forms is only a permission: cancelling the subsequent source
  // save dialog must keep those forms intact.
  await choice(1); await closeAttempt();
  assert.equal(await main.evaluate('globalThis.__leavePrompts.at(-1).title'),'Markdown 尚未保存');
  await page.evaluate(`document.querySelector('[data-editor-textarea]').focus()`);
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:2});
  await dirty(false); await click('[data-mode="reader"]');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'换文件和关闭都需要保留');
  assert.deepEqual(await snapshot(),saved);
  // A real external source change exposes the reload entry point.
  await writeFile(fixture,'\ufeff'+content+'\r\n外部增加的内容。\r\n');
  const external=await snapshot();
  await click('[aria-label="文档状态"]');
  await page.evaluate(`[...document.querySelectorAll('.annotation-summary button')].find(e=>e.textContent==='重新检查').click()`);
  await wait('Boolean(document.querySelector(".source-change-notice button"))','external reload available');
  await choice(2); await click('.source-change-notice button'); await unlocked();
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'换文件和关闭都需要保留');
  assert.deepEqual(await snapshot(),external);
  await choice(1); await click('.source-change-notice button'); await unlocked();
  await wait('document.querySelector(".markdown-body")?.textContent.includes("外部增加的内容")','reload accepted');
  assert.equal(await page.evaluate('Boolean(document.querySelector("#new-note-body"))'),false);
  assert.deepEqual(await snapshot(),external,'reload discards form only and never writes source or sidecars');
  await openTarget(second); await openButton();
  await wait('document.querySelector(".markdown-body h1")?.textContent==="Second document"','clean document for final close');
  await compose('.markdown-body p','最后一次关闭确认');
  await choice(1);
  const closedMarker=path.join(workspace,'window-closed.txt');
  await main.evaluate('void process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].once("closed",()=>process.mainModule.require("node:fs").writeFileSync('+JSON.stringify(closedMarker)+',"closed"))');
  await main.evaluate('void process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].close()');
  let closed=false;
  for(let i=0;i<100&&!closed;i++) {
    await new Promise(resolve=>setTimeout(resolve,50));
    closed=await stat(closedMarker).then(()=>true,()=>false);
  }
  assert.equal(closed,true,'confirmed close destroys the window');
  // Node's inspector keeps the process alive until its debugging clients disconnect.
  for(const client of clients) client.close();
  for(let i=0;i<100&&child.exitCode===null;i++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.notEqual(child.exitCode,null,'confirmed close actually exits');
  assert.deepEqual(await snapshot(),external,'closing does not turn local forms into sidecar writes');
  console.log('UX6A packaged E2E passed: pending status, cancel/return/discard, cancelled picker, failed open, preserved edit forms, native close, stale reply, pending/failed writes, unapplied input and composition guards.');
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
