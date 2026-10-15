import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf1-outline-'));
const fixture = path.join(workspace, '阅读与整理.md');
const content = '# 阅读与整理\r\n\r\n中文、English 与 emoji 😀；**重点内容**和[链接](https://example.com)。\r\n\r\n## 清单\r\n\r\n- [x] 保留原文\r\n- [ ] 核对文件边界\r\n\r\n## 表格\r\n\r\n| 项目 | 数据 |\r\n| :--- | ---: |\r\n| 长文字与全角标点，保持语义排版。 | 123.45 |\r\n\r\n### 代码\r\n\r\n```ts\r\nconst message = "中文 content";\r\n```\r\n';
const bytes = Buffer.concat([Buffer.from([239,187,191]), Buffer.from(content)]);
const hash = createHash('sha256').update(bytes).digest('hex');
let nextId = 0;
const canvas = (await reconcileCanvasState(null, {bytes, content, sha256:hash}, ()=>'card-'+nextId++)).model;
await writeFile(fixture, bytes);
await writeFile(fixture+'.mermarkd.json', serializeCanvasJson(canvas));
await writeFile(fixture+'.annotations.yaml', 'schemaVersion: 1\nsource:\n  sha256: "'+hash+'"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n');
const qa = path.join(root, 'out/qa'); await mkdir(qa, {recursive:true});
const port = 16000+Math.floor(Math.random()*100);
const child=spawn(path.join(root,'out/MerMarkd-win32-x64/MerMarkd.exe'),[
  '--inspect='+(port+200),'--remote-debugging-port='+port,'--user-data-dir='+path.join(workspace,'user-data')
],{cwd:root,stdio:'ignore',windowsHide:true});
const clients=[];
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
  const text = !modifiers ? key === 'Enter' ? '\r' : key.length === 1 ? key : undefined : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function click(selector) {
  await frame();
  const point = await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(point, `visible enabled ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await frame();
}
async function details(selector, open = true) {
  if (await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).open`) !== open) await click(selector + ' > summary');
}
async function visible(selector) { return page.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length)`); }
async function screenshot(name) {
  const result = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `perf1-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const outlineReady = 'document.querySelector("[data-outline-status]")?.dataset.outlineStatus==="ready"';
async function prepend(text) {
  await frame();
  await page.evaluate('(()=>{const e=document.querySelector("[data-editor-textarea]");e.focus();e.setSelectionRange(0,0)})()');
  await page.send('Input.insertText',{text});
  await frame();
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await page.send('Page.bringToFront'); await metrics(1200,800);
  // Delay real worker replies, including ones already queued before termination.
  await page.evaluate(`window.__workers=[];window.__replies=[];window.__holdOutline=false;window.__failOutline=false;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){const outline=String(args[0]).includes('source-outline.worker');if(outline&&window.__failOutline)throw Error('QA worker startup failure');super(...args);if(outline)window.__workers.push(this);
        this.addEventListener('error',event=>window.__workerError={message:event.message,filename:event.filename,lineno:event.lineno});
        this.addEventListener('message',event=>{if(outline&&window.__holdOutline){event.stopImmediatePropagation();window.__replies.push(()=>this.onmessage?.(event));}});}
      terminate(){this.wasTerminated=true;super.terminate();}
    };`);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[data-start-open]');
  await wait(outlineReady,'packaged worker outline');
  assert.equal(await page.evaluate('document.querySelectorAll(".toc-link").length'),4);
  assert.equal(await page.evaluate('window.__workers.length'),0,'reuse the existing reading parse on initial load');
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]")?.getClientRects().length)','source');
  await page.evaluate('window.__holdOutline=true');
  await prepend('# Added\n\n');
  await wait('window.__replies.length===1','first held parse');
  assert.ok(await page.evaluate('window.__workers.length>0'),'dirty source parses in a real worker');
  assert.equal(await page.evaluate('document.querySelector("[data-outline-status]").dataset.outlineStatus'),'pending');
  assert.equal(await page.evaluate('document.querySelectorAll(".toc-link,[data-editor-structure-toggle]").length'),0,'pending offsets and structural commands are unavailable');
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").readOnly'),false,'source input stays available');
  await prepend('# Latest\n\n');
  await wait('window.__replies.length===2','newer held parse');
  await page.evaluate('window.__replies.shift()()'); await frame();
  assert.equal(await page.evaluate('document.querySelector("[data-outline-status]").dataset.outlineStatus'),'pending','late old reply cannot publish');
  await page.evaluate('window.__replies.shift()()');
  await wait(outlineReady,'latest parse');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".toc-link")].slice(0,2).map(e=>e.textContent)'),['Latest','Added']);
  await wait('document.querySelector(".toc-link.active")?.textContent==="Added"','worker completion restores the current cursor section');
  await click('.toc-link[data-editor-section="1"]');
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").selectionStart'),10,'jump uses latest buffer offsets');
  await page.evaluate('window.__holdOutline=false;document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2); await frame(); await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo clean');
  await wait(outlineReady,'clean outline');
  assert.deepEqual(await snapshot(),before,'cancellation and undo do not write the three content files');

  await page.evaluate('window.__failOutline=true');
  await prepend('# Recoverable\n\n');
  await wait('document.querySelector("[data-outline-status]")?.dataset.outlineStatus==="error"','worker startup failure');
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").readOnly'),false);
  assert.equal(await page.evaluate('document.querySelectorAll(".toc-link").length'),0);
  await screenshot('outline-error');
  await page.evaluate('window.__failOutline=false');
  await click('[data-outline-status] button');
  await wait(outlineReady,'retry');
  assert.equal(await page.evaluate('document.querySelector(".toc-link").textContent'),'Recoverable');
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','retry undo clean');
  await wait(outlineReady,'retry clean outline');
  await click('[data-mode="reader"]');
  await wait('Boolean(document.querySelector(".markdown-body strong"))','semantic reader');
  await page.evaluate('window.__paragraph=document.querySelector(".markdown-body p");void 0');
  await click('[aria-label="查找正文"]');
  await page.send('Input.insertText',{text:'重点内容'});
  await wait('document.querySelector("#reader-searchbar output")?.textContent==="1 / 1"','find result');
  assert.equal(await page.evaluate('window.__paragraph===document.querySelector(".markdown-body p")'),true,'search keeps reading DOM and selection nodes');
  await click('[aria-label="关闭正文查找"]');
  assert.deepEqual(await snapshot(),before,'failure, retry, find and switching modes preserve all content files');

  await main.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain;
    const original=ipc._invokeHandlers.get('markdown-editor:persist-draft');globalThis.__draftConfirmed=false;
    ipc.removeHandler('markdown-editor:persist-draft');ipc.handle('markdown-editor:persist-draft',async(...args)=>{
      const result=await original(...args);globalThis.__draftConfirmed=true;return result;});})()`);
  await click('[data-mode="editor"]');
  await prepend('# Cached\n\n');
  await click('[data-mode="reader"]');
  await wait('document.querySelector(".markdown-body h1")?.textContent==="Cached"','dirty reading snapshot');
  await page.evaluate('window.__dirtyParagraph=document.querySelector(".markdown-body p");void 0');
  for(let attempt=0;attempt<60 && !await main.evaluate('globalThis.__draftConfirmed');attempt++) await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await main.evaluate('globalThis.__draftConfirmed'),true,'real draft checkpoint completed');
  await frame();
  assert.equal(await page.evaluate('window.__dirtyParagraph===document.querySelector(".markdown-body p")'),true,'same-content IPC checkpoint keeps reading DOM');
  await click('[data-mode="editor"]'); await frame();
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','checkpoint undo clean');
  assert.deepEqual(await snapshot(),before,'draft checkpoint and undo leave document files untouched');
  await click('[data-mode="reader"]');

  const second=path.join(workspace,'second.md');const third=path.join(workspace,'third.md');
  await writeFile(second,'# Old document\n\nOlder content.\n');
  await writeFile(third,'# New document\n\nCurrent content.\n');
  await page.evaluate('window.__holdOutline=true');
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(second)+']})');
  await click('[aria-label="打开文档"]');
  await wait('document.querySelector(".toc-link")?.textContent==="Old document"','second document');
  await click('[data-mode="editor"]');
  await prepend('# Old candidate\n\n');
  await wait('window.__replies.length===1','held old document parse');
  await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','old document clean');
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(third)+']})');
  await click('[aria-label="打开文档"]');
  await wait('document.querySelector(".toc-link")?.textContent==="New document"','new document');
  await page.evaluate('window.__replies.shift()()'); await frame();
  await wait(outlineReady,'new document outline');
  assert.equal(await page.evaluate('document.querySelector(".toc-link").textContent'),'New document','old document reply is ignored');
  for(const next of [second,third]) for(const suffix of ['.annotations.yaml','.mermarkd.json']) {
    await assert.rejects(stat(next+suffix),{code:'ENOENT'});
  }
  await screenshot('outline-ready');
  console.log('PERF1 packaged E2E passed: native worker, cancellation, stale replies, current offsets, failure/retry, document switching, semantic reading and three-file zero writes.');
} catch(error) {
  if(page) console.log('worker diagnostic',await page.evaluate('window.__workerError'));
  if(page) {try {await screenshot('failure');} catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
