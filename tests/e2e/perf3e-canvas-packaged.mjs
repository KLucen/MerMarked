import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-perf3e-'));
const fixture = path.join(workspace, '阅读与整理.md');
const targetBytes = Number(process.env.MERMARKD_PERF_MIB ?? 1) * 1024 * 1024;
const scale = true;
const headingCount = scale ? 200 : Math.round(targetBytes / (5 * 1024));
const paragraph = '正文 English 😀 ' + 'plain content '.repeat(Math.ceil(targetBytes / headingCount / 14));
const content = Array.from({length:headingCount},(_,i)=>'# Heading '+i+'\r\n\r\n'+
  (scale ? Array.from({length:3},(_,j)=>`Marker-${i*3+j} unique 中文😀\r\n\r\n`).join('') : '')+paragraph+'\r\n\r\n').join('')+'unique-perf-search-token\r\n';
const bytes = Buffer.concat([Buffer.from([239,187,191]), Buffer.from(content)]);
const hash = createHash('sha256').update(bytes).digest('hex');
let nextId = 0;
const canvas = (await reconcileCanvasState(null, {bytes, content, sha256:hash}, ()=>'card-'+nextId++)).model;
// A pre-existing user layout that fits 200 cards at a supported zoom. Automatic
// layout puts this flat document in one long row, which is a separate budget.
if(scale) canvas.cards=canvas.cards.map((card,i)=>({...card,position:{x:80+(i%20)*364,y:80+Math.floor(i/20)*212}}));
await writeFile(fixture, bytes);
await writeFile(fixture+'.mermarkd.json', serializeCanvasJson(canvas));
await writeFile(fixture+'.annotations.yaml', 'schemaVersion: 1\nsource:\n  sha256: "'+hash+'"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n');
if(scale){
  const annotations=Array.from({length:500},(_,i)=>{const exact=`Marker-${i} unique 中文😀`;const start=content.indexOf(exact);const startByte=3+Buffer.byteLength(content.slice(0,start));return {
    id:'annotation-'+i,kind:'highlight',color:'amber',createdAt:'2026-10-17T00:00:00Z',updatedAt:'2026-10-17T00:00:00Z',
    anchor:{basisSha256:hash,startByte,endByte:startByte+Buffer.byteLength(exact),sourceExact:exact,displayQuote:exact,
      prefix:Array.from(content.slice(Math.max(0,start-96),start)).slice(-48).join(''),suffix:Array.from(content.slice(start+exact.length,start+exact.length+96)).slice(0,48).join('')}};});
  await writeFile(fixture+'.annotations.yaml',serializeAnnotationYaml({schemaVersion:1,source:{sha256:hash,encoding:'utf-8',coordinateSystem:'utf8-byte'},tags:[],annotations}));
}
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
  await writeFile(path.join(qa, `perf3e-${name}.png`), Buffer.from(result.data, 'base64'));
}
async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await frame();
}
async function snapshot(file = fixture) {
  return Promise.all([file, file + '.annotations.yaml', file + '.mermarkd.json'].map(async (name) => ({ bytes: await readFile(name), mtime: (await stat(name)).mtimeMs })));
}

const measurements=[];
const retainedHeap=[];
async function sampleRetainedHeap(stage){
  await page.send('HeapProfiler.collectGarbage');
  const heap=await page.send('Runtime.getHeapUsage');
  retainedHeap.push({stage,usedHeapMiB:Math.round(heap.usedSize/1024/1024*10)/10});
}
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
  console.log('measured',name,elapsedMs);
}
try {
  page=await connect(port,'page'); main=await connect(port+200,'node');
  if(process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate',{url:process.env.MERMARKD_QA_RENDERER_URL});
  await main.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain;const original=ipc._invokeHandlers.get('annotations:load');
    globalThis.__annotationTrace=[];globalThis.__mainGaps=[];let previous=performance.now();setInterval(()=>{const now=performance.now();globalThis.__mainGaps.push(now-previous);previous=now;},10);
    ipc.removeHandler('annotations:load');ipc.handle('annotations:load',async(...args)=>{
      const started=performance.now();${process.env.MERMARKD_PERF_DELAY_ANNOTATIONS ? 'await new Promise(resolve=>setTimeout(resolve,1500));' : ''}
      const result=await original(...args);globalThis.__annotationTrace.push({durationMs:performance.now()-started,count:result.count});return result;});})()`);
  await page.send('Emulation.setFocusEmulationEnabled',{enabled:true});
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await page.send('Page.bringToFront'); await metrics(1200,800);
  await page.evaluate(`window.__frameGaps=[]; window.__lastFrame=performance.now();
    function tick(time){window.__frameGaps.push(time-window.__lastFrame);window.__lastFrame=time;
      if(${scale}&&window.__readingTrace&&!window.__readingTrace.annotationsReady&&CSS.highlights.get('mermarkd-amber')?.size===500)window.__readingTrace.annotationsReady=performance.now();
      requestAnimationFrame(tick)}requestAnimationFrame(tick)`);
  await page.evaluate(`window.__readingTrace={};window.__longTasks=[];
    new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      postMessage(...args){if(this.__reading)window.__readingTrace.posted=performance.now();return super.postMessage(...args);}
      constructor(...args){super(...args);if(String(args[0]).includes('reading-analysis.worker')){this.__reading=true;window.__readingTrace.created=performance.now();
        this.addEventListener('message',event=>{if(event.data.result){window.__readingTrace.reply=performance.now();window.__readingTrace.analysisMs=event.data.analysisMs;window.__readingTrace.analysisStartedAt=event.data.analysisStartedAt;}});}}
    };
    const observer=new MutationObserver(()=>{const state=document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis;
      if(state==='pending'&&!window.__readingTrace.loading)window.__readingTrace.loading=performance.now();
      if((state==='ready'||document.querySelector('.markdown-body h1'))&&!window.__readingTrace.ready){window.__readingTrace.ready=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>{window.__readingTrace.painted=performance.now();}));observer.disconnect();}});
    observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['data-reading-analysis']});`);
  const before=await snapshot();
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog=async()=>({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await page.evaluate('window.__readingTrace.started=performance.now()');
  if (process.env.MERMARKD_PERF_PROFILE) { await page.send('Profiler.enable'); await page.send('Profiler.start'); }
  await measure('open-reader',()=>click('[data-start-open]'),'document.querySelectorAll(".markdown-body h1").length==='+headingCount);
  if (process.env.MERMARKD_PERF_PROFILE) {
    const { profile } = await page.send('Profiler.stop');
    await writeFile(path.join(qa,'perf3e-open-'+(process.env.MERMARKD_PERF_LABEL??'current')+'.cpuprofile'),JSON.stringify(profile));
  }
  const readingTrace=await page.evaluate(`(()=>{const t=window.__readingTrace;return {
    loadingFeedbackMs:t.loading?Math.round(t.loading-t.started):null,
    firstDOMMs:t.ready?Math.round(t.ready-t.started):null,
    firstPaintMs:t.painted?Math.round(t.painted-t.started):null,
    analysisMs:t.analysisMs===undefined?null:Math.round(t.analysisMs),
    responseToDOMMs:t.ready&&t.reply?Math.round(t.ready-t.reply):null,
    responseToPaintMs:t.painted&&t.reply?Math.round(t.painted-t.reply):null,
    longTasks:window.__longTasks.filter(e=>e.start>=t.started).map(e=>Math.round(e.duration))};})()`);
  if(scale){
    await measure('annotations-ready',async()=>{},'CSS.highlights.get("mermarkd-amber")?.size===500');
    assert.equal(await page.evaluate('CSS.highlights.get("mermarkd-amber").size'),500);
    await screenshot('scale-reader');
  }
  if(scale){
    if(process.env.MERMARKD_PERF_PROFILE_CARDS){await page.send('Profiler.enable');await page.send('Profiler.start');}
    await measure('switch-200-cards',()=>click('[data-mode="cards"]'),'document.querySelectorAll(".react-flow__node").length===200 && document.querySelector("[data-canvas-save]")?.disabled===false');
    if(process.env.MERMARKD_PERF_PROFILE_CARDS){const {profile}=await page.send('Profiler.stop');await writeFile(path.join(qa,'perf3e-cards-'+(process.env.MERMARKD_PERF_LABEL??'current')+'.cpuprofile'),JSON.stringify(profile));}
    await measure('fit-200-cards',()=>click('[aria-label="适应全图"]'),`(()=>{const r=document.querySelector('[data-canvas-flow]').getBoundingClientRect();return [...document.querySelectorAll('.react-flow__node')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;}).length===200;})()`);
    const visibleCards=await page.evaluate(`(()=>{const r=document.querySelector('[data-canvas-flow]').getBoundingClientRect();return [...document.querySelectorAll('.react-flow__node')].filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;}).length;})()`);
    measurements.at(-1).visibleCards=visibleCards;
    assert.equal(visibleCards,200,'fit view contains 200 rendered cards');
    await screenshot('scale-cards');
    const originalBodies = await page.evaluate(`Array.from(document.querySelectorAll('.react-flow__node'),node=>({id:node.dataset.id,body:node.querySelector('.canvas-card-summary')?.textContent}))`);
    assert.equal(originalBodies.length,200);
    for(const item of originalBodies){
      const index=Number(item.id.replace('card-',''));
      assert.ok(item.body.startsWith(`Marker-${index*3} unique 中文😀`),'each card retains its own chapter body');
    }
    await measure('canvas-search',async()=>{
      await click('.canvas-search input');
      await page.send('Input.insertText',{text:'Heading 199'});
      await key('Enter','Enter',13);
    },`(()=>{const r=document.querySelector('[data-canvas-flow]').getBoundingClientRect(),b=document.querySelector('[data-id="card-199"]').getBoundingClientRect();return b.width>200&&b.left>=r.left&&b.right<=r.right&&b.top>=r.top&&b.bottom<=r.bottom;})()`);
    await page.evaluate(`(()=>{const e=document.querySelector('.canvas-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await click('[aria-label="适应全图"]');
    assert.deepEqual(await snapshot(),before,'opening, fitting and searching the canvas write no content files');
    const beforeDrag=(await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.ok(beforeDrag);
    let previous=beforeDrag;
    for(let turn=1;turn<=3;turn++){
      if(turn===1&&process.env.MERMARKD_PERF_PROFILE_CARDS){await main.send('Profiler.enable');await main.send('Profiler.start');}
      await measure('canvas-drag-'+turn,async()=>{
        const point=await page.evaluate(`(()=>{const r=document.querySelector('[data-id="card-0"] .canvas-card-heading strong').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
        await frame();
        for(let step=1;step<=6;step++){
          await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x-step,y:point.y-step/2,buttons:1});
          await frame();
        }
        await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x-6,y:point.y-3,button:'left',buttons:0,clickCount:1});
      },'document.querySelector("[data-canvas-save]")?.disabled===false && document.querySelector("[data-canvas-status]").textContent.includes("画布已保存")');
      if(turn===1&&process.env.MERMARKD_PERF_PROFILE_CARDS){const {profile}=await main.send('Profiler.stop');await writeFile(path.join(qa,'perf3e-drag-main-'+(process.env.MERMARKD_PERF_LABEL??'current')+'.cpuprofile'),JSON.stringify(profile));}
      const current=(await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
      assert.ok(current);
      assert.notDeepEqual(current.cards[0].position,previous.cards[0].position,'each pointer drag is persisted');
      assert.deepEqual(current.cards.slice(1),beforeDrag.cards.slice(1),'unrelated card state is preserved');
      assert.deepEqual(current.links,beforeDrag.links);
      assert.deepEqual(current.source,beforeDrag.source);
      previous=current;
    }
    await details('.canvas-toolbar-more');
    await click('[data-canvas-undo]');
    await wait('document.querySelector("[data-canvas-save]")?.disabled===false && document.querySelector("[data-canvas-redo]")?.disabled===false','undo last drag');
    await details('.canvas-toolbar-more');
    await click('[data-canvas-redo]');
    await wait('document.querySelector("[data-canvas-save]")?.disabled===false && document.querySelector("[data-canvas-undo]")?.disabled===false','redo last drag');
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model.cards,previous.cards);
    assert.deepEqual(await page.evaluate(`Array.from(document.querySelectorAll('.react-flow__node'),node=>({id:node.dataset.id,body:node.querySelector('.canvas-card-summary')?.textContent}))`),originalBodies);
    if(process.env.MERMARKD_PERF_GC_PROBE){
      // Restore the fixture grid so reopening does not exercise the separate
      // automatic-layout heuristic for roots dragged into the top-left corner.
      for(let turn=0;turn<3;turn++){
        await details('.canvas-toolbar-more');
        await click('[data-canvas-undo]');
        await wait('document.querySelector("[data-canvas-save]")?.disabled===false && document.querySelector("[data-canvas-redo]")?.disabled===false','memory probe restore grid');
      }
      assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model.cards,beforeDrag.cards);
      await sampleRetainedHeap('cards-1');
    }
    await measure('return-reader',()=>click('[data-mode="reader"]'),'CSS.highlights.get("mermarkd-amber")?.size===500');
    if(process.env.MERMARKD_PERF_GC_PROBE){
      await sampleRetainedHeap('reader-1');
      for(let cycle=2;cycle<=3;cycle++){
        await click('[data-mode="cards"]');
        await wait('document.querySelectorAll(".react-flow__node").length===200 && document.querySelector("[data-canvas-save]")?.disabled===false','memory probe cards');
        await sampleRetainedHeap('cards-'+cycle);
        await click('[data-mode="reader"]');
        await wait('CSS.highlights.get("mermarkd-amber")?.size===500','memory probe reader');
        await sampleRetainedHeap('reader-'+cycle);
      }
    }
  }
  if(process.env.MERMARKD_PERF_VERIFY_LIFECYCLE){
    const persisted=await snapshot();
    await click('[data-mode="editor"]');
    await wait('Boolean(document.querySelector("[data-editor-textarea]"))','source');
    await page.evaluate(`(()=>{const e=document.querySelector('[data-editor-textarea]');e.focus();const start=e.value.indexOf('Marker-0');e.setSelectionRange(start,start+8);})()`);
    await page.send('Input.insertText',{text:'Updated-0'});
    await wait('document.querySelector(".app-shell").dataset.dirty==="true"','dirty body');
    await click('[data-mode="cards"]');
    // Changed chapter bodies intentionally lose an unprovable persisted ID.
    // Inspect the current heading's projection instead of assuming card-0 binds.
    await wait(`Array.from(document.querySelectorAll('.react-flow__node')).some(node=>node.querySelector('.canvas-card-heading strong')?.textContent==='Heading 0'&&node.querySelector('.canvas-card-summary')?.textContent.startsWith('Updated-0'))`,'new body replaces cached same-heading content');
    assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").disabled'),true);
    assert.deepEqual(await snapshot(),persisted,'dirty projection does not persist');
    await click('[data-mode="editor"]');
    await page.evaluate('document.querySelector("[data-editor-textarea]").focus()');
    await key('z','KeyZ',90,2);
    await wait('document.querySelector(".app-shell").dataset.dirty==="false"','undo source');
    await click('[data-mode="cards"]');
    await wait('document.querySelector("[data-id=card-0] .canvas-card-summary")?.textContent.startsWith("Marker-0") && document.querySelector("[data-canvas-save]")?.disabled===false','restored body');
    assert.deepEqual(await snapshot(),persisted,'restored projection does not persist');
  }
  assert.deepEqual((await snapshot()).slice(0,2),before.slice(0,2),'canvas operations never write Markdown or annotations');
  const workerTrace=await page.evaluate(`(()=>{const t=window.__readingTrace;return {loadingToCreateMs:t.created-t.loading,createToPostMs:t.posted-t.created,postToReplyMs:t.reply-t.posted,analysisMs:t.analysisMs,
    postToAnalysisMs:t.analysisStartedAt===undefined?null:t.analysisStartedAt-performance.timeOrigin-t.posted,
    analysisToReplyMs:t.analysisStartedAt===undefined?null:performance.timeOrigin+t.reply-t.analysisStartedAt-t.analysisMs};})()`);
  const annotationTrace=await main.evaluate('({loads:globalThis.__annotationTrace,maxMainGapMs:Math.max(...globalThis.__mainGaps)})');
  const annotationsReadyMs=scale?await page.evaluate('window.__readingTrace.annotationsReady-window.__readingTrace.started'):null;
  const result={label:process.env.MERMARKD_PERF_LABEL??'current',sourceBytes:bytes.length,headings:headingCount,annotations:scale?500:0,annotationsReadyMs,readingTrace,workerTrace,annotationTrace,measurements,retainedHeap};
  await writeFile(path.join(qa,'perf3e-'+result.label+'.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  if(page) {try {await screenshot('failure');} catch {}}
  throw error;
} finally {
  for(const client of clients) client.close();
  if(child.exitCode===null) {try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch {}}
}
