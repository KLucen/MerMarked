import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf3b-reading-'));
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
      let result;
      try { result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }); }
      catch(error) { throw new Error(expression.slice(0,220)+': '+error.message); }
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
  await writeFile(path.join(qa, `perf3b-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const ready = 'document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"';
async function openFile(file) {
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(file)+']})');
  await click('[aria-label="打开文档"]'); await wait(ready,'new reader');
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start'); await metrics(1200,800);
  await page.evaluate(`window.__renderReplies=[];window.__holdRender=true;window.__renderWorkers=[];
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);if(String(args[0]).includes('reading-analysis.worker')){
        window.__renderWorkers.push(this);
        this.addEventListener('message',event=>{if(event.data.result){
          window.__lastRender=event.data.result;
          if(window.__holdRender){event.stopImmediatePropagation();window.__renderReplies.push(()=>this.onmessage?.(event));}
        }});}}
    };`);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[data-start-open]'); await wait('window.__renderReplies.length===1','worker prepared response');
  assert.equal(await page.evaluate('window.__lastRender.renderTree.type'),'root');
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body,[data-reader-editable]").length'),0,'prepared response is not displayed before current task commits');
  const headingOffsets=await page.evaluate('window.__lastRender.renderTree.children.filter(n=>n.type==="element"&&/^h[1-6]$/.test(n.tagName)).map(n=>n.position.start.offset)');
  assert.equal(headingOffsets.length,4);
  await page.evaluate('window.__holdRender=false;window.__renderReplies.shift()()'); await wait(ready,'prepared reader');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".markdown-body h1,.markdown-body h2,.markdown-body h3")].map(n=>Number(n.dataset.sourceBlockStart))'),headingOffsets,'worker offsets survive React component conversion');
  await page.evaluate('window.__firstReadingNode=document.querySelector(".markdown-body p");void 0');
  await click('[aria-label="查找正文"]');
  await page.send('Input.insertText',{text:'重点内容'});
  await wait('document.querySelector(".reader-searchbar output").textContent==="1 / 1"','prepared search');
  assert.equal(await page.evaluate('window.__firstReadingNode===document.querySelector(".markdown-body p")'),true,'chrome updates retain DOM identity');
  await click('[aria-label="关闭正文查找"]');
  const workers=await page.evaluate('window.__renderWorkers.length');
  await click('[data-mode="editor"]');
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").value'),content.replaceAll('\r\n','\n'));
  await click('[data-mode="reader"]'); await wait(ready,'cached prepared reader');
  assert.equal(await page.evaluate('window.__renderWorkers.length'),workers,'unchanged complete projection is reused');
  assert.deepEqual(await snapshot(),before);

  const semantic=path.join(workspace,'global-references.md');
  const semanticText='\uFEFF# 全局引用\r\n\r\n[延后链接][late] 和 **唯一选文😀**。\r\n\r\n'+
    '# 中间章节\r\n\r\n普通文字。\r\n\r\n'.repeat(80)+
    '<details><summary>摘要</summary>\r\n\r\n折叠内文\r\n\r\n</details>\r\n\r\n'+
    '<video><table>SECRET_FOSTER<img src="secret.png"></table></video>\r\n\r\n'+
    '<a href="javascript:window.__unsafe=1" onclick="window.__unsafe=1">已净化链接</a>\r\n\r\n'+
    '<span class="html-placeholder" role="note">普通可见词</span>\r\n\r\n'+
    '[late]: https://example.com/late "尾部定义"\r\n';
  await writeFile(semantic,semanticText); const beforeSemantic=await stat(semantic);
  await openFile(semantic);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body p a").getAttribute("href")'),'https://example.com/late');
  assert.equal(await page.evaluate('document.querySelector(".markdown-body p a").title'),'尾部定义');
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body h1").length'),81);
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body script,.markdown-body video,.markdown-body [onclick],.markdown-body [href^=javascript],.markdown-body img").length'),0);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body").textContent.includes("SECRET_FOSTER")'),false);
  assert.equal(await page.evaluate('window.__unsafe'),undefined);
  const workerText=await page.evaluate('JSON.stringify(window.__lastRender.renderTree)');
  assert.doesNotMatch(workerText,/SECRET_FOSTER|secret\.png|javascript:|onclick/,'worker output is already sanitized');
  const anchor=await page.evaluate(`(()=>{const p=document.querySelector('.markdown-body p');return {start:Number(p.dataset.sourceBlockStart),text:p.textContent}})()`);
  assert.equal(semanticText.slice(1+anchor.start,1+anchor.start+4),'[延后链');
  assert.equal(anchor.text,'延后链接 和 唯一选文😀。');
  await click('[aria-label="查找正文"]'); await page.send('Input.insertText',{text:'普通可见词'});
  await wait('document.querySelector(".reader-searchbar output").textContent==="1 / 1"','spoofed placeholder remains searchable');
  await metrics(420,360); await screenshot('prepared-narrow');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.equal(await readFile(semantic,'utf8'),semanticText); assert.equal((await stat(semantic)).mtimeMs,beforeSemantic.mtimeMs);
  for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(semantic+suffix),{code:'ENOENT'});
  assert.deepEqual(await snapshot(),before);
  console.log('PERF3B passed: real worker-prepared sanitized HAST, source positions, full-document references, stable DOM/cache, search, narrow UI and three-file zero writes.');
} catch(error) {
  if(page) {try {await screenshot('failure');}catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
