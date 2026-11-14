import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileCanvasStateV2, projectCanvasStateV2ToV1, migrateCanvasStateV1ToV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { extractSections } from '../../src/core/sections.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'qa2-layout-recovery';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/, 'the artifact prefix is a single filename component');
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve previous acceptance evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa2-layout-'));
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const viewport = { x: 210, y: 120, zoom: 0.65 };
const sourceSingle = '# 原点章节\r\n\r\n保留中文与 emoji 😀。\r\n';
const sourceMulti = '# 第一根章节\r\n\r\n第一章正文。\r\n\r\n## 折叠子章节\r\n\r\n子章节正文。\r\n\r\n# 第二根章节\r\n\r\n第二章正文。\r\n\r\n# 第三根章节\r\n\r\n第三章正文。\r\n';
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  asarSha256: createHash('sha256').update(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))).digest('hex'),
  cases: [], boundary: 'Actual packaged canvas geometry and persistence; no source or annotation writes during passive recovery.' };
let child, page, main;
let launchCount = 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function snapshot(file) {
  return Promise.all(suffixes.map(async suffix => {
    try {
      const bytes = await readFile(file + suffix), info = await stat(file + suffix);
      return { suffix, bytes: bytes.toString('base64'), sha256: digest(bytes), mtimeMs: info.mtimeMs };
    } catch (error) { if (error.code !== 'ENOENT') throw error; return { suffix, missing: true }; }
  }));
}
async function wait(expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out waiting for ${label}`);
}
async function frame() { await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function screenshot(name) {
  const file = path.join(qa, `${prefix}-${name}.png`);
  const capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' });
  return file;
}
async function click(selector) {
  assert.equal(await page.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!(node instanceof HTMLElement)||node.hasAttribute('disabled')||node.closest('[hidden],[inert]'))return false;node.click();return true;})()`), true,
    `enabled visible action ${selector}`);
  await frame();
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } child = undefined; }
}
async function open(file) {
  const port = 18100 + Math.floor(Math.random() * 250);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`,
    `--user-data-dir=${path.join(workspace, `profile-${++launchCount}`)}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page');
  main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start page');
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]})`);
  await click('[data-start-open]');
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}`, 'document open');
  await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"', 'complete reading analysis');
  await click('[data-mode="cards"]'); await ready();
}
async function ready() {
  await wait('Boolean(document.querySelector("[data-canvas-view]")) && document.querySelector("[data-canvas-save]")?.disabled===false', 'measured writable canvas');
  await frame();
}
async function geometry() {
  return page.evaluate(`(()=>{const matrix=e=>{const m=new DOMMatrixReadOnly(e.style.transform);return {x:m.m41,y:m.m42,zoom:m.a};};
    const nodes=[...document.querySelectorAll('.react-flow__node')], bounds=document.querySelector('.react-flow').getBoundingClientRect();return {
    viewport:matrix(document.querySelector('.react-flow__viewport')),
    visibleCardCount:nodes.filter(node=>{const rect=node.getBoundingClientRect();return rect.right>bounds.left&&rect.left<bounds.right&&rect.bottom>bounds.top&&rect.top<bounds.bottom;}).length,
    cards:nodes.map(node=>{const body=node.querySelector('.canvas-card-body');return {id:node.dataset.id,
      x:matrix(node).x,y:matrix(node).y,width:parseFloat(node.style.width),height:parseFloat(node.style.height),
      bodyWidth:parseFloat(body.style.width),bodyHeight:parseFloat(body.style.height)};}),
    edges:[...document.querySelectorAll('.react-flow__edge')].map(edge=>({id:edge.dataset.id,label:edge.getAttribute('aria-label'),text:edge.textContent}))};})()`);
}
async function fixture(name, version, kind, { missing = false, added = false, folded = kind === 'negative', savedViewport = viewport } = {}) {
  const content = kind === 'single' ? sourceSingle : sourceMulti;
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes);
  let id = 0;
  const reconciled = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `card-${id++}`);
  const initial = reconciled.model;
  const positions = initial.cards.map((_, index) => kind !== 'negative' ? { x: 0, y: 0 }
    : index === 1 ? { x: 48, y: 240 } : { x: -180 + index * 38, y: -60 + index * 5 });
  const model = { ...initial, cards: initial.cards.map((card, index) => ({ ...card, position: positions[index],
    descendantsCollapsed: folded && index === 0 && initial.cards.length > 1, bodyDisplay: 'preview',
    size: { width: 400, height: 224 } })), viewport: savedViewport,
    links: initial.cards.length > 1 ? [{ id: 'retained-link', from: 'card-1', to: 'card-2', label: '保存的章节关系' }] : [] };
  const file = path.join(workspace, name + '.md');
  await writeFile(file, added ? Buffer.from('\ufeff' + content + '\r\n# 新增章节\r\n\r\n新章节正文。\r\n') : bytes);
  await writeFile(file + '.annotations.yaml', serializeAnnotationYaml({ schemaVersion: 1,
    source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] }));
  if (!missing) await writeFile(file + '.mermarkd.json', version === 1
    ? serializeCanvasJson(projectCanvasStateV2ToV1(model)) : serializeCanvasStateV2Json(model));
  const expectedDisk = version === 1 ? migrateCanvasStateV1ToV2(projectCanvasStateV2ToV1(model)) : model;
  return { name, file, version, model, positions, single: initial.cards.length === 1, expectedDisk,
    scene: buildCanvasSceneV2(content, extractSections(content), expectedDisk, reconciled.bindings) };
}
async function assertRestored(fixture, baseline, phase, { fitted = false } = {}) {
  const actual = await geometry();
  const expected = fixture.scene.cards.filter(card => !card.hidden).map(card => ({ id: card.id, ...card.position,
    width: card.width, height: card.height, bodyWidth: card.size.width, bodyHeight: card.size.height }));
  assert.deepEqual(actual.cards.sort((a, b) => a.id.localeCompare(b.id)), expected.sort((a, b) => a.id.localeCompare(b.id)), `${phase}: rendered positions and dimensions preserve saved presentation`);
  if (fitted) {
    assert.notDeepEqual(actual.viewport, fixture.model.viewport, `${phase}: stale viewport is temporarily replaced`);
    assert.ok(Object.values(actual.viewport).every(Number.isFinite) && actual.viewport.zoom > 0, `${phase}: temporary viewport is valid`);
    assert.ok(actual.visibleCardCount > 0, `${phase}: temporary fit brings an actual card into the canvas bounds`);
  } else for (const key of ['x', 'y', 'zoom']) assert.ok(Math.abs(actual.viewport[key] - fixture.model.viewport[key]) < 0.00001, `${phase}: valid saved viewport ${key} is restored`);
  assert.equal(actual.edges.length, fixture.single ? 0 : 1, `${phase}: saved relationship remains visible`);
  if (!fixture.single) {
    assert.equal(actual.edges[0].id, 'retained-link');
    assert.equal(actual.edges[0].label, `Edge from ${fixture.scene.links[0].from} to ${fixture.scene.links[0].to}`, `${phase}: relationship keeps its scene endpoints`);
    assert.equal(actual.edges[0].text.includes('隐藏端点'), fixture.scene.links[0].hiddenEndpoint, `${phase}: folded source keeps its ancestor projection`);
  }
  const loaded = await page.evaluate('window.mermarkd.loadCanvasV2()');
  const expectedDisk = fixture.expectedDisk;
  assert.equal(loaded.sourceVersion, fixture.version);
  assert.deepEqual(loaded.model, expectedDisk, `${phase}: disk model retains coordinates, fold, endpoint identity, dimensions and viewport`);
  assert.deepEqual(await snapshot(fixture.file), baseline, `${phase}: passive recovery preserves all three bytes/mtime snapshots`);
  return actual;
}
async function scenario(name, run) {
  const record = { name, status: 'running' }; result.cases.push(record);
  try { Object.assign(record, await run()); record.status = 'passed'; }
  catch (error) {
    record.status = 'failed'; record.error = error.stack;
    if (page) record.actual = await geometry().catch(() => null);
    console.log(`failed: ${name}: ${error.message}`);
  } finally { await stop(); }
  console.log(`${record.status}: ${name}`);
}

try {
  for (const version of [1, 2]) for (const kind of ['single', 'overlap', 'negative']) {
    await scenario(`v${version}-${kind}`, async () => {
      const item = await fixture(`v${version}-${kind}`, version, kind), before = await snapshot(item.file);
      await open(item.file); const opened = await assertRestored(item, before, 'open');
      const image = version === 2 && kind !== 'single' ? await screenshot(`v2-${kind}`) : undefined;
      await click('[data-mode="editor"]'); await wait('Boolean(__sourceControl())', 'source view');
      await click('[data-mode="reader"]'); await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"', 'reader return');
      await click('[data-mode="cards"]'); await ready(); await assertRestored(item, before, 'mode roundtrip');
      await stop(); await open(item.file); await assertRestored(item, before, 'fresh process reopen');
      return { opened, screenshot: image, passiveSnapshotsUnchanged: true, modeRoundtrip: true, processReopen: true };
    });
  }
  await scenario('stale-viewport-passive-fit', async () => {
    const item = await fixture('stale-viewport', 2, 'negative', { savedViewport: { x: 90000, y: 90000, zoom: 0.65 } });
    const before = await snapshot(item.file);
    await open(item.file); const opened = await assertRestored(item, before, 'open', { fitted: true });
    await click('[data-mode="reader"]'); await wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"', 'reader return');
    await click('[data-mode="cards"]'); await ready(); await assertRestored(item, before, 'mode roundtrip', { fitted: true });
    await stop(); await open(item.file); await assertRestored(item, before, 'fresh process reopen', { fitted: true });
    return { opened, coordinatesRetained: true, temporaryFitVisible: true, threeFilesUnchanged: true };
  });
  await scenario('missing-sidecar-initialization', async () => {
    const item = await fixture('missing-sidecar', 2, 'overlap', { missing: true }), before = await snapshot(item.file);
    await open(item.file); const actual = await geometry();
    assert.equal(actual.cards.length, 4, 'missing sidecar initializes all chapters with no inherited fold');
    assert.ok(new Set(actual.cards.map(card => `${card.x},${card.y}`)).size > 1, 'missing layout receives an actual arrangement');
    assert.deepEqual(await snapshot(item.file), before, 'initial arrangement does not create or write a sidecar without save');
    await click('[data-canvas-save]'); await wait('document.querySelector("[data-canvas-status]")?.textContent.includes("画布已保存")', 'explicit initial save');
    const after = await snapshot(item.file); assert.deepEqual(after.slice(0, 2), before.slice(0, 2)); assert.equal(after[2].missing, undefined);
    return { initialized: true, explicitSaveCreatesCanvasOnly: true };
  });
  await scenario('new-chapter-initialization', async () => {
    const item = await fixture('new-chapter', 2, 'overlap', { added: true }), before = await snapshot(item.file);
    await open(item.file); const actual = await geometry();
    assert.equal(actual.cards.length, 5, 'all original chapters plus a newly initialized root');
    assert.ok(new Set(actual.cards.map(card => `${card.x},${card.y}`)).size > 1, 'a new chapter still requests arrangement');
    assert.deepEqual(await snapshot(item.file), before, 'source version reconciliation remains passive until explicit save');
    return { newChapterArranged: true, threeFilesUnchanged: true };
  });
  await scenario('new-chapter-with-collapsed-parent', async () => {
    const item = await fixture('folded-new-chapter', 2, 'overlap', { added: true, folded: true }), before = await snapshot(item.file);
    await open(item.file); const actual = await geometry();
    assert.equal(actual.cards.length, 4, 'the new root initializes while the saved child remains folded');
    assert.equal(actual.cards.some(card => card.id === 'card-1'), false, 'initialization does not expose the hidden child merely to measure it');
    assert.ok(new Set(actual.cards.map(card => `${card.x},${card.y}`)).size > 1, 'all visible roots receive an arrangement');
    assert.equal(actual.edges[0]?.label, 'Edge from card-0 to card-2', 'folded relationship keeps the visible ancestor projection');
    assert.deepEqual(await snapshot(item.file), before, 'initializing a new chapter with a saved fold writes none of the three files');
    return { newChapterArranged: true, foldRetained: true, hiddenEndpointProjected: true, threeFilesUnchanged: true };
  });
  await scenario('explicit-auto-arrange', async () => {
    const item = await fixture('explicit-arrange', 2, 'overlap', { folded: true }), before = await snapshot(item.file);
    await open(item.file); await click('[data-canvas-arrange]');
    await wait('document.querySelector("[data-canvas-save]")?.disabled===false && document.querySelector("[data-canvas-status]")?.textContent.includes("画布已保存")', 'explicit arrangement saved');
    const loaded = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.notDeepEqual(loaded.cards.map(card => card.position), item.model.cards.map(card => card.position), 'the explicit command can replace an overlapping layout');
    const withoutPosition = cards => cards.map(({ position, ...card }) => card);
    assert.deepEqual(withoutPosition(loaded.cards), withoutPosition(item.model.cards), 'arrangement preserves dimensions, content mode, anchors and folds');
    assert.deepEqual(loaded.links, item.model.links); assert.deepEqual(loaded.source, item.model.source);
    assert.deepEqual((await snapshot(item.file)).slice(0, 2), before.slice(0, 2), 'explicit arrangement writes neither Markdown nor YAML');
    const saved = await snapshot(item.file); await stop(); await open(item.file);
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model, loaded, 'explicitly arranged model survives reopening');
    assert.deepEqual(await snapshot(item.file), saved, 'reopening the explicit result has no additional writes');
    return { explicitArrangeSaved: true, stableReopen: true };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack; }
finally {
  await stop(); result.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = path.resolve(workspace), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('mermarkd-qa2-layout-'), 'cleanup stays in the generated temporary test directory');
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`QA2 fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
