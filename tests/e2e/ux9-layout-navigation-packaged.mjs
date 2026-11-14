import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasStateV2, projectCanvasStateV2ToV1, migrateCanvasStateV1ToV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { extractSections } from '../../src/core/sections.ts';
import { buildCanvasSceneV2 } from '../../src/core/canvas-scene-v2.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'ux9-layout-navigation';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/, 'artifact prefix is one filename component');
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve prior acceptance evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux9-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const viewport = { x: 205, y: 92, zoom: 0.5 };
const source = ['# 第一根章节', '', '第一根正文。'.repeat(100), '', '## 同名标题', '', '第一处同名正文。'.repeat(100), '',
  '# 第二根章节', '', '第二根正文。'.repeat(100), '', '## 同名标题', '', '第二处同名正文。'.repeat(100), '',
  '# 同名标题', '', '第三处同名正文。'.repeat(100), '', ''].join('\r\n');
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  asarSha256: digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))),
  cases: [], boundary: 'Real renderer geometry, document navigation and separate-file persistence. No native IME, AX client, performance or installation acceptance.' };
let child, page, main, launchCount = 0;
const nodeFor = id => `.react-flow__node[data-id="${id}"]`;
const searchInput = '[data-canvas-search-input]';
const searchStatus = '[data-canvas-search-status]';

async function snapshot(file) {
  return Promise.all(suffixes.map(async suffix => {
    try { const bytes = await readFile(file + suffix), info = await stat(file + suffix);
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
  const diagnostic = await page.evaluate(`({mode:document.querySelector('.app-shell')?.dataset.activeMode,
    text:document.body.innerText.slice(0,1600),active:document.activeElement?.outerHTML.slice(0,300)})`).catch(() => null);
  throw Error(`Timed out: ${label}; ${JSON.stringify(diagnostic)}`);
}
const frame = () => page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
async function click(selector) {
  const point = await page.evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});
    if(!(element instanceof HTMLElement)||element.hasAttribute('disabled')||element.closest('[hidden],[inert]'))return null;
    element.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});
    const r=element.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    return r.width&&r.height&&element.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
  assert.ok(point, `visible enabled control at pointer: ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await frame();
}
async function activate(selector) {
  assert.equal(await page.evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});
    if(!(node instanceof HTMLElement)||node.hasAttribute('disabled')||node.closest('[hidden],[inert]'))return false;node.click();return true;})()`), true,
    `available action: ${selector}`);
  await frame();
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
  await frame();
}
async function screenshot(name) {
  const file = path.join(qa, `${prefix}-${name}.png`);
  const capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' }); return file;
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } child = undefined; }
}
async function open(file, cards = true) {
  const port = 18500 + Math.floor(Math.random() * 250);
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
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}`, 'document opened');
  await readerReady();
  if (cards) { await click('[data-mode="cards"]'); await ready(); }
}
const readerReady = () => wait('document.querySelector("[data-reading-analysis]")?.dataset.readingAnalysis==="ready"', 'complete reading projection');
async function ready() {
  await wait('Boolean(document.querySelector("[data-canvas-view]")) && document.querySelector("[data-canvas-save]")?.disabled===false', 'measured writable canvas');
  await frame();
}
async function geometry() {
  return page.evaluate(`(()=>{const matrix=e=>{const m=new DOMMatrixReadOnly(e.style.transform);return {x:m.m41,y:m.m42,zoom:m.a};};return {
    viewport:matrix(document.querySelector('.react-flow__viewport')),
    cards:[...document.querySelectorAll('.react-flow__node')].map(node=>{const body=node.querySelector('.canvas-card-body');return {id:node.dataset.id,
      x:matrix(node).x,y:matrix(node).y,width:parseFloat(node.style.width),height:parseFloat(node.style.height),
      contentX:parseFloat(body.style.left),contentY:parseFloat(body.style.top),bodyWidth:parseFloat(body.style.width),bodyHeight:parseFloat(body.style.height)};}),
    edges:[...document.querySelectorAll('.react-flow__edge')].map(edge=>({id:edge.dataset.id,label:edge.getAttribute('aria-label'),text:edge.textContent}))};})()`);
}
const presentation = card => ({ id: card.id, position: card.position, contentPosition: card.contentPosition,
  size: card.size, bodyDisplay: card.bodyDisplay, descendantsCollapsed: card.descendantsCollapsed });
const orderedPresentation = cards => cards.map(presentation).sort((a, b) => a.id.localeCompare(b.id));
function sceneWorldPosition(card, cards) {
  const byId = new Map(cards.map(item => [item.id, item]));
  const position = { ...card.position }, visited = new Set([card.id]);
  let parent = card.parentId ? byId.get(card.parentId) : undefined;
  while (parent) {
    assert.equal(visited.has(parent.id), false, 'scene hierarchy used for expected world geometry is acyclic');
    visited.add(parent.id); position.x += parent.position.x; position.y += parent.position.y;
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return position;
}
async function fixture(name, { version = 2, addition = '', folded = false } = {}) {
  const bytes = Buffer.from('\ufeff' + source), sha256 = digest(bytes); let id = 0;
  const reconciled = await reconcileCanvasStateV2(null, { bytes, content: source, sha256 }, () => `card-${id++}`);
  const positions = [{ x: -180, y: -45 }, { x: 52, y: 326 }, { x: 950, y: 92 }, { x: 44, y: 305 }, { x: 1650, y: 48 }];
  const model = { ...reconciled.model,
    cards: reconciled.model.cards.map((card, index) => ({ ...card, position: positions[index],
      contentPosition: { x: 24 + index * 2, y: 44 + index * 3 }, size: { width: 360 + index * 12, height: 224 + index * 8 },
      bodyDisplay: index === 4 ? 'full' : 'preview', descendantsCollapsed: folded && index === 2 })),
    viewport, links: [{ id: 'retained-link', from: 'card-3', to: 'card-4', label: '保留的同名章节关系' }] };
  const expected = version === 1 ? migrateCanvasStateV1ToV2(projectCanvasStateV2ToV1(model)) : model;
  const added = addition === 'root' ? `${source}# 新增根章节\r\n\r\n新根正文。\r\n\r\n`
    : addition === 'nested' ? source.replace('# 第二根章节', '## 新增子章节\r\n\r\n新增子节正文。\r\n\r\n# 第二根章节')
      : addition === 'folded-child' ? source.replace('# 同名标题\r\n\r\n第三处', '## 新增隐藏子章节\r\n\r\n新增隐藏正文。\r\n\r\n# 同名标题\r\n\r\n第三处')
        : addition === 'subtree' ? `${source}# 新增根章节\r\n\r\n新根正文。\r\n\r\n## 新增后代\r\n\r\n新后代正文。\r\n\r\n`
          : addition === 'unresolved-tail' ? `${source}\r\n# 新增根章节\r\n\r\n新根正文。\r\n\r\n` : source;
  const candidateBytes = Buffer.from('\ufeff' + added); let newId = 0;
  const candidate = await reconcileCanvasStateV2(expected, { bytes: candidateBytes, content: added, sha256: digest(candidateBytes) }, () => `new-${newId++}`);
  if (addition === 'unresolved-tail') assert.deepEqual(candidate.unresolvedCardIds, ['card-4'], 'fixture has one deliberately unmatched tail, not a silent rematch');
  else assert.deepEqual(candidate.unresolvedCardIds, [], 'ordinary addition fixtures retain exact old direct-content identities');
  const file = path.join(workspace, `${name}.md`);
  await writeFile(file, Buffer.from('\ufeff' + added));
  await writeFile(file + '.annotations.yaml', serializeAnnotationYaml({ schemaVersion: 1,
    source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] }));
  await writeFile(file + '.mermarkd.json', version === 1 ? serializeCanvasJson(projectCanvasStateV2ToV1(model)) : serializeCanvasStateV2Json(model));
  return { file, expected, addition, folded, version, content: added,
    oldScene: buildCanvasSceneV2(source, extractSections(source), expected, reconciled.bindings) };
}
async function assertKnownGeometry(item, label) {
  const actual = await geometry();
  for (const old of item.oldScene.cards.filter(card => !card.hidden)) {
    const found = actual.cards.find(card => card.id === old.id); assert.ok(found, `${label}: known card ${old.id} remains mounted`);
    const expectedWorld = sceneWorldPosition(old, item.oldScene.cards);
    assert.deepEqual([found.x, found.y], [expectedWorld.x, expectedWorld.y], `${label}: known group keeps its world coordinates; persisted relative coordinates are checked on save`);
    const body = item.oldScene.contents.find(content => content.cardId === old.id);
    assert.deepEqual([found.contentX, found.contentY, found.bodyWidth, found.bodyHeight], [body.position.x, body.position.y, body.width, body.height],
      `${label}: independent body position, dimensions and content mode remain`);
    assert.ok(found.width >= old.width && found.height >= old.height, `${label}: derived bounds may grow to include newly visible children`);
  }
  for (const old of item.oldScene.cards.filter(card => card.hidden)) assert.equal(actual.cards.some(card => card.id === old.id), false, `${label}: known folded child stays hidden`);
  assert.equal(actual.edges[0]?.id, 'retained-link');
  assert.equal(actual.edges[0]?.label, item.folded ? 'Edge from card-2 to card-4' : 'Edge from card-3 to card-4', `${label}: link identity and folded endpoint projection remain`);
  assert.match(actual.edges[0]?.text ?? '', /保留的同名章节关系/);
  for (const field of ['x', 'y', 'zoom']) assert.ok(Math.abs(actual.viewport[field] - viewport[field]) < 0.00001, `${label}: known viewport ${field} is retained`);
  return actual;
}
async function boundaryFixture() {
  const content = ['# 边界一', '', '第一边界正文。', '', '# 边界二', '', '第二边界正文。', '',
    '# 边界三', '', '第三边界正文。', '', '# 边界四', '', '第四边界正文。', '', ''].join('\r\n');
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes); let id = 0;
  const initial = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `corner-${id++}`);
  const positions = [{ x: -1_000_000, y: -1_000_000 }, { x: 1_000_000, y: -1_000_000 },
    { x: -1_000_000, y: 1_000_000 }, { x: 1_000_000, y: 1_000_000 }];
  const model = { ...initial.model, cards: initial.model.cards.map((card, index) => ({ ...card, position: positions[index],
    contentPosition: { x: 24, y: 44 }, size: { width: 384, height: 224 }, bodyDisplay: 'preview', descendantsCollapsed: false })),
    viewport: { x: 500_000, y: 500_000, zoom: 0.5 },
    links: [{ id: 'boundary-link', from: 'corner-0', to: 'corner-3', label: '坐标边界关系' }] };
  const added = content + '# 新增边界根章节\r\n\r\n新增正文。\r\n\r\n';
  const candidateBytes = Buffer.from('\ufeff' + added);
  const reconciled = await reconcileCanvasStateV2(model, { bytes: candidateBytes, content: added, sha256: digest(candidateBytes) }, () => 'new-boundary');
  assert.deepEqual(reconciled.unresolvedCardIds, [], 'boundary failure is placement exhaustion, not an identity mismatch');
  const file = path.join(workspace, 'exhausted-coordinate-bounds.md');
  await writeFile(file, candidateBytes);
  await writeFile(file + '.mermarkd.json', serializeCanvasStateV2Json(model));
  await writeFile(file + '.annotations.yaml', serializeAnnotationYaml({ schemaVersion: 1,
    source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] }));
  return { file, model, expectedKnown: reconciled.model.cards.filter(card => model.cards.some(old => old.id === card.id)) };
}
async function scenario(name, run) {
  const record = { name, status: 'running' }; result.cases.push(record);
  try { Object.assign(record, await run()); record.status = 'passed'; }
  catch (error) { record.status = 'failed'; record.error = error.stack;
    if (page) { record.actual = await geometry().catch(() => null); await screenshot(`${name}-failure`).catch(() => {}); }
  } finally { await stop(); }
  console.log(`${record.status}: ${name}`);
}
async function waitForCanvasFile(file, predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const candidate = JSON.parse(await readFile(file + '.mermarkd.json', 'utf8')); if (predicate(candidate)) return candidate; }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`Timed out waiting for persisted canvas: ${label}`);
}
async function centered(id, selectedId = id) {
  await wait(`(()=>{const node=document.querySelector(${JSON.stringify(nodeFor(id))}),flow=document.querySelector('.react-flow');
    if(!node||!flow)return false;const c=node.getBoundingClientRect(),v=flow.getBoundingClientRect();
    return c.width>0&&c.height>0&&Math.abs(c.x+c.width/2-v.x-v.width/2)<6&&Math.abs(c.y+c.height/2-v.y-v.height/2)<6;})()`, `visible target ${id} centered`);
  if (selectedId) await wait(`document.querySelector('[data-canvas-card-picker]')?.value===${JSON.stringify(selectedId)}`, `source identity ${selectedId} selected`);
}
async function fillSearch(value) {
  await key('f', 'KeyF', 70, 2);
  await wait(`document.activeElement===document.querySelector('${searchInput}')`, 'Ctrl+F focuses canvas title search');
  await page.send('Input.insertText', { text: value }); await frame();
  assert.equal(await page.evaluate(`document.querySelector('${searchInput}').value`), value);
}
async function searchResult(total, current, cardId, hidden) {
  await wait(`(()=>{const s=document.querySelector('${searchStatus}');return s?.dataset.total===${JSON.stringify(String(total))}
    &&s.dataset.current===${JSON.stringify(String(current))}${cardId ? `&&s.dataset.cardId===${JSON.stringify(cardId)}&&s.dataset.hidden===${JSON.stringify(String(hidden))}` : ''};})()`, `search ${current}/${total}`);
}
async function readSection(index) {
  await activate(`.toc-list > li:nth-child(${index + 1}) .toc-link`);
  await wait(`document.querySelector('.toc-list > li:nth-child(${index + 1}) .toc-link')?.getAttribute('aria-current')==='location'`, `reader current section ${index}`);
}

try {
  for (const [name, options] of [
    ['v1-new-root', { version: 1, addition: 'root' }], ['v2-new-root', { addition: 'root' }],
    ['new-nested', { addition: 'nested' }], ['new-folded-child', { addition: 'folded-child', folded: true }],
    ['new-subtree', { addition: 'subtree' }],
  ]) await scenario(name, async () => {
    const item = await fixture(name, options), before = await snapshot(item.file);
    await open(item.file); const opened = await assertKnownGeometry(item, 'open');
    const expectedVisible = item.oldScene.cards.filter(card => !card.hidden).length + (options.addition === 'folded-child' ? 0 : options.addition === 'subtree' ? 2 : 1);
    assert.equal(opened.cards.length, expectedVisible, 'all new visible chapters render while folded additions remain hidden');
    assert.deepEqual(await snapshot(item.file), before, 'reconciliation and initial incremental placement write no files');
    await click('[data-mode="editor"]'); await wait('Boolean(__sourceControl())', 'source view');
    await click('[data-mode="reader"]'); await readerReady();
    await click('[data-mode="cards"]'); await ready(); await assertKnownGeometry(item, 'mode roundtrip');
    assert.deepEqual(await snapshot(item.file), before, 'mode switches write none of the three files');
    await stop(); await open(item.file); await assertKnownGeometry(item, 'process reopen');
    assert.deepEqual(await snapshot(item.file), before, 'fresh process remains passive');
    const image = name === 'new-nested' ? await screenshot('incremental-nested') : undefined;
    await click('[data-canvas-save]');
    await wait('document.querySelector("[data-canvas-status]")?.textContent.includes("画布已保存")', 'explicit save');
    const saved = await snapshot(item.file); assert.deepEqual(saved.slice(0, 2), before.slice(0, 2), 'explicit layout save preserves Markdown and annotation YAML');
    assert.notEqual(saved[2].bytes, before[2].bytes, 'explicit save updates only canvas state');
    const loaded = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.equal(loaded.cards.length, item.expected.cards.length + (options.addition === 'subtree' ? 2 : 1));
    assert.deepEqual(orderedPresentation(loaded.cards.filter(card => item.expected.cards.some(old => old.id === card.id))), orderedPresentation(item.expected.cards),
      'known identity retains all presentation fields on the new source baseline');
    assert.deepEqual(loaded.links, item.expected.links); assert.deepEqual(loaded.viewport, viewport);
    const newCards = loaded.cards.filter(card => !item.expected.cards.some(old => old.id === card.id));
    assert.ok(newCards.every(card => Number.isFinite(card.position.x) && Number.isFinite(card.position.y) && (card.position.x !== 0 || card.position.y !== 0)),
      'new visible and hidden chapters receive an initialized position');
    await stop(); await open(item.file); await assertKnownGeometry(item, 'saved process reopen');
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model, loaded, 'all newly saved identities and positions survive reopening');
    assert.deepEqual(await snapshot(item.file), saved, 'reopening the saved result has zero additional writes');
    if (name === 'new-nested') {
      await activate('[data-canvas-arrange]');
      const arranged = await waitForCanvasFile(item.file, candidate => JSON.stringify(candidate.cards.map(card => card.position)) !== JSON.stringify(loaded.cards.map(card => card.position)), 'explicit global arrange');
      assert.notDeepEqual(arranged.cards.map(card => card.position), loaded.cards.map(card => card.position), 'explicit auto arrange can still replace the full layout');
      assert.deepEqual(arranged.cards.map(({ position, ...card }) => card), loaded.cards.map(({ position, ...card }) => card));
      assert.deepEqual(arranged.links, loaded.links);
      assert.deepEqual((await snapshot(item.file)).slice(0, 2), saved.slice(0, 2), 'explicit arrange does not change source or annotations');
    }
    return { knownPresentationRetained: true, threeFilePassiveBoundary: true, explicitSaveCanvasOnly: true, stableSavedReopen: true, screenshot: image };
  });
  await scenario('unmatched-tail-preserves-known-layout-and-link', async () => {
    const item = await fixture('unmatched-tail', { addition: 'unresolved-tail' }), before = await snapshot(item.file);
    await open(item.file); const actual = await geometry();
    for (const old of item.oldScene.cards.filter(card => card.id !== 'card-4')) {
      const found = actual.cards.find(card => card.id === old.id); assert.ok(found);
      const expectedWorld = sceneWorldPosition(old, item.oldScene.cards);
      assert.deepEqual([found.x, found.y], [expectedWorld.x, expectedWorld.y], 'unmatched tail does not trigger full arrangement of proven matches');
    }
    assert.equal(actual.cards.some(card => card.id === 'card-4'), false, 'ambiguous old tail is not rendered as the newly generated identity');
    assert.equal(actual.edges.some(edge => edge.id === 'retained-link'), false, 'orphan endpoint does not silently attach to the replacement title');
    assert.deepEqual(await snapshot(item.file), before, 'unresolved reconciliation is passive');
    await click('[data-canvas-save]');
    const saved = await waitForCanvasFile(item.file, candidate => candidate.source.sha256 !== item.expected.source.sha256, 'explicit unresolved layout save');
    assert.deepEqual(saved.cards.find(card => card.id === 'card-4'), item.expected.cards.find(card => card.id === 'card-4'), 'unmatched old record is retained intact');
    assert.deepEqual(saved.links, item.expected.links, 'arrow retains its original unresolved endpoint identity');
    assert.deepEqual(orderedPresentation(saved.cards.filter(card => item.expected.cards.some(old => old.id === card.id))), orderedPresentation(item.expected.cards));
    assert.deepEqual((await snapshot(item.file)).slice(0, 2), before.slice(0, 2));
    return { matchedPositionsRetained: true, orphanRecordRetained: true, orphanEndpointNotRebound: true, explicitSaveCanvasOnly: true };
  });
  await scenario('exhausted-bounds-explicit-temporary-rearrange', async () => {
    const item = await boundaryFixture(), before = await snapshot(item.file);
    await open(item.file, false); await click('[data-mode="cards"]');
    await wait('Boolean(document.querySelector("[data-canvas-placement-rearrange]")) && document.querySelector("[data-canvas-placement-rearrange]")?.disabled===false', 'bounded placement refusal offers an enabled temporary rearrange');
    assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]")?.disabled'), true, 'unplaced candidates cannot be committed');
    const failedGeometry = await geometry();
    for (const known of item.model.cards) {
      const rendered = failedGeometry.cards.find(card => card.id === known.id); assert.ok(rendered, 'known card remains available for read-only inspection');
      assert.deepEqual([rendered.x, rendered.y], [known.position.x, known.position.y], 'refusal does not clamp or rearrange valid known coordinates');
    }
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model, item.model, 'refusal leaves the saved model intact');
    assert.deepEqual(await snapshot(item.file), before, 'refusal writes none of the three files');
    await click('[data-canvas-placement-rearrange="true"]'); await ready();
    await wait('!document.querySelector("[data-canvas-placement-rearrange]")', 'temporary rearrange clears the placement failure');
    const arrangedGeometry = await geometry();
    assert.equal(arrangedGeometry.cards.length, 5, 'temporary layout includes the new root');
    assert.notDeepEqual(arrangedGeometry.cards.filter(card => item.model.cards.some(old => old.id === card.id)).map(card => [card.x, card.y]), item.model.cards.map(card => [card.position.x, card.position.y]),
      'the user-authorized temporary rearrange can replace prior extreme coordinates');
    assert.deepEqual(await snapshot(item.file), before, 'temporary rearrange remains in memory until Save View');
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model, item.model, 'temporary arrangement does not masquerade as a disk save');
    await screenshot('temporary-bounds-recovery');
    await click('[data-canvas-save]');
    const saved = await waitForCanvasFile(item.file, candidate => candidate.source.sha256 !== item.model.source.sha256, 'explicit temporary layout commit');
    assert.deepEqual((await snapshot(item.file)).slice(0, 2), before.slice(0, 2), 'explicit save preserves Markdown and annotation YAML bytes and mtimes');
    assert.deepEqual(saved.cards.filter(card => item.model.cards.some(old => old.id === card.id)).map(({ position, ...card }) => card),
      item.expectedKnown.map(({ position, ...card }) => card), 'explicit recovery retains the reconciled identities, dimensions, content offsets and display preferences');
    assert.deepEqual(saved.links, item.model.links);
    const committed = await snapshot(item.file); await stop(); await open(item.file);
    assert.deepEqual((await page.evaluate('window.mermarkd.loadCanvasV2()')).model, saved, 'explicitly saved recovery survives a fresh process');
    assert.deepEqual(await geometry(), arrangedGeometry, 'the saved temporary layout reopens with the same measured geometry and viewport');
    assert.deepEqual(await snapshot(item.file), committed, 'reopening recovered layout has no extra writes');
    return { boundedRefusalReadOnly: true, knownCoordinatesRetainedOnFailure: true, temporaryRearrangeZeroWrites: true,
      explicitSaveCanvasOnly: true, stableReopen: true };
  });
  await scenario('canvas-search-shortcuts-path-results-and-guards', async () => {
    const item = await fixture('search-navigation', { folded: true }), before = await snapshot(item.file);
    await open(item.file); await assertKnownGeometry(item, 'initial search fixture');
    assert.match(await page.evaluate('document.querySelector("label[for=canvas-search-input]")?.textContent ?? ""'), /搜索章节标题/);
    await fillSearch('同名标题'); await searchResult(3, 0);
    await wait('Boolean(document.querySelector("[data-canvas-search-results=true]"))', 'on-demand title results');
    const results = await page.evaluate(`([...document.querySelectorAll('[data-canvas-search-result]')].map(button=>({id:button.dataset.canvasSearchResult,index:button.dataset.sectionIndex,text:button.textContent})))`);
    assert.deepEqual(results.map(row => [row.id, row.index]), [['card-1', '1'], ['card-3', '3'], ['card-4', '4']], 'duplicate matches are selectable in source order');
    assert.match(results[0].text, /第一根章节/); assert.match(results[1].text, /第二根章节/);
    await key('f', 'KeyF', 70, 2);
    assert.deepEqual(await page.evaluate(`(()=>{const i=document.querySelector('${searchInput}');return [i.selectionStart,i.selectionEnd];})()`), [0, '同名标题'.length], 'Ctrl+F selects the retained query');
    await page.evaluate(`document.querySelector('${searchInput}').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,isComposing:true,keyCode:229}))`);
    assert.equal(await page.evaluate(`document.querySelector('${searchInput}').value`), '同名标题', 'composition Escape does not clear the query');
    await page.evaluate(`document.querySelector('${searchInput}').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,isComposing:true,keyCode:229}))`);
    await searchResult(3, 0);
    await key('Enter', 'Enter', 13); await searchResult(3, 1, 'card-1', false); await centered('card-1');
    await key('f', 'KeyF', 70, 2);
    await click('[data-canvas-search-result="card-3"]'); await searchResult(3, 2, 'card-3', true);
    await centered('card-2', 'card-2');
    assert.deepEqual(await snapshot(item.file), before, 'searching and locating a hidden result do not write or expand it');
    await key('f', 'KeyF', 70, 2);
    await screenshot('search-path-results');
    await key('f', 'KeyF', 70, 2); await key('Escape', 'Escape', 27);
    assert.equal(await page.evaluate(`document.querySelector('${searchInput}').value`), '');
    assert.equal(await page.evaluate(`document.activeElement===document.querySelector('${searchInput}')`), true, 'Escape retains search focus');
    await fillSearch('第一根'); await click('[data-canvas-search-clear="true"]');
    assert.equal(await page.evaluate(`document.querySelector('${searchInput}').value`), '', 'clear control resets query');
    await activate('[aria-label="文档菜单"]'); await activate('[data-open-document-recovery]');
    await wait('Boolean(document.querySelector("[data-document-recovery]"))', 'actual recovery modal');
    await key('f', 'KeyF', 70, 2);
    assert.equal(await page.evaluate(`document.activeElement===document.querySelector('${searchInput}')`), false, 'recovery modal keeps Ctrl+F from taking background focus');
    await click('[aria-label="关闭保存恢复"]');
    await wait('!document.querySelector("[data-document-recovery]")', 'recovery closed');
    await fillSearch('同名标题');
    for (const width of [800, 420]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: false }); await frame();
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'search results cause no page overflow');
      for (const selector of [searchInput, '[data-canvas-search-clear]', '[data-canvas-search-results]']) assert.equal(await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1;})()`), true, `${selector} remains within ${width}px`);
      await screenshot(`search-${width}`);
    }
    assert.deepEqual(await snapshot(item.file), before, 'query controls, modal and responsive layout write none of the three files');
    return { shortcutAndSelection: true, explicitTitleScope: true, sourceOrderPaths: true, compositionGuardSyntheticOnly: true, recoveryModalFocusGuard: true, foldedNavigationZeroWrites: true, narrowWidths: [800, 420] };
  });
  await scenario('reader-locate-exact-chapter-and-passive-return', async () => {
    const item = await fixture('reader-locate', { folded: true }), before = await snapshot(item.file);
    await open(item.file, false);
    await readSection(1); await click('[data-reader-locate-card="true"]'); await ready(); await centered('card-1', 'card-1');
    assert.deepEqual(await snapshot(item.file), before, 'reader-to-visible-card location is passive');
    await click('[data-mode="reader"]'); await readerReady(); await readSection(3);
    await click('[data-reader-locate-card="true"]'); await ready(); await centered('card-2', 'card-2');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('${nodeFor('card-3')}'))`), false, 'locating the hidden source chapter does not unfold it');
    assert.deepEqual(await snapshot(item.file), before, 'reader-to-hidden-card location keeps fold and all files');
    await screenshot('reader-locate-folded');
    await click('[data-mode="reader"]'); await readerReady();
    await wait('document.querySelector(".toc-list > li:nth-child(4) .toc-link")?.getAttribute("aria-current")==="location"', 'return to the original hidden source chapter, not its visible canvas ancestor');
    await click('[data-mode="cards"]'); await ready(); await assertKnownGeometry(item, 'ordinary return after explicit locate');
    assert.deepEqual(await snapshot(item.file), before, 'normal mode return restores saved viewport without a stale location request or writes');
    await click('[data-mode="reader"]'); await readerReady();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 850, deviceScaleFactor: 1, mobile: false }); await frame();
    assert.equal(await page.evaluate(`(()=>{const b=document.querySelector('[data-reader-locate-card]'),r=b?.getBoundingClientRect();return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1;})()`), true, 'reader location action remains accessible in the narrow header');
    await screenshot('reader-locate-420');
    return { exactDuplicateIdentity: true, hiddenVisibleAncestor: true, foldRetained: true, ordinaryReturnViewportRestored: true, threeFilesUnchanged: true };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack; }
finally {
  await stop(); result.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = path.resolve(workspace), temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporaryRoot) && path.basename(resolved).startsWith('mermarkd-ux9-'), 'cleanup remains inside the generated temporary workspace');
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`UX9 fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
