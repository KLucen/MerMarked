import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf3c-input-'));
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
  await writeFile(path.join(qa, `perf3c-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const editorValue = 'document.querySelector("[data-editor-textarea]").value';
const lf = content.replaceAll('\r\n', '\n');
async function assertValue(value) { assert.equal(await page.evaluate(editorValue), value); }
async function prepend(text) {
  await page.evaluate('(()=>{const e=document.querySelector("[data-editor-textarea]");e.focus();e.setSelectionRange(0,0)})()');
  await page.send('Input.insertText',{text}); await frame();
}
async function historyKey(redo = false) {
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,redo ? 10 : 2); await frame();
}
async function mainWait(expression, label) {
  for(let i=0;i<200;i++) { if(await main.evaluate(expression)) return; await new Promise(resolve=>setTimeout(resolve,50)); }
  throw Error(label);
}

try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  if(process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await page.send('Page.bringToFront'); await metrics(1200,800);
  await main.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain;
    globalThis.__inputQA={events:[],hold:false,reject:false,drafts:0,saves:0};
    for(const [channel,kind]of [['markdown-editor:update','update'],['markdown-editor:persist-draft','draft'],['markdown-editor:save','save']]){
      const original=ipc._invokeHandlers.get(channel);ipc.removeHandler(channel);
      ipc.handle(channel,async(...args)=>{const q=globalThis.__inputQA;const input=args[1];
        if(kind==='update'&&q.reject){q.reject=false;throw Error('QA rejected update');}
        q.events.push({kind,revision:input.revision,content:input.content});
        const result=await original(...args);
        if(kind==='update'&&q.hold){q.hold=false;await new Promise(resolve=>{q.release=()=>{q.release=null;resolve();};});}
        if(kind==='draft')q.drafts++;if(kind==='save')q.saves++;return result;});}
    process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(fixture)}]});})()`);
  const before=await snapshot();
  await click('[data-start-open]');
  await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"','reading');
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]")?.getClientRects().length)','source');
  await assertValue(lf);

  // Acknowledgement of revision 1 arrives after the UI has already entered 2.
  await main.evaluate('globalThis.__inputQA.hold=true');
  await prepend('前🙂\n'); await mainWait('Boolean(globalThis.__inputQA.release)','held update');
  await prepend('后😀\n');
  await assertValue('后😀\n前🙂\n'+lf);
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.dirty'),'true');
  assert.equal(await main.evaluate('globalThis.__inputQA.events.filter(e=>e.kind==="update").length'),1,'one ordered IPC in flight');
  assert.deepEqual(await snapshot(),before,'optimistic inputs do not write document files');
  await main.evaluate('globalThis.__inputQA.release()');
  await mainWait('globalThis.__inputQA.events.filter(e=>e.kind==="update").length===2','second revision accepted');
  await frame(); await assertValue('后😀\n前🙂\n'+lf);
  assert.deepEqual(await main.evaluate('globalThis.__inputQA.events.filter(e=>e.kind==="update").map(e=>e.revision)'),[1,2]);
  await mainWait('globalThis.__inputQA.drafts>0','real draft confirmation'); await frame();
  await click('[data-mode="reader"]');
  await wait('document.querySelector(".markdown-body")?.textContent.includes("后😀")','dirty preview');
  await click('[data-mode="editor"]'); await assertValue('后😀\n前🙂\n'+lf);
  await historyKey(); await assertValue('前🙂\n'+lf);
  await historyKey(); await assertValue(lf);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo clean');
  await historyKey(true); await assertValue('前🙂\n'+lf);
  await historyKey(true); await assertValue('后😀\n前🙂\n'+lf);
  await historyKey(); await historyKey(); await assertValue(lf);
  assert.deepEqual(await snapshot(),before,'confirmations, modes and undo/redo preserve all three files');

  // A rejected source update restores the confirmed source and resets history.
  await main.evaluate('globalThis.__inputQA.reject=true');
  await prepend('Rejected\n');
  await wait(editorValue+'==='+JSON.stringify(lf),'rejection restores confirmed source');
  await historyKey(); await assertValue(lf);

  // Explicit save waits for the entire queue, including input newer than the held reply.
  await main.evaluate('globalThis.__inputQA.hold=true;globalThis.__inputQA.events=[]');
  await prepend('保存🙂\n'); await mainWait('Boolean(globalThis.__inputQA.release)','held save input');
  await prepend('末次😀\n');
  const expected='末次😀\n保存🙂\n'+lf;
  await key('s','KeyS',83,2); await frame();
  assert.equal(await main.evaluate('globalThis.__inputQA.saves'),0,'save waits for update queue');
  assert.deepEqual(await snapshot(),before,'waiting save has not touched content files');
  await main.evaluate('globalThis.__inputQA.release()');
  await mainWait('globalThis.__inputQA.saves===1','queued save completed');
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','saved clean');
  await assertValue(expected);
  const savedBytes=Buffer.concat([Buffer.from([239,187,191]),Buffer.from(expected.replaceAll('\n','\r\n'))]);
  assert.deepEqual(await readFile(fixture),savedBytes,'save preserves exact BOM/CRLF/emoji source');
  const mutations=await main.evaluate('globalThis.__inputQA.events.filter(e=>e.kind!=="draft").map(e=>({kind:e.kind,revision:e.revision}))');
  assert.deepEqual(mutations.map(e=>e.kind),['update','update','save']);
  assert.equal(mutations[1].revision,mutations[0].revision+1);
  assert.equal(mutations[2].revision,mutations[1].revision);
  const saved=await snapshot();
  await historyKey(); await assertValue('保存🙂\n'+lf);
  await historyKey(true); await assertValue(expected);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','redo saved baseline');
  assert.deepEqual(await snapshot(),saved,'saved-baseline history does not write files');
  await metrics(420,360); await screenshot('input-ready');
  console.log('PERF3C passed: exact LF session, delayed acknowledgements, ordered revisions/save, real draft confirmation, rejection recovery, mode continuity, BOM/CRLF/emoji and three-file boundaries.');
} catch(error) {
  if(page) {try {await screenshot('input-failure');}catch{}}
  throw error;
} finally {
  for(const client of clients)client.close();
  if(child.exitCode===null){try{execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{}}
}
