import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf2-reading-'));
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
  await writeFile(path.join(qa, `perf2-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const ready = 'document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"';
const pendingReading = 'document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="pending"';
async function openFile(file) {
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(file)+']})');
  await click('[aria-label="打开文档"]');
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await page.send('Page.bringToFront'); await metrics(1200,800);
  await page.evaluate(`window.__readingWorkers=[];window.__readingReplies=[];window.__holdReading=true;window.__failReading=false;
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){const reading=String(args[0]).includes('reading-analysis.worker');
        if(reading&&window.__failReading)throw Error('QA reading worker startup failure');super(...args);
        if(reading)window.__readingWorkers.push(this);
        this.addEventListener('error',event=>window.__workerError={message:event.message,filename:event.filename});
        this.addEventListener('message',event=>{if(reading&&window.__holdReading){event.stopImmediatePropagation();window.__readingReplies.push(()=>this.onmessage?.(event));}});}
      terminate(){this.wasTerminated=true;this.terminatedAt=performance.now();super.terminate();}
    };`);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[data-start-open]'); await wait(pendingReading,'loading state');
  await wait('window.__readingReplies.length===1','real analysis response held');
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body,.toc-link,[data-reader-editable]").length'),0,'pending exposes no stale content or offsets');
  await screenshot('reading-pending');
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]")?.getClientRects().length)','source during analysis');
  assert.equal(await page.evaluate('window.__readingWorkers[0].wasTerminated'),true,'leaving interrupts worker');
  await page.evaluate('window.__readingReplies.shift()()'); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector(".markdown-body"))'),false,'queued old reply does not leave source mode');
  await page.evaluate('window.__holdReading=false');
  await click('[data-mode="reader"]'); await wait(ready,'fresh reading analysis');
  assert.equal(await page.evaluate('document.querySelectorAll(".toc-link").length'),4);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body strong").textContent'),'重点内容');
  assert.equal(await page.evaluate('document.querySelector(".markdown-body table td").textContent'),'长文字与全角标点，保持语义排版。');
  const workers=await page.evaluate('window.__readingWorkers.length');
  await click('[data-mode="editor"]'); await click('[data-mode="reader"]'); await wait(ready,'reuse snapshot');
  assert.equal(await page.evaluate('window.__readingWorkers.length'),workers,'unchanged reading snapshot is cached');
  assert.deepEqual(await snapshot(),before,'loading, cancellation and mode changes do not write content');

  const second=path.join(workspace,'second.md'), third=path.join(workspace,'third.md');
  await writeFile(second,'# Older document\n\nRepeated quote.\n\n[[older wiki]]\n');
  await writeFile(third,'# Current document\n\nRepeated quote.\n\n<script>window.__unsafe=1</script>\n');
  await page.evaluate('window.__holdReading=true');
  await openFile(second); await wait('window.__readingReplies.length===1','second response held');
  await openFile(third); await wait('window.__readingReplies.length===2','third response held');
  await page.evaluate('window.__readingReplies.shift()()'); await frame();
  await wait(pendingReading,'old document cannot publish');
  await page.evaluate('window.__readingReplies.shift()()'); await wait(ready,'current response');
  assert.equal(await page.evaluate('document.querySelector(".markdown-body h1").textContent'),'Current document');
  assert.equal(await page.evaluate('Boolean(document.querySelector(".reading-dialect-notice"))'),false,'old extension warning cannot leak');
  assert.equal(await page.evaluate('window.__unsafe'),undefined,'HTML remains inert');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-reader-editable]").length>0'),true);

  await page.evaluate('window.__holdReading=false;window.__failReading=true');
  await openFile(fixture);
  await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="error"','startup failure');
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body,.toc-link").length'),0);
  await screenshot('reading-error');
  await metrics(420,360); await screenshot('reading-error-narrow');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'loading/error actions fit narrow windows');
  await metrics(1200,800);
  await page.evaluate('window.__failReading=false');
  await click('.reading-analysis-status button'); await wait(ready,'retry');
  assert.equal(await page.evaluate('document.querySelectorAll(".toc-link").length'),4);

  // Dirty text snapshots invalidate previous mappings without writing any sidecar.
  await click('[data-mode="editor"]');
  await page.evaluate('(()=>{const e=document.querySelector("[data-editor-textarea]");e.focus();e.setSelectionRange(0,0)})()');
  await page.send('Input.insertText',{text:'# Pending candidate\n\n'});
  await wait('document.querySelector(".app-shell").dataset.dirty==="true"','dirty source');
  await page.evaluate('window.__holdReading=true');
  await click('[data-mode="reader"]'); await wait('window.__readingReplies.length===1','dirty response held');
  await wait(pendingReading,'dirty analysis pending');
  assert.equal(await page.evaluate('document.querySelectorAll("[data-reader-editable],.toc-link").length'),0);
  await click('[data-mode="editor"]'); await frame();
  await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
  await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo clean');
  await page.evaluate('window.__holdReading=false;window.__readingReplies.shift()()');
  await click('[data-mode="reader"]'); await wait(ready,'restored exact snapshot');
  assert.equal(await page.evaluate('document.querySelector(".markdown-body h1").textContent'),'阅读与整理');
  assert.deepEqual(await snapshot(),before,'failure, retry and buffer undo preserve the three files');
  for(const file of [second,third]) for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(file+suffix),{code:'ENOENT'});
  await screenshot('reading-ready');
  const large=path.join(workspace,'large.md');
  const largeContent='# Large analysis\n\n'+'long text '.repeat(525_000)+'\n';
  await writeFile(large,largeContent);
  await page.evaluate('window.__holdReading=true');
  await openFile(large); await wait(pendingReading,'large document loading');
  await page.evaluate(`window.__sourceSwitchStart=performance.now();window.__sourceSwitchDOM=null;
    document.querySelector('[data-mode="editor"]').addEventListener('click',()=>window.__sourceSwitchClick=performance.now(),{once:true,capture:true});
    const observer=new MutationObserver(()=>{if(document.querySelector('.app-shell')?.dataset.activeMode==='editor'){
      window.__sourceSwitchDOM=performance.now();observer.disconnect();}});observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['data-active-mode']});`);
  const switchStarted=performance.now();
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]")?.getClientRects().length)','source while large analysis is pending');
  const switchSourceMs=Math.round(performance.now()-switchStarted);
  assert.equal(await page.evaluate('window.__readingWorkers.at(-1).wasTerminated'),true,'large analysis is interrupted');
  assert.equal(await readFile(large,'utf8'),largeContent);
  for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(large+suffix),{code:'ENOENT'});
  const sourceSwitchTrace=await page.evaluate('({modeDOMMs:Math.round(window.__sourceSwitchDOM-window.__sourceSwitchStart),workerCancelMs:Math.round(window.__readingWorkers.at(-1).terminatedAt-window.__sourceSwitchStart),clickToModeDOMMs:Math.round(window.__sourceSwitchDOM-window.__sourceSwitchClick),clickToCancelMs:Math.round(window.__readingWorkers.at(-1).terminatedAt-window.__sourceSwitchClick)})');
  console.log(JSON.stringify({largeSourceBytes:Buffer.byteLength(largeContent),pendingSwitchSourceMs:switchSourceMs,...sourceSwitchTrace}));
  console.log('PERF2 packaged E2E passed: real analysis worker, pending/error/retry, cancellation on mode/document/buffer changes, exact cache, BOM/CRLF semantics, HTML safety and three-file zero writes.');
} catch(error) {
  if(page) {try {console.log('worker diagnostic',await page.evaluate('window.__workerError'));await screenshot('failure');}catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
