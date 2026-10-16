import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf3a-search-'));
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
  await writeFile(path.join(qa, `perf3a-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const ready = 'document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"';
const output = 'document.querySelector(".reader-searchbar output")';
async function query(value) {
  await page.evaluate(`(()=>{const input=document.querySelector('#reader-search-input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
    input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
async function result(value, expected) {
  await query(value);
  await frame();
  await wait(`${output}?.textContent===${JSON.stringify(expected)}`,'query '+value);
}
async function openFile(file) {
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(file)+']})');
  await click('[aria-label="打开文档"]'); await wait(ready,'new reader');
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await metrics(1200,800);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[data-start-open]'); await wait(ready,'reader');
  await click('[aria-label="查找正文"]');
  await page.evaluate(`window.__searchWalks=0; const original=document.createTreeWalker.bind(document);
    document.createTreeWalker=(root,...args)=>{if(root.matches?.('.markdown-body'))window.__searchWalks++;return original(root,...args);};`);
  await result('重点内容','1 / 1');
  const walks=await page.evaluate('window.__searchWalks');
  assert.ok(walks>0);
  await result('emoji 😀','1 / 1');
  await result('does-not-exist','没有匹配');
  assert.equal(await page.evaluate('window.__searchWalks'),walks,'new queries reuse the DOM index');
  await result('重点内容','1 / 1');
  await click('[aria-label="下一个匹配"]');
  assert.equal(await page.evaluate('window.__searchWalks'),walks,'highlight painting does not invalidate the index');
  await click('[aria-label="关闭正文查找"]');
  assert.deepEqual(await snapshot(),before,'search does not write any content files');

  const semantic=path.join(workspace,'semantic.md');
  const semanticText='# Search semantics\n\n跨**强调**和[链接](https://example.com)匹配。\n\n断行前  \n断行后\n\n<p>硬断前<br>硬断后</p>\n\n完整 á 👍🏽 👨‍👩‍👧‍👦 🇨🇳。\n\n<details><summary>摘要词</summary><p>折叠词</p><details><summary>内层摘要</summary><p>深层词</p></details></details>\n\n<blockquote>外层前<p>内层正文</p>外层后</blockquote>\n\n<script>危险词</script>\n\n'+('上限词 '.repeat(1005))+'\n';
  await writeFile(semantic,semanticText);
  const semanticStat=await stat(semantic);
  await openFile(semantic); await click('[aria-label="查找正文"]');
  await result('跨强调和链接','1 / 1');
  assert.equal(await page.evaluate('CSS.highlights.get("mermarkd-current-search-match").values().next().value.toString()'),'跨强调和链接');
  await result('断行前断行后','没有匹配');
  await result('断行前\u0000断行后','没有匹配');
  await result('硬断前硬断后','没有匹配');
  await result('硬断前\u0000硬断后','没有匹配');
  await result('外层前外层后','没有匹配');
  await result('内层正文','1 / 1');
  await result('👍','没有匹配'); await result('👍🏽','1 / 1');
  await result('́','没有匹配');
  await result('摘要词','1 / 1');
  await result('折叠词','没有匹配');
  await page.evaluate("document.querySelector('.markdown-body details').open=true");
  await wait(`${output}?.textContent==='1 / 1'`,'opening details re-runs the same query');
  await page.evaluate("document.querySelector('.markdown-body details').open=false");
  await wait(`${output}?.textContent==='没有匹配'`,'closing details removes old match');
  await result('内层摘要','没有匹配');
  await page.evaluate("document.querySelector('.markdown-body details').open=true");
  await wait(`${output}?.textContent==='1 / 1'`,'nested summary is visible only when outer details is open');
  await result('深层词','没有匹配'); await result('危险词','没有匹配');
  await result('上限词','1 / 1000（仅显示前 1000 项）');
  assert.equal(await page.evaluate('CSS.highlights.get("mermarkd-search-match").size'),999);
  await result('跨强调和链接','1 / 1');
  await page.evaluate("document.querySelector('[data-search-current]').hidden=true");
  await wait(`${output}?.textContent==='没有匹配'`,'hidden property invalidates current results');
  await page.evaluate("document.querySelector('.markdown-body p[hidden]').hidden=false");
  await wait(`${output}?.textContent==='1 / 1'`,'visibility restored');
  // A DOM edit invalidates the cache even before source submission.
  await page.evaluate("document.querySelector('[data-search-current] strong').firstChild.data='变更'");
  await wait(`${output}?.textContent==='没有匹配'`,'edited DOM removes old match');
  await result('跨变更和链接','1 / 1');
  await page.evaluate("document.querySelector('[data-search-current] strong').firstChild.data='强调'");
  await wait(`${output}?.textContent==='没有匹配'`,'restored DOM invalidates changed match');

  // Hold the asynchronous boundary to deliver an old query after the new one and after closing.
  await page.evaluate(`window.__searchWaits=[];window.__holdSearch=true;const originalTimer=window.setTimeout;
    window.setTimeout=(callback,delay,...args)=>{if(window.__holdSearch&&delay===0){window.__searchWaits.push(()=>callback(...args));return -1;}return originalTimer(callback,delay,...args);};`);
  await query('上限词'); await wait('window.__searchWaits.length>0','held query');
  await wait(`${output}?.textContent==='正在查找…'`,'pending feedback');
  assert.equal(await page.evaluate(`document.querySelector('[aria-label="下一个匹配"]').disabled`),true);
  await query('摘要词');
  await wait('window.__searchWaits.length>1','replacement query');
  await page.evaluate('window.__holdSearch=false;window.__searchWaits.splice(0).forEach(run=>run())');
  await wait(`${output}?.textContent==='1 / 1'`,'only current query publishes');
  assert.equal(await page.evaluate('CSS.highlights.get("mermarkd-current-search-match").values().next().value.toString()'),'摘要词');
  await page.evaluate('window.__holdSearch=true'); await query('上限词');
  await wait('window.__searchWaits.length>0','close pending');
  await click('[aria-label="关闭正文查找"]');
  await page.evaluate('window.__holdSearch=false;window.__searchWaits.splice(0).forEach(run=>run())'); await frame();
  assert.equal(await page.evaluate('Boolean(CSS.highlights.get("mermarkd-search-match")||CSS.highlights.get("mermarkd-current-search-match"))'),false);
  await click('[aria-label="查找正文"]'); await result('摘要词','1 / 1');
  await page.evaluate('window.__holdSearch=true'); await query('上限词'); await wait('window.__searchWaits.length>0','mode pending');
  await click('[data-mode="editor"]');
  await page.evaluate('window.__holdSearch=false;window.__searchWaits.splice(0).forEach(run=>run())'); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-search-current]"))'),false);
  await click('[data-mode="reader"]'); await wait(ready,'return reading');
  await click('[aria-label="查找正文"]'); await result('摘要词','1 / 1');
  await page.evaluate('window.__holdSearch=true'); await query('上限词'); await wait('window.__searchWaits.length>0','document pending');
  await openFile(fixture);
  await page.evaluate('window.__holdSearch=false;window.__searchWaits.splice(0).forEach(run=>run())'); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-search-current]"))'),false);
  await click('[aria-label="查找正文"]'); await result('重点内容','1 / 1');
  await page.evaluate(`window.__savedSearchWalker=document.createTreeWalker;
    document.createTreeWalker=()=>{throw Error('QA search failure')};
    document.querySelector('.markdown-body').classList.add('qa-search-invalidate');`);
  await wait(`${output}?.textContent==='查找暂不可用，请重新输入'`,'failure is not presented as no matches');
  await metrics(420,360); await screenshot('search-error-narrow');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'error feedback fits narrow view');
  await page.evaluate('document.createTreeWalker=window.__savedSearchWalker');
  await metrics(1200,800);
  await result('emoji 😀','1 / 1');
  await metrics(420,360); await screenshot('search-narrow');
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  assert.deepEqual(await snapshot(),before);
  assert.equal(await readFile(semantic,'utf8'),semanticText); assert.equal((await stat(semantic)).mtimeMs,semanticStat.mtimeMs);
  for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(semantic+suffix),{code:'ENOENT'});
  await metrics(1200,800);
  const empty=path.join(workspace,'empty.md'); await writeFile(empty,'');
  await openFile(empty); await click('[aria-label="查找正文"]'); await result('empty','没有匹配');
  const long=path.join(workspace,'long.md');
  const longText='# Long paragraph\n\n'+'👍🏽 plain '.repeat(75000)+'tail-unique\n';
  await writeFile(long,longText);
  await openFile(long); await click('[aria-label="查找正文"]');
  await result('tail-unique','1 / 1');
  // Start an expensive rejected-grapheme scan, then supersede it with a match at the end.
  await query('👍'); await query('tail-unique');
  await wait(`${output}?.textContent==='1 / 1'`,'cancel partial-emoji scan');
  assert.equal(await page.evaluate('CSS.highlights.get("mermarkd-current-search-match").values().next().value.toString()'),'tail-unique');
  assert.equal(await readFile(long,'utf8'),longText);
  for(const file of [empty,long]) for(const suffix of ['.annotations.yaml','.mermarkd.json']) await assert.rejects(stat(file+suffix),{code:'ENOENT'});
  console.log('PERF3A passed: index reuse, exact Unicode/inline/line-break ranges, visibility and DOM invalidation, 1000 limit, pending/replaced/closed/mode/document cancellation, narrow UI and zero file writes.');
} catch(error) {
  if(page) {try {await screenshot('failure');}catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
