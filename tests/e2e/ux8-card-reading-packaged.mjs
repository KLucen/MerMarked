import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasStateV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux8-'));
const fixture = path.join(workspace, '卡片阅读与导航.md');
const freshFixture = path.join(workspace, '默认卡片.md');
const canvasFile = fixture + '.mermarkd.json';
const qa = path.join(root, 'out/qa');
const artifactPrefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'ux8';
await mkdir(qa, { recursive: true });

const structuredBody = ['- 第一项', '  - [x] 子任务', '- 第二项', '', '7. 有序甲', '8. 有序乙', '',
  '| 项目 | 数值 |', '| --- | --- |', '| 单价 | 12 |', '', '```ts', 'const n = 12;', '  run(n);', '```', '',
  '中文与 emoji 😀 均应完整保留。'.repeat(10)].join('\r\n');
const source = [
  '# 卡片阅读样本', '', structuredBody, '', '# 同名标题', '', structuredBody, '',
  '# 折叠分支', '', '分支概要。', '', '## 同名标题', '', '隐藏章节的专有正文。', '',
  '# 同名标题', '', '独立章节的专有正文。',
].join('\r\n');
const bytes = Buffer.from('\ufeff' + source);
const sha256 = createHash('sha256').update(bytes).digest('hex');
let nextId = 0;
const initial = (await reconcileCanvasStateV2(null, { bytes, content: source, sha256 }, () => `card-${nextId++}`)).model;
assert.equal(initial.cards.length, 5);
const positions = [{ x: 80, y: 60 }, { x: 540, y: 96 }, { x: 1100, y: 60 }, { x: 32, y: 245 }, { x: 1740, y: 132 }];
const model = {
  ...initial,
  cards: initial.cards.map((card, index) => ({
    ...card,
    position: positions[index],
    contentPosition: { x: 0, y: 0 },
    size: { width: 390 + index * 13, height: index === 1 ? 350 : 176 },
    bodyDisplay: index === 1 ? 'full' : 'preview',
    descendantsCollapsed: index === 2,
  })),
  viewport: { x: 30, y: 30, zoom: 0.48 },
  links: [{ id: 'branch-link', from: 'card-3', to: 'card-4', label: '同名章节之间的箭头' }],
};
await Promise.all([
  writeFile(fixture, bytes),
  writeFile(freshFixture, '# 默认卡片\n\n普通正文。\n'),
  writeFile(canvasFile, serializeCanvasStateV2Json(model)),
  writeFile(fixture + '.annotations.yaml', serializeAnnotationYaml({ schemaVersion: 1,
    source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [], annotations: [] })),
]);

const port = 15900 + Math.floor(Math.random() * 100);
const searchInput = '[data-canvas-search-input]';
const searchStatus = '[data-canvas-search-status]';
const previous = '[data-canvas-search-previous]';
const next = '[data-canvas-search-next]';
const reveal = '[data-canvas-search-reveal]';
const nodeFor = id => `.react-flow__node[data-id="${id}"]`;
let child;
let page;
let main;
let passed = false;

async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const diagnostics = page ? await page.evaluate(`(() => ({
    mode:document.querySelector('.app-shell')?.dataset.activeMode,
    preparation:document.querySelector('[data-canvas-preparation]')?.dataset.canvasPreparation,
    search:document.querySelector('[data-canvas-search-status]')?.dataset,
    selected:[...document.querySelectorAll('.react-flow__node.selected')].map(node=>({
      id:node.dataset.id,rect:node.getBoundingClientRect().toJSON(),
    })),
    flow:document.querySelector('.react-flow')?.getBoundingClientRect().toJSON(),
    toolbar:document.querySelector('.canvas-toolbar')?.getBoundingClientRect().toJSON(),
    viewportTransform:document.querySelector('.react-flow__viewport')?.style.transform,
    active:document.activeElement?.id,
    text:document.body.innerText.slice(0,1200),
  }))()`).catch(() => ({})) : {};
  throw Error(`${label}: ${JSON.stringify(diagnostics)}`);
}
const wait = (expression, label) => poll(() => page.evaluate(expression), label);
const frame = () => page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

async function click(selector) {
  const point = await page.evaluate(`(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element || element.disabled || !element.getClientRects().length) return null;
    element.scrollIntoView({behavior:'instant',block:'nearest',inline:'nearest'});
    const r=element.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    return {x,y,hit:element.contains(document.elementFromPoint(x,y))};
  })()`);
  assert.ok(point?.hit, `visible enabled control at pointer: ${selector}, ${JSON.stringify(point)}`);
  const { x, y } = point;
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await frame();
}

async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}

async function fillSearch(value) {
  await click(searchInput);
  await key('a', 'KeyA', 65, 2);
  await page.send('Input.insertText', { text: value });
  await frame();
  assert.equal(await page.evaluate(`document.querySelector('${searchInput}').value`), value);
}

async function metrics(width, height = 820) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await frame();
  assert.equal(await page.evaluate('innerWidth'), width, 'requested CSS viewport');
}

async function screenshot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `${artifactPrefix}-${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function snapshot(document = fixture) {
  return Promise.all(['', '.annotations.yaml', '.mermarkd.json'].map(async suffix => {
    const file = document + suffix;
    try {
      const [data, info] = await Promise.all([readFile(file), stat(file)]);
      return { bytes: data.toString('base64'), mtime: info.mtimeMs };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }));
}

function ready(cardCount) {
  return wait(`document.querySelector('.app-shell')?.dataset.activeMode==='cards'
    && Boolean(document.querySelector('[data-canvas-preparation="ready"]'))
    && document.querySelectorAll('.react-flow__node').length===${cardCount}`, `canvas ready with ${cardCount} visible cards`);
}

function searchResult(total, current, cardId, hidden) {
  return wait(`(() => {
    const status=document.querySelector('${searchStatus}');
    return status?.dataset.total===${JSON.stringify(String(total))}
      && status.dataset.current===${JSON.stringify(String(current))}
      && (${cardId === undefined ? 'true' : `status.dataset.cardId===${JSON.stringify(cardId)} && status.dataset.hidden===${JSON.stringify(String(hidden))}`});
  })()`, `search result ${current}/${total} ${cardId ?? ''}`);
}

function selectedAndLocated(id) {
  return wait(`(() => {
    const node=document.querySelector(${JSON.stringify(nodeFor(id) + '.selected')});
    const flow=node?.closest('.react-flow');
    if(!node || !flow) return false;
    const card=node.getBoundingClientRect(), view=flow.getBoundingClientRect();
    return card.width>0 && card.height>0 && Math.abs(card.x+card.width/2-view.x-view.width/2)<6
      && Math.abs(card.y+card.height/2-view.y-view.height/2)<6;
  })()`, `selected and centered ${id}`);
}

async function linkEndpoints(from) {
  const edge = '.react-flow__edge[data-id="branch-link"]';
  await wait(`document.querySelector(${JSON.stringify(edge)})?.getAttribute('aria-label')===${JSON.stringify(`Edge from ${from} to card-4`)}`,
    `same relationship projected from ${from}`);
  const label = await page.evaluate(`document.querySelector(${JSON.stringify(edge)}).textContent`);
  assert.match(label, /同名章节之间的箭头/);
  assert.equal(label.includes('隐藏端点'), from === 'card-2');
}

function cardGeometry(selector) {
  return page.evaluate(`(() => {
    const node=document.querySelector(${JSON.stringify(selector)});
    const body=node.querySelector('.canvas-card-body');
    const position=new DOMMatrixReadOnly(node.style.transform);
    return { x:position.m41,y:position.m42,width:parseFloat(node.style.width),height:parseFloat(node.style.height),
      body:{left:parseFloat(body.style.left),top:parseFloat(body.style.top),
        width:parseFloat(body.style.width),height:parseFloat(body.style.height)} };
  })()`);
}

try {
  child = await spawn(process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
    [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  page = await connectCdp(port, target => target.type === 'page');
  main = await connectCdp(port + 200, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) {
    await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  }
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.bringToFront');
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'initial window');
  await metrics(1200);
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(fixture)}]})`);
  const untouched = await snapshot();
  await click('[data-start-open]');
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(fixture))}`, 'fixture opened');
  await click('[data-mode="cards"]');
  await ready(4);

  const preview = await page.evaluate(`document.querySelector('${nodeFor('card-0')} .canvas-card-summary').textContent`);
  const full = await page.evaluate(`document.querySelector('${nodeFor('card-1')} .canvas-card-full').textContent`);
  const expectedFull = [
    '• 第一项\n  • ☑ 子任务\n• 第二项', '7. 有序甲\n8. 有序乙', '项目 │ 数值\n单价 │ 12',
    'const n = 12;\n  run(n);', '中文与 emoji 😀 均应完整保留。'.repeat(10),
  ].join('\n\n');
  assert.equal(full, expectedFull, 'complete card preserves block, list, table and code boundaries');
  assert.equal(preview, [...expectedFull].slice(0, 160).join(''), 'preview keeps those boundaries within the code-point budget');
  for (const selector of [`${nodeFor('card-0')} .canvas-card-summary`, `${nodeFor('card-1')} .canvas-card-full`]) {
    const whitespace = await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).whiteSpace`);
    assert.match(whitespace, /^(pre|pre-line|pre-wrap|break-spaces)$/, 'browser paints the preserved line boundaries');
  }
  const fullGeometry = await cardGeometry(nodeFor('card-1'));
  assert.deepEqual([fullGeometry.x, fullGeometry.y], [540, 96], 'top-level group retains the saved position');
  assert.deepEqual([fullGeometry.body.width, fullGeometry.body.height], [403, 350], 'full-text body retains the saved dimensions');
  assert.ok(fullGeometry.width > fullGeometry.body.left + fullGeometry.body.width &&
    fullGeometry.height > fullGeometry.body.top + fullGeometry.body.height, 'outer group encloses the inset content body');
  await linkEndpoints('card-2');
  assert.deepEqual(await snapshot(), untouched, 'opening and inspecting the existing canvas write no files');

  await fillSearch('找不到的标题');
  await searchResult(0, 0);
  assert.equal(await page.evaluate(`['${previous}','${next}'].every(selector=>document.querySelector(selector)?.disabled ?? true)`), true);
  await fillSearch('同名标题');
  await searchResult(3, 0);
  await key('Enter', 'Enter', 13);
  await searchResult(3, 1, 'card-1', false);
  await selectedAndLocated('card-1');
  await screenshot('structured-full');
  await key('Enter', 'Enter', 13, 8);
  await searchResult(3, 3, 'card-4', false);
  await selectedAndLocated('card-4');
  await click(next);
  await searchResult(3, 1, 'card-1', false);
  await selectedAndLocated('card-1');
  await click(next);
  await searchResult(3, 2, 'card-3', true);
  await selectedAndLocated('card-2');
  await ready(4);
  assert.deepEqual(await cardGeometry(nodeFor('card-1')), fullGeometry, 'navigation preserves the actual body and group geometry');
  assert.match(await page.evaluate(`document.querySelector('${searchStatus}').textContent`), /折叠|收起/);
  assert.match(await page.evaluate(`document.querySelector('${reveal}').textContent`), /展开.*保存/);
  await linkEndpoints('card-2');
  assert.deepEqual(await snapshot(), untouched, 'visible and folded search navigation preserve bytes and mtimes');

  for (const width of [800, 420]) {
    await metrics(width);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, 'canvas toolbar does not cause page overflow');
    for (const selector of [searchInput, searchStatus, previous, next, reveal]) {
      assert.equal(await page.evaluate(`(() => {
        const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
        return Boolean(r && r.width && r.height && r.left>=-1 && r.right<=innerWidth+1);
      })()`), true, `${selector} remains within ${width}px viewport`);
    }
    await screenshot(`folded-${width}`);
  }
  await metrics(1200);
  assert.deepEqual(await snapshot(), untouched, 'narrow layout and folded result still write no files');

  await click(reveal);
  await poll(async () => {
    try { return JSON.parse(await readFile(canvasFile, 'utf8')).cards.find(card => card.id === 'card-2')?.descendantsCollapsed === false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }, 'explicit reveal persisted');
  await ready(5);
  await searchResult(3, 2, 'card-3', false);
  await selectedAndLocated('card-3');
  await linkEndpoints('card-3');
  const revealed = await snapshot();
  assert.deepEqual(revealed.slice(0, 2), untouched.slice(0, 2), 'explicit reveal preserves Markdown and YAML bytes and mtimes');
  assert.notEqual(revealed[2].bytes, untouched[2].bytes, 'explicit reveal writes canvas JSON');
  const expectedCanvas = JSON.parse(Buffer.from(untouched[2].bytes, 'base64').toString('utf8'));
  expectedCanvas.cards.find(card => card.id === 'card-2').descendantsCollapsed = false;
  assert.deepEqual(JSON.parse(Buffer.from(revealed[2].bytes, 'base64').toString('utf8')), expectedCanvas,
    'reveal changes only the selected ancestor fold, including preservation of coordinates, dimensions, viewport and arrow identity');

  await click(`${nodeFor('card-3')} [data-canvas-read-section]`);
  await wait(`(() => {
    const article=document.querySelector('.reading-main[data-reading-analysis="ready"] .markdown-body');
    if(!article || article.closest('[hidden],[inert]')) return false;
    const matches=[...article.querySelectorAll('h1,h2,h3')].filter(h=>h.textContent==='同名标题');
    return document.querySelector('.app-shell')?.dataset.activeMode==='reader' && matches.length===3
      && document.activeElement===matches[1] && matches[1].nextElementSibling?.textContent==='隐藏章节的专有正文。';
  })()`, 'read section focuses the second same-named heading and its exact content');
  assert.deepEqual(await snapshot(), revealed, 'card-to-reading jump writes no files');
  await click('[data-mode="cards"]');
  await ready(5);
  await linkEndpoints('card-3');
  assert.deepEqual(await cardGeometry(nodeFor('card-1')), fullGeometry, 'reload preserves the actual body and group geometry');
  assert.deepEqual(await snapshot(), revealed, 'returning to cards preserves saved geometry and links');

  const fresh = await snapshot(freshFixture);
  assert.deepEqual(fresh.slice(1), [null, null], 'fresh fixture has no companion files');
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(freshFixture)}]})`);
  await key('o', 'KeyO', 79, 2);
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(freshFixture))}`, 'fresh fixture opened');
  await click('[data-mode="cards"]');
  await ready(1);
  const freshGeometry = await cardGeometry('.react-flow__node');
  assert.deepEqual([freshGeometry.body.width, freshGeometry.body.height], [328, 176], 'first layout keeps the compact default card dimensions');
  assert.deepEqual(await snapshot(freshFixture), fresh, 'opening and automatically arranging a fresh document create no companion files');
  passed = true;
  console.log(JSON.stringify({ status: 'passed', structuredPreviewAndFull: true, duplicateSearchInSourceOrder: true,
    foldedLocateZeroWrites: true, explicitRevealCanvasOnly: true, stableGeometryAndEndpoints: true,
    exactReaderTarget: true, compactDefaultsZeroWrites: true, narrowWidths: [800, 420] }));
} catch (error) {
  if (page) await screenshot('failure').catch(() => {});
  console.error(`UX8 fixture retained for inspection: ${workspace}`);
  throw error;
} finally {
  page?.close();
  main?.close();
  if (child?.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch { child.kill('SIGKILL'); }
  }
  if (passed) {
    assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary fixture cleanup stays under temp');
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
