import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

// A manually coordinated native-client diagnostic, never a performance pass.
// It does not enable/disable AX features. A real native client is coordinated
// separately by the caller; contenteditable probes only affect this test DOM.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const measurementPolicy = {
  id: 'qa4-post-ready-observation-v2', minimumObservationMs: 1500, finalAnimationFrames: 2,
  anchor: 'ready-painted for actions with a readiness condition; action-completed for other actions',
  readyMetric: 'inputToReadyPaintMs remains independent of the observation tail',
  boundary: 'Diagnostic observation only; native AX work may continue after end and this is not a performance budget pass.' };
const [prefix, mode = 'run'] = process.argv.slice(2);
assert.match(prefix ?? '', /^qa4-[a-z0-9][a-z0-9-]{0,85}$/i);
assert.ok(['run', '--fixture-check'].includes(mode));
const executable = process.env.MERMARKD_QA_EXE;
const buildManifestPath = process.env.MERMARKD_QA_BUILD_MANIFEST;
assert.ok(executable && path.isAbsolute(executable), 'Select an absolute MERMARKD_QA_EXE.');
assert.ok(buildManifestPath && path.isAbsolute(buildManifestPath), 'Select its absolute MERMARKD_QA_BUILD_MANIFEST.');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = async file => { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: digest(bytes) }; };
const script = await proof(fileURLToPath(import.meta.url));
const buildManifest = await proof(buildManifestPath), build = JSON.parse(await readFile(buildManifestPath, 'utf8'));
assert.equal(build.status, 'passed'); assert.match(build.sourceCommit ?? '', /^[a-f0-9]{40}$/i);
const asar = await proof(path.join(path.dirname(executable), 'resources/app.asar'));
const approvedAsars = Array.isArray(build.artifacts) ? build.artifacts : [build.artifacts?.asar].filter(Boolean);
assert.equal(approvedAsars.filter(item => item.sha256?.toLowerCase() === asar.sha256 && item.bytes === asar.bytes).length, 1,
  'The selected ASAR must match exactly one artifact in its passed build receipt.');
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}-session.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'Preserve previous evidence.');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa4-ax-'));
const fixture = path.join(workspace, 'QA4-原生辅助查询.md');
const tailMarker = 'QA4-END-OF-FULL-DOCUMENT-中文😀';
const paragraph = '正文 English 😀 ' + 'plain content '.repeat(Math.ceil(5 * 1024 * 1024 / 200 / 14));
const content = Array.from({ length: 200 }, (_, index) => `# Heading ${index}\r\n\r\n` +
  Array.from({ length: 3 }, (_, marker) => `Marker-${index * 3 + marker} unique 中文😀\r\n\r\n`).join('') + paragraph + '\r\n\r\n').join('') + tailMarker + '\r\n';
const sourceBytes = Buffer.from('\ufeff' + content), sourceSha256 = digest(sourceBytes);
let nextId = 0;
const canvas = (await reconcileCanvasState(null, { bytes: sourceBytes, content, sha256: sourceSha256 }, () => `card-${nextId++}`)).model;
canvas.cards = canvas.cards.map((card, index) => ({ ...card, position: { x: 80 + index % 20 * 364, y: 80 + Math.floor(index / 20) * 212 } }));
const annotations = Array.from({ length: 500 }, (_, index) => {
  const exact = `Marker-${index} unique 中文😀`, start = content.indexOf(exact), startByte = 3 + Buffer.byteLength(content.slice(0, start));
  return { id: `annotation-${index}`, kind: 'highlight', color: 'amber', createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z',
    anchor: { basisSha256: sourceSha256, startByte, endByte: startByte + Buffer.byteLength(exact), sourceExact: exact, displayQuote: exact,
      prefix: Array.from(content.slice(Math.max(0, start - 96), start)).slice(-48).join(''),
      suffix: Array.from(content.slice(start + exact.length, start + exact.length + 96)).slice(0, 48).join('') } };
});
const yaml = serializeAnnotationYaml({ schemaVersion: 1, source: { sha256: sourceSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations });
assert.equal(parseAnnotationYaml(yaml).annotations.length, 500); assert.equal(canvas.cards.length, 200);
await writeFile(fixture, sourceBytes, { flag: 'wx' });
await writeFile(fixture + '.mermarkd.json', serializeCanvasJson(canvas), { flag: 'wx' });
await writeFile(fixture + '.annotations.yaml', yaml, { flag: 'wx' });
const files = [fixture, fixture + '.annotations.yaml', fixture + '.mermarkd.json'];
const snapshot = () => Promise.all(files.map(async file => ({ ...(await proof(file)), mtimeMs: (await stat(file)).mtimeMs })));
const initialFiles = await snapshot();
const receipt = { kind: 'QA4-native-client-editable-host-diagnostic', status: 'preparing', mode, prefix,
  startedAt: new Date().toISOString(), workspace, fixture, script, executable, asar, buildManifest, runtimeSourceCommit: build.sourceCommit,
  rendererUrl: process.env.MERMARKD_QA_RENDERER_URL ?? null,
  fixtureIdentity: { bytes: sourceBytes.length, sha256: sourceSha256, headings: 200, cards: 200, highlights: 500, tailMarker }, initialFiles,
  boundary: 'One selected package and generated document. Readonly/one-host/focusable probes mutate only current test-DOM attributes, not product source, AX settings or persisted files. Native queries are external. Profiled/focus-invalid observations are diagnostic only.',
  measurementPolicy, ports: { renderer: 17874, main: 25874, control: 18874 }, requests: [], traces: [] };
await writeFile(reportPath, JSON.stringify(receipt, null, 2), { flag: 'wx' });
const save = () => writeFile(reportPath, JSON.stringify(receipt, null, 2));
let child, page, main, server, timer, busy = false, stopped = false, sequence = 0, tracing = null, originalDom = null;
let probeMode = 'product';
async function wait(expression, label, timeout = 45000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await page.evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error(`Timed out: ${label}`);
}
async function environment() {
  return main.evaluate(`(()=>{const {app,BrowserWindow,screen}=process.mainModule.require('electron'),w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());
    return {capturedAt:new Date().toISOString(),accessibilitySupportEnabled:app.accessibilitySupportEnabled,features:app.getAccessibilitySupportFeatures?.()??null,
      focused:w?.isFocused(),visible:w?.isVisible(),minimized:w?.isMinimized(),refreshRateHz:w?screen.getDisplayMatching(w.getBounds()).displayFrequency:null};})()`);
}
async function assertFrozenInputs() {
  assert.deepEqual(await proof(asar.path), asar, 'Selected ASAR changed.');
  assert.deepEqual(await proof(buildManifest.path), buildManifest, 'Build receipt changed.');
  assert.deepEqual(await proof(script.path), script, 'Diagnostic source changed during the session.');
  assert.deepEqual(await snapshot(), initialFiles, 'Diagnostic navigation/probes must not write Markdown or either sidecar.');
}
async function click(selector) {
  const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!(e instanceof HTMLElement)||e.hasAttribute('disabled')||e.closest('[hidden],[inert]'))return null;
    const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
  assert.ok(point, `Visible enabled target ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function domState() {
  const state = await page.evaluate(`(()=>{const article=document.querySelector('.markdown-body'),hosts=article?[...article.querySelectorAll('[data-reader-editable]')]:[],p=window.__qa4Probe;
    return {mode:document.querySelector('.app-shell')?.dataset.activeMode,dirty:document.querySelector('.app-shell')?.dataset.dirty,
      path:document.querySelector('.workspace-current-name')?.title??null,ready:document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis,
      headings:article?.querySelectorAll('h1').length??0,text:article?.textContent??null,
      highlights:CSS.highlights.get('mermarkd-amber')?.size??0,hostCount:hosts.length,editableHosts:hosts.filter(e=>e.isContentEditable).length,
      focusableParagraphs:hosts.filter(e=>e.tagName==='P'&&e.tabIndex===0).length,
      probe:p?{mode:p.mode,originalHosts:p.rows.length,connectedHosts:p.rows.filter(row=>row.element.isConnected).length,
        flagsMatch:p.rows.every(row=>row.element.isConnected&&row.element.getAttribute('contenteditable')===row.expectedEditable&&row.element.getAttribute('tabindex')===row.expectedTabIndex)}:null};})()`);
  state.textSha256 = state.text === null ? null : digest(Buffer.from(state.text));
  state.textUnits = state.text?.length ?? 0; state.hasTail = state.text?.includes(tailMarker) ?? false; delete state.text;
  return state;
}
async function assertReaderReady() {
  const state = await domState();
  assert.equal(state.mode, 'reader'); assert.equal(state.ready, 'ready'); assert.notEqual(state.dirty, 'true');
  assert.equal(state.path?.toLowerCase(), fixture.toLowerCase()); assert.equal(state.headings, 200); assert.equal(state.highlights, 500); assert.equal(state.hasTail, true);
  if (state.probe) assert.equal(state.probe.flagsMatch, true, 'React changed the diagnostic attributes; do not silently reapply.');
  return state;
}
async function probe(action) {
  const before = await assertReaderReady();
  if (originalDom) { assert.equal(before.textSha256, originalDom.textSha256); assert.equal(before.textUnits, originalDom.textUnits); }
  originalDom ??= before;
  const target = { 'probe-readonly-on': 'readonly', 'probe-readonly-off': 'product', 'probe-one-host': 'one-host', 'probe-static-focusable': 'static-focusable' }[action];
  const result = await page.evaluate(`(()=>{const article=document.querySelector('.markdown-body');if(!window.__qa4Probe){const rows=[...article.querySelectorAll('[data-reader-editable]')].map(element=>({element,editable:element.getAttribute('contenteditable'),tabIndex:element.getAttribute('tabindex')}));window.__qa4Probe={mode:'product',rows};}
    const p=window.__qa4Probe,mode=${JSON.stringify(target)},firstParagraph=p.rows.find(row=>row.element.tagName==='P');
    for(const row of p.rows){if(!row.element.isConnected)throw Error('Original host was replaced.');
      const editable=mode==='product'?row.editable:mode==='one-host'&&row===firstParagraph?row.editable:'false';
      const tabIndex=mode==='static-focusable'&&row.element.tagName==='P'?'0':row.tabIndex;
      if(editable===null)row.element.removeAttribute('contenteditable');else row.element.setAttribute('contenteditable',editable);
      if(tabIndex===null)row.element.removeAttribute('tabindex');else row.element.setAttribute('tabindex',tabIndex);
      row.expectedEditable=editable;row.expectedTabIndex=tabIndex;
    }p.mode=mode;return {mode,firstParagraph:firstParagraph?{sourceStart:firstParagraph.element.dataset.sourceBlockStart,textUnits:firstParagraph.element.textContent.length}:null};})()`);
  probeMode = target;
  const after = await assertReaderReady(); assert.equal(after.textSha256, originalDom.textSha256);
  assert.equal(after.hostCount, originalDom.hostCount); if (target !== 'product' && target !== 'one-host') assert.equal(after.editableHosts, 0);
  if (target === 'one-host') assert.equal(after.editableHosts, 1);
  return { ...result, before, after };
}
async function installMeasurements() {
  await page.evaluate(`(()=>{window.__qa4={frames:[],long:[],previous:performance.now(),observer:null,overflowFrames:0};
    const tick=now=>{const s=window.__qa4;if(s.frames.length<10000)s.frames.push({start:s.previous,end:now,gap:now-s.previous});else s.overflowFrames++;s.previous=now;requestAnimationFrame(tick);};requestAnimationFrame(tick);
    const observer=new PerformanceObserver(list=>__qa4.long.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration}))));observer.observe({type:'longtask',buffered:false});__qa4.observer=observer;})()`);
}
async function beginMeasurement(id, condition) {
  await page.evaluate(`(()=>{window.__qa4Cleanup?.();const s=__qa4;s.frames=[];s.long=[];s.overflowFrames=0;s.previous=performance.now();
    const m=s.measurement={id:${JSON.stringify(id)},start:performance.now(),input:null,readyObserved:null,readyPaint:null};performance.mark(m.id+':start');
    let frame,paintFrame;const input=()=>{if(m.input===null){m.input=performance.now();performance.mark(m.id+':input');}};
    document.addEventListener('pointerdown',input,true);document.addEventListener('keydown',input,true);
    const poll=()=>{if(m.input!==null&&m.readyObserved===null&&(${condition??'false'})){m.readyObserved=performance.now();paintFrame=requestAnimationFrame(()=>{m.readyPaint=performance.now();performance.mark(m.id+':ready-painted');});}frame=requestAnimationFrame(poll);};frame=requestAnimationFrame(poll);
    window.__qa4Cleanup=()=>{cancelAnimationFrame(frame);cancelAnimationFrame(paintFrame);document.removeEventListener('pointerdown',input,true);document.removeEventListener('keydown',input,true);};})()`);
}
async function endMeasurement(expectReady) {
  return page.evaluate(`(async()=>{const s=__qa4,m=s.measurement,policy=${JSON.stringify(measurementPolicy)};
    if(${Boolean(expectReady)}&&m.readyPaint===null)await new Promise((resolve,reject)=>{let frame;const timer=setTimeout(()=>{cancelAnimationFrame(frame);reject(Error('No ready-painted mark before the diagnostic observation tail.'));},45000);
      const poll=()=>{if(m.readyPaint!==null){clearTimeout(timer);resolve();}else frame=requestAnimationFrame(poll);};poll();});
    const anchor=m.readyPaint??performance.now();m.observation={policyId:policy.id,minimumObservationMs:policy.minimumObservationMs,finalAnimationFrames:policy.finalAnimationFrames,
      anchor:m.readyPaint===null?'action-completed':'ready-painted',anchorTime:anchor,tailWaitStarted:performance.now(),targetTime:anchor+policy.minimumObservationMs};
    performance.mark(m.id+':observation-tail-start');await new Promise(resolve=>setTimeout(resolve,Math.max(0,m.observation.targetTime-performance.now())));
    m.observation.tailWaitFinished=performance.now();performance.mark(m.id+':observation-tail-finished');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    __qa4Cleanup?.();m.end=performance.now();m.observation.observedAfterAnchorMs=m.end-anchor;performance.mark(m.id+':end');
    const input=m.input??m.start;return {...m,inputToReadyPaintMs:m.input===null||m.readyPaint===null?null:m.readyPaint-m.input,
      maxFrameGapMs:Math.max(0,...s.frames.map(f=>f.gap)),interactionMaxFrameGapMs:Math.max(0,...s.frames.map(f=>Math.max(0,f.end-Math.max(input,f.start)))),
      frames:s.frames,longTasks:s.long,overflowFrames:s.overflowFrames,visibility:document.visibilityState,focused:document.hasFocus()};})()`);
}
async function startTrace() {
  assert.equal(tracing, null, 'A session trace is already running.');
  const tracePath = path.join(qa, `${prefix}-trace-${receipt.traces.length + 1}.json`);
  await assert.rejects(stat(tracePath), error=>error.code==='ENOENT', 'Preserve earlier trace.');
  const categories = await main.evaluate(`(async()=>{const {contentTracing}=process.mainModule.require('electron');const available=await contentTracing.getCategories();
    const selected=[...new Set(['toplevel','devtools.timeline','v8','blink.user_timing',...available.filter(c=>/accessibility/i.test(c))])];
    await contentTracing.startRecording({included_categories:selected});return {availableAccessibility:available.filter(c=>/accessibility/i.test(c)),selected};})()`);
  tracing = { path: tracePath, ...categories, startedAt: new Date().toISOString(), role: 'profiled-diagnostic-not-ordinary-budget' };
  return tracing;
}
async function stopTrace() {
  assert.ok(tracing, 'No owned trace is running.');
  await main.evaluate(`process.mainModule.require('electron').contentTracing.stopRecording(${JSON.stringify(tracing.path)})`);
  const record = { ...tracing, finishedAt: new Date().toISOString(), identity: await proof(tracing.path) };
  receipt.traces.push(record); tracing = null; return record;
}
async function operation(action) {
  await assertFrozenInputs(); const record = { id: `${prefix}-${++sequence}-${action}`, action, probeMode, status: 'running', startedAt: new Date().toISOString(), profiled: tracing!==null };
  receipt.requests.push(record); await save();
  try {
    record.environmentBefore = await environment();
    const condition = action==='open'||action==='reader'?`document.querySelector('.app-shell')?.dataset.activeMode==='reader'&&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'&&CSS.highlights.get('mermarkd-amber')?.size===500`
      : action==='cards'?`document.querySelectorAll('.react-flow__node').length===200&&document.querySelector('[data-canvas-save]')?.disabled===false`
      : action==='editor'?`Boolean(document.querySelector('.cm-content[contenteditable=true]'))`:undefined;
    const start = performance.now(); await beginMeasurement(record.id, condition);
    if(action==='open') {await click('[data-start-open]');await wait(condition,'full reader ready');}
    else if(['cards','reader','editor'].includes(action)) {await click(`[data-mode="${action}"]`);await wait(condition,`${action} ready`);}
    else if(action==='sample') await new Promise(resolve=>setTimeout(resolve,3000));
    else if(action.startsWith('probe-')) record.probe = await probe(action);
    else if(action==='scroll-tail') await page.evaluate(`document.querySelector('.markdown-body')?.lastElementChild?.scrollIntoView({block:'center',behavior:'instant'})`);
    else throw Error('Unknown measured action.');
    record.performance = await endMeasurement(Boolean(condition)); record.elapsedMs = performance.now()-start;
    record.environmentAfter = await environment(); record.dom = await domState();
    if(record.dom.dirty==='true') throw Error('Unexpected dirty source during a readonly diagnostic.');
    if(record.dom.probe) assert.equal(record.dom.probe.flagsMatch,true,'Diagnostic DOM flags changed; sample invalid.');
    if(record.dom.mode==='reader') {
      assert.equal(record.dom.headings,200);assert.equal(record.dom.hasTail,true);assert.equal(record.dom.highlights,500);
      originalDom ??= record.dom; assert.equal(record.dom.textSha256,originalDom.textSha256);
    }
    await assertFrozenInputs(); record.eligibility = record.profiled?'diagnostic-profiled':
      record.environmentBefore.focused&&record.environmentAfter.focused&&record.environmentBefore.visible&&record.environmentAfter.visible&&
      !record.environmentBefore.minimized&&!record.environmentAfter.minimized&&record.performance.visibility==='visible'?'recorded-focused-diagnostic':'diagnostic-focus-or-visibility-invalid';
    record.status='complete'; return record;
  } catch(error) {record.status='failed';record.error=error.stack??String(error);throw error;}
  finally {record.finishedAt=new Date().toISOString();record.probeModeAfter=probeMode;await writeFile(path.join(qa,record.id+'.json'),JSON.stringify(record,null,2),{flag:'wx'});await save();}
}
async function stop(reason) {
  if(stopped)return;stopped=true;clearTimeout(timer);
  try {if(page&&originalDom&&probeMode!=='product') await page.evaluate(`(()=>{for(const row of window.__qa4Probe?.rows??[]){if(!row.element.isConnected)continue;
    if(row.editable===null)row.element.removeAttribute('contenteditable');else row.element.setAttribute('contenteditable',row.editable);
    if(row.tabIndex===null)row.element.removeAttribute('tabindex');else row.element.setAttribute('tabindex',row.tabIndex);row.expectedEditable=row.editable;row.expectedTabIndex=row.tabIndex;}if(window.__qa4Probe)window.__qa4Probe.mode='product';})()`);
    probeMode='product';if(tracing)await stopTrace();await assertFrozenInputs();receipt.finalDom=page?await domState():null;
    if(receipt.finalDom&&originalDom){assert.equal(receipt.finalDom.textSha256,originalDom.textSha256);assert.equal(receipt.finalDom.hostCount,originalDom.hostCount);assert.equal(receipt.finalDom.probe?.flagsMatch??true,true);}
  } catch(error) {receipt.stopError=error.stack??String(error);}
  server?.close();page?.close();main?.close();
  if(child?.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});}catch{child.kill('SIGKILL');}}
  receipt.status=receipt.stopError?'stopped-with-diagnostic-error':'stopped';receipt.stopReason=reason;receipt.finishedAt=new Date().toISOString();await save();
}

try {
  if(mode==='--fixture-check') {
    assert.equal(sourceBytes.length>5*1024*1024,true);assert.equal(content.split('# Heading ').length-1,200);assert.ok(content.endsWith(tailMarker+'\r\n'));
    await assertFrozenInputs();receipt.status='fixture-check-passed';receipt.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({reportPath,status:receipt.status,sourceBytes:sourceBytes.length}));
  } else {
    child=await spawn(executable,['--inspect=127.0.0.1:25874','--remote-debugging-port=17874',`--user-data-dir=${path.join(workspace,'profile')}`],{cwd:root,stdio:'ignore'});
    main=await connectCdp(25874,t=>t.type==='node');page=await connectCdp(17874,t=>t.type==='page');
    if(receipt.rendererUrl) {const url=new URL(receipt.rendererUrl).href;await page.send('Page.navigate',{url});await wait(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`,'actual Vite page');}
    await wait('Boolean(document.querySelector("[data-start-open]"))','start page');
    await main.evaluate(`(()=>{const w=process.mainModule.require('electron').BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());w.setTitle('MerMarkd QA4 原生辅助查询');w.on('page-title-updated',e=>e.preventDefault());w.setSize(1220,900);})()`);
    await page.send('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false});
    await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(fixture)}]})`);
    await installMeasurements();receipt.initialEnvironment=await environment();receipt.controlToken=randomUUID();receipt.pid=child.pid;receipt.status='ready';await save();
    const commands=new Set(['state','open','cards','reader','editor','sample','probe-readonly-on','probe-readonly-off','probe-one-host','probe-static-focusable','scroll-tail','trace-start','trace-stop','stop']);
    server=createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      if(req.headers.authorization!==`Bearer ${receipt.controlToken}`){res.statusCode=401;res.end('{"error":"Unauthorized diagnostic control"}');return;}
      const action=req.url?.slice(1);if(!commands.has(action)){res.statusCode=404;res.end('{"error":"Unknown diagnostic command"}');return;}
      if(busy){res.statusCode=409;res.end('{"error":"A diagnostic command is already running"}');return;}busy=true;
      try {let result;if(action==='stop'){await stop('requested');result={status:receipt.status};}
        else if(action==='state')result={environment:await environment(),dom:await domState(),probeMode,tracing};
        else if(action==='trace-start')result=await startTrace();else if(action==='trace-stop')result=await stopTrace();else result=await operation(action);
        await save();res.end(JSON.stringify(result));
      }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.stack??String(error)}));}finally{busy=false;}
    });
    server.on('error',error=>{receipt.serverError=error.stack;void stop('server-error');});
    server.listen(18874,'127.0.0.1',()=>console.log(JSON.stringify({reportPath,title:'MerMarkd QA4 原生辅助查询',controlUrl:'http://127.0.0.1:18874/',initialEnvironment:receipt.initialEnvironment})));
    timer=setTimeout(()=>void stop('30-minute-timeout'),30*60*1000);timer.unref();
    process.on('SIGINT',()=>void stop('SIGINT'));process.on('SIGTERM',()=>void stop('SIGTERM'));
  }
} catch(error) {receipt.error=error.stack??String(error);await stop('initialization-error');process.exitCode=1;throw error;}
