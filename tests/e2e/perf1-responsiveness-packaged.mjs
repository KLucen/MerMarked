import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf1-'));
const fixture = path.join(workspace, '阅读与整理.md');
const targetBytes = Number(process.env.MERMARKD_PERF_MIB ?? 1) * 1024 * 1024;
const headingCount = Math.round(targetBytes / (5 * 1024));
const paragraph = '正文 English 😀 ' + 'plain content '.repeat(Math.ceil(targetBytes / headingCount / 14));
const content = Array.from({length:headingCount},(_,i)=>'# Heading '+i+'\r\n\r\n'+paragraph+'\r\n\r\n').join('')+'unique-perf-search-token\r\n';
const bytes = Buffer.concat([Buffer.from([239,187,191]), Buffer.from(content)]);
const hash = createHash('sha256').update(bytes).digest('hex');
let nextId = 0;
const canvas = (await reconcileCanvasState(null, {bytes, content, sha256:hash}, ()=>'card-'+nextId++)).model;
await writeFile(fixture, bytes);
await writeFile(fixture+'.mermarkd.json', serializeCanvasJson(canvas));
await writeFile(fixture+'.annotations.yaml', 'schemaVersion: 1\nsource:\n  sha256: "'+hash+'"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n');
const qa = path.join(root, 'out/qa'); await mkdir(qa, {recursive:true});
const port = 16000+Math.floor(Math.random()*100);
const child=spawn(process.env.MERMARKD_QA_EXE ?? path.join(root,'out/MerMarkd-win32-x64/MerMarkd.exe'),[
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
  for (let index = 0; index < 1000; index++) {
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

const measurements=[];
async function measure(name, action, condition) {
  await page.evaluate(`window.__frameGaps=[]; window.__lastFrame=performance.now();`);
  const started=performance.now();
  await action();
  if(condition) await wait(condition,name);
  await frame();
  const elapsedMs=Math.round(performance.now()-started);
  measurements.push({name,elapsedMs,maxFrameGapMs:await page.evaluate('Math.round(Math.max(0,...window.__frameGaps))')});
  const heap=await page.send('Runtime.getHeapUsage');
  measurements.at(-1).usedHeapMiB=Math.round(heap.usedSize/1024/1024);
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await page.send('Page.bringToFront'); await metrics(1200,800);
  await page.evaluate(`window.__frameGaps=[]; window.__lastFrame=performance.now();
    function tick(time){window.__frameGaps.push(time-window.__lastFrame);window.__lastFrame=time;requestAnimationFrame(tick)}requestAnimationFrame(tick)`);
  await page.evaluate(`window.__readingTrace={};window.__longTasks=[];
    new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);if(String(args[0]).includes('reading-analysis.worker')){
        this.addEventListener('message',event=>{if(event.data.result){window.__readingTrace.reply=performance.now();window.__readingTrace.analysisMs=event.data.analysisMs;}});}}
    };
    const observer=new MutationObserver(()=>{const state=document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis;
      if(state==='pending'&&!window.__readingTrace.loading)window.__readingTrace.loading=performance.now();
      if((state==='ready'||document.querySelector('.markdown-body h1'))&&!window.__readingTrace.ready){window.__readingTrace.ready=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__readingTrace.painted=performance.now();}));observer.disconnect();}});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-reading-analysis']});`);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await page.evaluate('window.__readingTrace.started=performance.now()');
  await measure('open-reader',()=>click('[data-start-open]'),'document.querySelectorAll(".markdown-body h1").length==='+headingCount);
  const readingTrace=await page.evaluate(`(()=>{const t=window.__readingTrace;return {
    loadingFeedbackMs:t.loading?Math.round(t.loading-t.started):null,
    firstDOMMs:t.ready?Math.round(t.ready-t.started):null,
    firstPaintMs:t.painted?Math.round(t.painted-t.started):null,
    analysisMs:t.analysisMs===undefined?null:Math.round(t.analysisMs),
    responseToDOMMs:t.ready&&t.reply?Math.round(t.ready-t.reply):null,
    responseToPaintMs:t.painted&&t.reply?Math.round(t.painted-t.reply):null,
    longTasks:window.__longTasks.filter(e=>e.start>=t.started).map(e=>Math.round(e.duration))};})()`);
  await wait('document.querySelectorAll(".toc-link").length==='+headingCount,'outline');
  await measure('open-find',()=>click('[aria-label="查找正文"]'),'Boolean(document.querySelector("#reader-search-input"))');
  await page.evaluate('document.querySelector("#reader-search-input").focus()');
  await measure('reader-find',()=>page.send('Input.insertText',{text:'unique-perf-search-token'}),'Boolean(document.querySelector("[data-search-current]"))');
  await click('[aria-label="关闭正文查找"]');
  await measure('switch-source',()=>click('[data-mode="editor"]'),'Boolean(document.querySelector("[data-editor-textarea]")?.getClientRects().length)');
  await frame();
  await page.evaluate('(()=>{const e=document.querySelector("[data-editor-textarea]");e.focus();e.setSelectionRange(0,0)})()');
  await measure('source-input-next-frame',()=>page.send('Input.insertText',{text:'prefix\n\n'}),'document.querySelector(".app-shell").dataset.dirty==="true"');
  await wait('document.querySelectorAll(".toc-link").length==='+headingCount,'updated outline');
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo clean');
  assert.deepEqual(await snapshot(),before,'profiling and buffer undo do not write content files');
  const result={label:process.env.MERMARKD_PERF_LABEL??'current',sourceBytes:bytes.length,headings:headingCount,readingTrace,measurements};
  await writeFile(path.join(qa,'perf1-'+result.label+'.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  if(page) {try {await screenshot('failure');} catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
