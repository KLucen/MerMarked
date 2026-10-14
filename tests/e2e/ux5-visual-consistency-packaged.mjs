import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux5-'));
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
  await writeFile(path.join(qa, `ux5-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

async function fits() {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'page does not overflow');
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.canvas-toolbar details[open] > [role="group"]')].every(e=>{
    const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;
  })`), true, 'open canvas menu remains within viewport');
}
function luminance(color) {
  const channels = color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722;
}
async function contrast(selector, background) {
  const colors = await page.evaluate(`(() => {
    const a=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));
    const b=getComputedStyle(document.querySelector(${JSON.stringify(background)}));
    return {fg:a.color,bg:b.backgroundColor};
  })()`);
  const values=[luminance(colors.fg),luminance(colors.bg)].sort((a,b)=>a-b);
  assert.ok((values[1]+0.05)/(values[0]+0.05)>=4.5, `text contrast ${selector}: ${JSON.stringify(colors)}`);
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await metrics(1200,800); await screenshot('start');
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await click('[data-start-open]');
  await wait('Boolean(document.querySelector(".markdown-body table"))','reader semantics');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".markdown-body")).fontSize'),'16px');
  assert.equal(await page.evaluate('document.querySelector(".markdown-body strong").textContent'),'重点内容');
  assert.equal(await page.evaluate('document.querySelectorAll(".markdown-body input[type=checkbox]").length'),2);
  await contrast('.markdown-body','.reading-main');
  await contrast('.markdown-body a','.reading-main');
  await contrast('.toc-heading span','.toc-heading span');
  for(const [width,height] of [[1200,800],[800,700],[420,800]]) {
    await metrics(width,height); await fits(); await screenshot('reader-'+width);
  }
  await metrics(1200,800);
  await click('[data-mode="editor"]');
  await wait('Boolean(document.querySelector("[data-editor-textarea]"))','source');
  await frame();
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").value'),content.replaceAll('\r\n','\n'));
  for(const width of [1200,420]) {
    await metrics(width,800);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector("[data-editor-textarea]")).fontSize'),'13px');
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".source-editor-status")).fontSize'),'12px');
    await fits(); await screenshot('source-'+width);
  }
  await metrics(1200,800);
  await click('[data-editor-textarea]');
  await page.send('Input.insertText',{text:'待撤销'});
  await wait('document.querySelector(".app-shell").dataset.dirty==="true"','dirty status');
  await frame();
  await page.send('Page.bringToFront');
  await page.evaluate('document.querySelector("[aria-label=文档状态]").focus()');
  await key('Enter','Enter',13);
  await wait('document.querySelector("[aria-label=文档状态]").getAttribute("aria-expanded")==="true"','status open');
  assert.match(await page.evaluate('document.querySelector(".workspace-status-details").textContent'),/未保存/);
  await contrast('.workspace-document-status.warning .workspace-popover-trigger','.topbar');
  await screenshot('source-dirty');
  await key('Escape','Escape',27);
  await click('[data-editor-textarea]'); await key('z','KeyZ',90,2);
  await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo is clean');
  assert.deepEqual(await snapshot(),before,'source buffer and undo leave three content files untouched');

  await click('[data-mode="cards"]');
  await wait('document.querySelector("[data-canvas-save]")?.disabled===false','canvas');
  assert.match(await page.evaluate('document.querySelector("[data-canvas-status]").textContent'), /布局已就绪/, 'completed layout does not retain a loading message');
  if(await visible('#workspace-left-panel')) await click('[aria-label="收起左侧栏"]');
  const more='.canvas-toolbar-more'; const exports='.canvas-toolbar-exports';
  await page.evaluate(`document.querySelector('${more} > summary').focus()`);
  await key(' ','Space',32); await wait(`document.querySelector('${more}').open`,'keyboard opens more');
  await key('ArrowDown','ArrowDown',40);
  assert.equal(await page.evaluate('document.activeElement.hasAttribute("data-canvas-arrange")'),true);
  await key('End','End',35);
  assert.equal(await page.evaluate('document.activeElement.hasAttribute("data-canvas-collapse")'),true,'disabled history actions are skipped');
  await key('ArrowDown','ArrowDown',40);
  assert.equal(await page.evaluate('document.activeElement.hasAttribute("data-canvas-arrange")'),true,'actions wrap');
  await key('Home','Home',36);
  await key('Escape','Escape',27);
  assert.equal(await page.evaluate(`document.querySelector('${more}').open`),false);
  assert.equal(await page.evaluate(`document.activeElement===document.querySelector('${more} > summary')`),true,'escape restores trigger');
  assert.ok(await page.evaluate('parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=1.5'), 'visible focus ring survives fractional physical pixel rounding');
  await screenshot('canvas-focus');
  await details(more); await details(exports);
  assert.equal(await page.evaluate(`document.querySelector('${more}').open`),false,'menus are exclusive');
  await key('Tab','Tab',9); await frame();
  assert.equal(await page.evaluate('document.activeElement.dataset.canvasExport'),'png');
  await key('End','End',35);
  assert.equal(await page.evaluate('document.activeElement.dataset.canvasExport'),'pdf');
  await key('Tab','Tab',9); await frame();
  assert.equal(await page.evaluate(`document.querySelector('${exports}').open`),false,'tab outside dismisses');
  await main.evaluate('process.mainModule.require("electron").dialog.showSaveDialog=async()=>({canceled:true})');
  await details(exports);
  await click('[data-canvas-export="png"]');
  await wait(`!document.querySelector('${exports}').open`, 'an action dismisses the export menu');
  assert.equal(await page.evaluate(`document.activeElement===document.querySelector('${exports} > summary')`),true,'action restores trigger');
  await details(exports);
  await click('.canvas-search input');
  assert.equal(await page.evaluate(`document.querySelector('${exports}').open`),false,'outside click dismisses');
  await details(exports);
  for(const [width,height] of [[1200,800],[800,700],[420,800],[420,360]]) {
    await metrics(width,height); await fits();
    const anchor = await page.evaluate(`(() => {const a=document.querySelector('${exports} > summary').getBoundingClientRect();
      const b=document.querySelector('${exports} > [role=group]').getBoundingClientRect();return {bottom:a.bottom,top:b.top};})()`);
    if(height>=700) assert.ok(Math.abs(anchor.top-anchor.bottom-6)<2,'menu follows the export trigger');
    await screenshot('export-'+width+'-'+height);
  }
  await page.evaluate('window.scrollTo({top:document.documentElement.scrollHeight,behavior:"instant"})');
  await frame(); await fits();
  const triggerBottom = await page.evaluate(`document.querySelector('${exports} > summary').getBoundingClientRect().bottom`);
  if (triggerBottom <= 12) assert.equal(await page.evaluate(`document.querySelector('${exports}').open`), false, 'scrolling the trigger outside the viewport dismisses its menu');
  await page.evaluate('window.scrollTo({top:0,behavior:"instant"})');
  await frame();
  await metrics(1200,800);
  await details(exports);
  await main.evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2)');
  await frame(); await fits(); await screenshot('zoom-200');
  await main.evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)');
  await frame();
  await page.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'forced-colors',value:'active'}]});
  await frame();
  assert.equal(await page.evaluate('getComputedStyle(document.documentElement).scrollBehavior'),'auto');
  await page.evaluate(`document.querySelector('${exports} > summary').focus()`);
  await key('Escape','Escape',27); await frame();
  assert.ok(await page.evaluate('parseFloat(getComputedStyle(document.activeElement).outlineWidth)>=1.5'), 'high contrast retains a visible focus ring');
  await details(more); await fits(); await screenshot('forced-colors');
  await page.send('Emulation.setEmulatedMedia',{features:[]});
  await frame();
  assert.deepEqual(await snapshot(),before,'menus, focus, zoom, resize and media changes do not write any content file');
  console.log('UX5 packaged E2E passed: readable type, text contrast, keyboard menus, anchored bounds, 200% zoom, high contrast, reduced motion and three-file zero writes.');
} catch(error) {
  if(page) {try {await screenshot('failure');} catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
