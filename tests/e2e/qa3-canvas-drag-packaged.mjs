import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasStateV2, parseCanvasStateV2Json, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

// Run --fixture-check without launching Electron. The default run is an actual
// window diagnostic, not a performance-budget or historical-failure closure.
const mode = process.argv[2] ?? 'run';
assert.ok(['run', '--fixture-check'].includes(mode));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
assert.ok(path.isAbsolute(executable), 'QA executable must be absolute');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'qa3-canvas-drag';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}${mode === '--fixture-check' ? '-fixture-check' : ''}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve earlier evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa3-drag-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = fileURLToPath(import.meta.url);
const result = { kind: 'QA3-canvas-drag-diagnostic', status: 'running', startedAt: new Date().toISOString(), mode,
  executable, rendererUrl: process.env.MERMARKD_QA_RENDERER_URL ?? null, scriptSha256: digest(await readFile(sourcePath)), workspace, cases: [],
  boundary: 'Actual isolated packaged window, real pointer dispatch/renderer/IPC/filesystem. Does not close the retained QA1 drag failure or claim a performance budget. Native source dialog is mocked; no physical IME, installation or hardware acceptance.' };
let child, page, main, launches = 0;
const nodeSelector = '.react-flow__node[data-id="card-0"]';
const headingSelector = `${nodeSelector} .canvas-card-heading strong`;
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;

function expectedPosition(reference, client, geometry) {
  // The source is a root card. Express the grabbed world offset once, then
  // recompute from actual viewport/host transforms, including auto-pan.
  const grab = { x: (reference.client.x - reference.geometry.host.x - reference.geometry.viewport.x) / reference.geometry.viewport.zoom - reference.geometry.position.x,
    y: (reference.client.y - reference.geometry.host.y - reference.geometry.viewport.y) / reference.geometry.viewport.zoom - reference.geometry.position.y };
  return { x: (client.x - geometry.host.x - geometry.viewport.x) / geometry.viewport.zoom - grab.x,
    y: (client.y - geometry.host.y - geometry.viewport.y) / geometry.viewport.zoom - grab.y };
}
function assertPosition(actual, expected, zoom, label) {
  const screenError = { x: (actual.x - expected.x) * zoom, y: (actual.y - expected.y) * zoom };
  assert.ok(Math.abs(screenError.x) <= 1.25 && Math.abs(screenError.y) <= 1.25,
    `${label}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}, screen residual ${JSON.stringify(screenError)}`);
  return screenError;
}
async function seed() {
  const paragraph = '正文 English 😀 ' + 'plain content '.repeat(Math.ceil(5 * 1024 * 1024 / 200 / 14));
  const content = Array.from({ length: 200 }, (_, index) => `# Heading ${index}\r\n\r\n` +
    Array.from({ length: 3 }, (_, marker) => `Marker-${index * 3 + marker} unique 中文😀\r\n\r\n`).join('') + paragraph + '\r\n\r\n').join('');
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes); let id = 0;
  const reconciled = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `card-${id++}`);
  const model = { ...reconciled.model, cards: reconciled.model.cards.map((card, index) => ({ ...card,
    position: { x: 80 + index % 20 * 400, y: 80 + Math.floor(index / 20) * 260 },
    size: { width: 360, height: 224 }, bodyDisplay: 'preview', descendantsCollapsed: false })),
    links: [{ id: 'retained-link', from: 'card-1', to: 'card-2', label: '保留关系' }] };
  const annotations = Array.from({ length: 500 }, (_, index) => {
    const exact = `Marker-${index} unique 中文😀`, start = content.indexOf(exact), startByte = 3 + Buffer.byteLength(content.slice(0, start));
    return { id: `highlight-${index}`, kind: 'highlight', color: 'amber', createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z',
      anchor: { basisSha256: sha256, startByte, endByte: startByte + Buffer.byteLength(exact), sourceExact: exact,
        displayQuote: exact, prefix: Array.from(content.slice(Math.max(0, start - 96), start)).slice(-48).join(''),
        suffix: Array.from(content.slice(start + exact.length, start + exact.length + 96)).slice(0, 48).join('') } };
  });
  const yaml = serializeAnnotationYaml({ schemaVersion: 1, source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations });
  assert.equal(model.cards.length, 200); assert.equal(parseAnnotationYaml(yaml).annotations.length, 500);
  assert.ok(bytes.length >= 5 * 1024 * 1024, 'real large Markdown fixture');
  return { bytes, model, yaml, sha256 };
}
async function fixture(base, name, zoom) {
  const directory = path.join(workspace, name); await mkdir(directory);
  const file = path.join(directory, '拖动诊断.md');
  const model = { ...base.model, viewport: { x: 100, y: 100, zoom } };
  await writeFile(file, base.bytes); await writeFile(file + suffixes[1], base.yaml);
  await writeFile(file + suffixes[2], serializeCanvasStateV2Json(model));
  assert.deepEqual(parseCanvasStateV2Json(await readFile(file + suffixes[2], 'utf8')), model);
  return { file, model, zoom };
}
async function snapshot(file) {
  return Promise.all(suffixes.map(async suffix => {
    const bytes = await readFile(file + suffix), info = await stat(file + suffix);
    return { suffix, bytes: bytes.length, sha256: digest(bytes), mtimeMs: info.mtimeMs };
  }));
}
async function wait(expression, label, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out: ${label}`);
}
const frame = () => page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function geometry() {
  return page.evaluate(`(()=>{const host=document.querySelector('.react-flow'),viewport=document.querySelector('.react-flow__viewport'),node=document.querySelector(${JSON.stringify(nodeSelector)}),heading=document.querySelector(${JSON.stringify(headingSelector)});
    if(!host||!viewport||!node||!heading)throw Error('Missing canvas geometry');
    const h=host.getBoundingClientRect(),r=node.getBoundingClientRect(),s=heading.getBoundingClientRect(),v=new DOMMatrixReadOnly(getComputedStyle(viewport).transform),n=new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return {host:{x:h.x,y:h.y,width:h.width,height:h.height},viewport:{x:v.m41,y:v.m42,zoom:v.a},position:{x:n.m41,y:n.m42},
      rect:{x:r.x,y:r.y,width:r.width,height:r.height},heading:{x:s.x+s.width/2,y:s.y+s.height/2},selected:node.classList.contains('selected'),dragging:node.classList.contains('dragging')};})()`);
}
async function click(selector) {
  const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!(e instanceof HTMLElement)||e.hasAttribute('disabled')||e.closest('[hidden],[inert]'))return null;
    const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
  assert.ok(point, `visible enabled action ${selector}`);
  await pointer('mousePressed', point); await pointer('mouseReleased', point); await frame();
}
async function pointer(type, point, button = 'left') {
  return page.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
    ...(type === 'mouseMoved' ? {} : { button, clickCount: 1 }),
    buttons: type === 'mouseReleased' ? 0 : button === 'middle' ? 4 : 1 });
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { child.kill('SIGKILL'); }
    child = undefined;
  }
}
async function open(item) {
  assert.equal(digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))), result.asarSha256, 'one runtime across all cases');
  const port = 18500 + Math.floor(Math.random() * 350), profile = path.join(workspace, `profile-${++launches}`);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`, `--user-data-dir=${profile}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) {
    const rendererUrl = new URL(process.env.MERMARKD_QA_RENDERER_URL).href;
    await page.send('Page.navigate', { url: rendererUrl });
    await wait(`location.href===${JSON.stringify(rendererUrl)}&&document.readyState==='complete'`, 'requested Vite page loaded');
  }
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start page');
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(item.file)}]})`);
  await click('[data-start-open]');
  await wait(`document.querySelector('.workspace-current-name')?.title.toLowerCase()===${JSON.stringify(item.file.toLowerCase())}&&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'`, 'real requested document ready');
  await click('[data-mode="cards"]'); await idle();
  assert.equal(await page.evaluate('document.querySelectorAll(".react-flow__node").length'), 200);
  const actual = await geometry(); assert.ok(Math.abs(actual.viewport.zoom - item.zoom) < 0.00001, 'saved requested zoom restored');
  return { profile, environment: await main.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());return {execPath:process.execPath,userData:app.getPath('userData'),features:app.getAccessibilitySupportFeatures?.()??null,focused:w?.isFocused(),visible:w?.isVisible(),minimized:w?.isMinimized()};})()`) };
}
async function idle() {
  await wait(`document.querySelector('[data-canvas-save]')?.disabled===false&&!document.querySelector('[data-canvas-flow]')?.inert&&document.querySelector(${JSON.stringify(nodeSelector)})?.classList.contains('draggable')`, 'writable measured canvas and current node projection');
  await frame();
}
async function stableViewport() {
  let previous = await geometry();
  for (let turn = 0; turn < 30; turn++) {
    await frame(); const current = await geometry();
    if (Math.abs(current.viewport.x - previous.viewport.x) < 0.0001 && Math.abs(current.viewport.y - previous.viewport.y) < 0.0001 &&
      Math.abs(current.viewport.zoom - previous.viewport.zoom) < 0.00001) return current;
    previous = current;
  }
  throw Error('Viewport failed to stabilize');
}
async function positionGrab(edge) {
  const before = await geometry(), destination = { x: before.host.x + (edge ? 12 : before.host.width * 0.45), y: before.host.y + before.host.height * 0.45 };
  const offset = { x: destination.x - before.heading.x, y: destination.y - before.heading.y };
  const start = { x: before.host.x + before.host.width * 0.52, y: before.host.y + before.host.height * 0.5 };
  // Middle-button panning is a real supported canvas action. It positions the
  // root at a known screen location without accessing React internals or changing
  // renderer code. Its explicit viewport save is setup, before the drag baseline.
  const end = { x: start.x + offset.x, y: start.y + offset.y };
  assert.ok(end.x > before.host.x && end.x < before.host.x + before.host.width && end.y > before.host.y && end.y < before.host.y + before.host.height, 'setup pan stays inside host');
  await pointer('mousePressed', start, 'middle');
  for (let step = 1; step <= 6; step++) { await pointer('mouseMoved', { x: start.x + offset.x * step / 6, y: start.y + offset.y * step / 6 }, 'middle'); await frame(); }
  await pointer('mouseReleased', end, 'middle'); await idle();
  const after = await stableViewport();
  assert.ok(Math.abs(after.heading.x - destination.x) < 2 && Math.abs(after.heading.y - destination.y) < 2, 'setup pan reaches target');
  return after;
}
async function startTrace() {
  await page.evaluate(`(()=>{
    window.__qa3DragCleanup?.();
    const t=window.__qa3DragTrace={events:[],frames:[],mutations:[],started:performance.now(),overflow:false};let raf;
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    const capture=()=>{const v=document.querySelector('.react-flow__viewport'),n=document.querySelector(${JSON.stringify(nodeSelector)}),host=document.querySelector('.react-flow');
      if(!v||!n||!host)return null;const m=new DOMMatrixReadOnly(getComputedStyle(v).transform),p=new DOMMatrixReadOnly(getComputedStyle(n).transform);
      return {at:performance.now(),viewport:{x:m.m41,y:m.m42,zoom:m.a},position:{x:p.m41,y:p.m42},host:rect(host),rect:rect(n),selected:n.classList.contains('selected'),dragging:n.classList.contains('dragging')};};
    const store=(array,row)=>{if(array.length<3000)array.push(row);else t.overflow=true;};
    const events=['pointerdown','pointermove','pointerup','pointercancel','mousedown','mousemove','mouseup','lostpointercapture'];
    const listener=e=>store(t.events,{type:e.type,at:performance.now(),timeStamp:e.timeStamp,x:e.clientX,y:e.clientY,buttons:e.buttons,button:e.button,pointerId:e.pointerId??null,isTrusted:e.isTrusted,target:e.target?.closest?.('.react-flow__node')?.dataset.id??null,geometry:capture()});
    events.forEach(name=>document.addEventListener(name,listener,true));
    const observer=new MutationObserver(rows=>store(t.mutations,{at:performance.now(),changes:rows.map(row=>({target:row.target.className,attribute:row.attributeName,old:row.oldValue,value:row.target.getAttribute(row.attributeName)})),geometry:capture()}));
    [document.querySelector('.react-flow__viewport'),document.querySelector(${JSON.stringify(nodeSelector)})].forEach(e=>observer.observe(e,{attributes:true,attributeFilter:['class','style'],attributeOldValue:true}));
    const tick=()=>{store(t.frames,capture());raf=requestAnimationFrame(tick);};raf=requestAnimationFrame(tick);
    window.__qa3DragCleanup=()=>{cancelAnimationFrame(raf);observer.disconnect();events.forEach(name=>document.removeEventListener(name,listener,true));t.finished=performance.now();};
  })()`);
}
async function endTrace() { return page.evaluate('window.__qa3DragCleanup?.();window.__qa3DragTrace??null'); }
async function screenshot(name) {
  const filename = path.join(qa, `${prefix}-${name}.png`), capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(filename, Buffer.from(capture.data, 'base64'), { flag: 'wx' }); return filename;
}
async function runCase(base, zoom, selected, edge) {
  const name = `${edge ? 'edge-autopan' : 'central'}-${zoom}-${selected ? 'selected' : 'unselected'}`;
  const record = { name, zoom, selected, edge, status: 'running', startedAt: new Date().toISOString(), requests: [], checkpoints: [] }; result.cases.push(record);
  let item, before, trace;
  try {
    item = await fixture(base, name, zoom); record.documentPath = item.file; Object.assign(record, await open(item));
    await positionGrab(edge);
    if (selected) await click(headingSelector);
    else {
      const blank = await page.evaluate(`(()=>{const host=document.querySelector('.react-flow').getBoundingClientRect();
        for(const offset of [20,40,60,80]){const x=host.x+offset,y=host.y+offset,e=document.elementFromPoint(x,y);
          if(e?.classList.contains('react-flow__pane'))return {x,y};}return null;})()`);
      assert.ok(blank, 'setup has a visible empty pane point');
      await pointer('mousePressed', blank); await pointer('mouseReleased', blank); await frame();
    }
    await idle();
    const initial = await stableViewport(); assert.equal(initial.selected, selected, 'selection precondition');
    const point = initial.heading;
    assert.equal(await page.evaluate(`document.elementFromPoint(${point.x},${point.y})?.closest('.react-flow__node')?.dataset.id`), 'card-0', 'visible intended grab point');
    before = await snapshot(item.file); record.beforeFiles = before;
    record.modelBefore = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.ok(record.modelBefore); await startTrace();
    const send = async (type, p) => { record.requests.push({ type, ...p, at: new Date().toISOString() }); await pointer(type, p); };
    await send('mousePressed', point);
    // Cross React Flow's drag threshold before establishing the reference. The
    // first threshold movement is intentionally not counted as pointer travel.
    const primed = { x: point.x + 3, y: point.y };
    await send('mouseMoved', primed); await frame();
    await wait(`document.querySelector(${JSON.stringify(nodeSelector)})?.classList.contains('dragging')`, 'drag started');
    const reference = { client: primed, geometry: await geometry() }; record.reference = reference;
    const thresholdTravel = Math.hypot(primed.x - point.x, primed.y - point.y);
    const thresholdNodeTravel = Math.hypot(reference.geometry.rect.x - initial.rect.x, reference.geometry.rect.y - initial.rect.y);
    assert.ok(thresholdNodeTravel <= thresholdTravel + 1.25, 'crossing the drag threshold cannot hide a larger initial node jump');
    let endpoint = primed;
    if (edge) {
      endpoint = { x: primed.x - 1, y: primed.y };
      await send('mouseMoved', endpoint);
      for (let turn = 0; turn < 8; turn++) { await frame(); record.checkpoints.push({ kind: 'edge-hold', geometry: await geometry() }); }
    } else {
      for (let step = 1; step <= 6; step++) {
        endpoint = { x: primed.x - 4 * step, y: primed.y - 2 * step };
        await send('mouseMoved', endpoint); await frame(); const current = await geometry();
        const expected = expectedPosition(reference, endpoint, current);
        record.checkpoints.push({ kind: 'central-step', client: endpoint, geometry: current, expected,
          residual: assertPosition(current.position, expected, current.viewport.zoom, `step ${step}`) });
        assert.ok(Math.abs(current.viewport.x - reference.geometry.viewport.x) < 0.0001 &&
          Math.abs(current.viewport.y - reference.geometry.viewport.y) < 0.0001, 'central drag does not auto-pan');
      }
    }
    await send('mouseReleased', endpoint); await idle();
    const final = await stableViewport(), expected = expectedPosition(reference, endpoint, final);
    record.final = final; record.expected = expected; record.residual = assertPosition(final.position, expected, final.viewport.zoom, 'final rendered position');
    if (edge) assert.ok(Math.abs(final.viewport.x - reference.geometry.viewport.x) > 2, 'edge case actually exercises auto-pan');
    const current = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model; record.modelAfter = current;
    assert.ok(current); assertPosition(current.cards.find(card => card.id === 'card-0').position, expected, final.viewport.zoom, 'persisted position');
    assert.deepEqual(current.cards.filter(card => card.id !== 'card-0'), record.modelBefore.cards.filter(card => card.id !== 'card-0'), '199 unrelated cards preserve all fields');
    assert.deepEqual(current.links, record.modelBefore.links); assert.deepEqual(current.source, record.modelBefore.source);
    record.afterFiles = await snapshot(item.file); assert.deepEqual(record.afterFiles.slice(0, 2), before.slice(0, 2), 'Markdown and YAML retain bytes and mtime');
    assert.notEqual(record.afterFiles[2].sha256, before[2].sha256, 'drag changes canvas data');
    trace = await endTrace(); assert.equal(trace.overflow, false, 'all diagnostic samples retained');
    const requestedMoves = record.requests.filter(row => row.type === 'mouseMoved');
    for (const event of trace.events.filter(row => row.type === 'mousemove' && row.buttons === 1)) {
      assert.ok(requestedMoves.some(row => Math.abs(row.x - event.x) <= 1.25 && Math.abs(row.y - event.y) <= 1.25),
        `unexpected native/input movement: ${event.x},${event.y}; preserve evidence instead of attributing it to the product`);
    }
    assert.ok(trace.events.some(row => row.type === 'pointerdown') && trace.events.some(row => row.type === 'pointerup'), 'real pointer events recorded');
    record.screenshot = await screenshot(name); record.status = 'passed'; console.log(`passed: ${name}`);
  } catch (error) {
    record.status = 'failed'; record.error = error.stack ?? String(error); console.log(`failed: ${name}: ${error.message}`);
    if (page) { record.failureGeometry = await geometry().catch(() => null); record.screenshot = await screenshot(`${name}-failure`).catch(() => null); }
  } finally {
    if (page) trace ??= await endTrace().catch(() => null);
    if (item && before) {
      record.finalFiles ??= await snapshot(item.file).catch(() => null);
      try { record.persistedModel = parseCanvasStateV2Json(await readFile(item.file + suffixes[2], 'utf8')); }
      catch (error) { record.persistedModelError = error.message; }
    }
    const tracePath = path.join(qa, `${prefix}-${name}-trace.json`);
    await writeFile(tracePath, JSON.stringify({ ...record, trace }, null, 2), { flag: 'wx' });
    record.traceArtifact = { path: tracePath, sha256: digest(await readFile(tracePath)) };
    // Keep the summary small; the immutable trace contains the complete models,
    // requests, frame/DOM evidence, file snapshots, and partial failure state.
    delete record.modelBefore; delete record.modelAfter; delete record.persistedModel; delete record.requests; delete record.checkpoints;
    record.finishedAt = new Date().toISOString(); await stop();
  }
}
async function cleanupWorkspace() {
  const actual = await realpath(workspace), temporary = await realpath(os.tmpdir());
  assert.ok(key(actual).startsWith(key(temporary) + path.sep) && path.basename(actual).startsWith('mermarkd-qa3-drag-'), 'cleanup remains inside owned temporary directory');
  await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
try {
  const base = await seed();
  result.fixture = { bytes: base.bytes.length, sha256: base.sha256, cards: base.model.cards.length, highlights: parseAnnotationYaml(base.yaml).annotations.length };
  if (mode === '--fixture-check') {
    for (const zoom of [0.11, 1, 2]) await fixture(base, `fixture-${zoom}`, zoom);
    const reference = { client: { x: 300, y: 250 }, geometry: { host: { x: 100, y: 50 }, viewport: { x: 20, y: 30, zoom: 0.5 }, position: { x: 80, y: 100 } } };
    assert.deepEqual(expectedPosition(reference, { x: 312, y: 244 }, reference.geometry), { x: 104, y: 88 });
    assert.deepEqual(expectedPosition(reference, reference.client, { ...reference.geometry, viewport: { x: 30, y: 10, zoom: 0.5 } }), { x: 60, y: 140 });
    result.status = 'passed';
  } else {
    result.asarSha256 = digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar')));
    for (const zoom of [0.11, 1, 2]) for (const selected of [false, true]) await runCase(base, zoom, selected, false);
    for (const zoom of [0.11, 1, 2]) await runCase(base, zoom, false, true);
    result.status = result.cases.length === 9 && result.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  }
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stop(); result.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') await cleanupWorkspace();
  else console.log(`QA3 fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
console.log(`${mode === '--fixture-check' ? 'Fixture check' : 'Canvas drag diagnostic'} passed: ${reportPath}`);
