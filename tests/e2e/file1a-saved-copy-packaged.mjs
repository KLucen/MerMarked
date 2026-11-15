import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasStateV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'file1a-saved-copy';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve earlier evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-file1a-'));
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  asarSha256: digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))), cases: [],
  boundary: 'Packaged renderer/IPC/filesystem; native dialog responses mocked in isolated main. Chromium composition only, no physical IME/dialog, AX, installation or timing acceptance.' };
let child, page, main, launches = 0;
const menuSelector = 'button[aria-label="文档菜单"]', copySelector = '[data-workspace-create-copy]';
async function fixture(name, companions = true) {
  const directory = path.join(workspace, name); await mkdir(path.join(directory, 'assets'), { recursive: true });
  const content = '# 第一章\r\n\r\n这是保留中文😀。\r\n\r\n![共享图](assets/pixel.png)\r\n\r\n## 子章节\r\n\r\n子节正文。\r\n\r\n# 第二章\r\n\r\n第二章正文。';
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes), file = path.join(directory, '原文.md');
  await writeFile(file, bytes);
  await writeFile(path.join(directory, 'assets/pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
  if (companions) {
    const quote = '保留中文😀。', start = 3 + Buffer.byteLength(content.slice(0, content.indexOf(quote)));
    await writeFile(file + suffixes[1], serializeAnnotationYaml({ schemaVersion: 1,
      source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [{ id: 'tag-one', name: '保留标签' }],
      annotations: [{ id: 'note-one', kind: 'note', color: 'amber', tagId: 'tag-one', note: '副本独立便签',
        anchor: { basisSha256: '0'.repeat(64), startByte: start, endByte: start + Buffer.byteLength(quote),
          sourceExact: quote, prefix: '这是', suffix: '\r\n\r\n', displayQuote: quote, sectionHint: '第一章' },
        createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:00.000Z' }] }));
    let id = 0;
    const prepared = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `card-${id++}`);
    const positions = [{ x: 80, y: 80 }, { x: 24, y: 300 }, { x: 650, y: 90 }];
    const model = { ...prepared.model, cards: prepared.model.cards.map((card, index) => ({
      ...card, position: positions[index], descendantsCollapsed: index === 0 })),
      links: [{ id: 'copy-link', from: 'card-1', to: 'card-2', label: '保留关系' }], viewport: { x: 120, y: 100, zoom: 0.7 } };
    await writeFile(file + suffixes[2], serializeCanvasStateV2Json(model));
  }
  return { directory, file, target: path.join(directory, '副本.md'), bytes };
}
async function snapshot(file) {
  return Promise.all(suffixes.map(async suffix => {
    try { const bytes = await readFile(file + suffix), info = await stat(file + suffix);
      return { suffix, sha256: digest(bytes), bytes: bytes.length, mtimeMs: info.mtimeMs }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return { suffix, missing: true }; }
  }));
}
async function exactCopy(source, target) { for (const suffix of suffixes) assert.deepEqual(await readFile(target + suffix), await readFile(source + suffix)); }
async function absent(file) { await assert.rejects(stat(file), error => error.code === 'ENOENT'); }
async function absentBundle(file) { for (const suffix of suffixes) await absent(file + suffix); }
async function wait(expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await page.evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timed out: ${label}; ${await page.evaluate('document.body.innerText.slice(0,1200)')}`);
}
const frame = () => page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function click(selector) {
  const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!(e instanceof HTMLElement)||e.hasAttribute('disabled')||e.closest('[hidden],[inert]'))return null;
    e.scrollIntoView({behavior:'instant',block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
  assert.ok(point, `visible enabled control: ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }); await frame();
}
async function menu(open = true) {
  const shown = await page.evaluate(`Boolean(document.querySelector('${copySelector}')?.getClientRects().length)`);
  if (shown !== open) await click(menuSelector);
}
async function openDocument(file, marker) {
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]})`);
  if (await page.evaluate('Boolean(document.querySelector("[data-start-open]"))')) await click('[data-start-open]');
  else { await menu(); assert.equal(await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.workspace-popover-panel button')]
    .find(e=>e.getClientRects().length&&e.textContent.trim().startsWith('打开文档'));if(!b)return false;b.dataset.file1Open='true';return true;})()`), true); await click('[data-file1-open]'); }
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'`, 'document ready');
  if (marker) await wait(`document.querySelector('.markdown-body')?.textContent.includes(${JSON.stringify(marker)})`, 'latest source visible');
  await menu(); await wait(`document.querySelector('${copySelector}')?.disabled===false`, 'copy entry ready'); await menu(false);
}
async function start(file) {
  const port = 19500 + Math.floor(Math.random() * 450);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`,
    `--user-data-dir=${path.join(workspace, `profile-${++launches}`)}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start page'); await openDocument(file);
}
async function dialogs(target, { canceled = false, recovery = 1 } = {}) {
  await main.evaluate(`(()=>{const d=process.mainModule.require('electron').dialog;globalThis.__file1SaveCalls=0;
    d.showSaveDialog=async()=>{globalThis.__file1SaveCalls++;return {canceled:${canceled},filePath:${JSON.stringify(target)}}};
    d.showMessageBox=async()=>({response:${recovery},checkboxChecked:false});})()`);
}
const apiCopy = () => page.evaluate('window.mermarkd.createSavedDocumentCopy()');
async function screenshot(name) {
  const file = path.join(qa, `${prefix}-${name}.png`), capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' }); return file;
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } child = undefined; }
}
async function scenario(name, run) {
  const record = { name, status: 'running', startedAt: new Date().toISOString() }; result.cases.push(record);
  try { Object.assign(record, await run()); record.status = 'passed'; console.log(`passed: ${name}`); }
  catch (error) { record.status = 'failed'; record.error = error.stack ?? String(error); console.log(`failed: ${name}`);
    if (page) record.screenshot = await screenshot(`${name}-failure`).catch(() => undefined); }
  finally { await stop(); record.finishedAt = new Date().toISOString(); }
}
try {
  await scenario('saved-copy-bytes-state-and-shared-image', async () => {
    const item = await fixture('complete'), before = await snapshot(item.file);
    const image = path.join(item.directory, 'assets/pixel.png'), imageBefore = await readFile(image);
    await start(item.file); await dialogs(item.target); await menu(); await click(copySelector);
    await wait(`!document.querySelector('.app-shell')?.inert&&document.body.innerText.includes('已在当前文件夹创建“副本.md”')`, 'copy completed');
    assert.equal(await page.evaluate('document.querySelector(".workspace-current-name").textContent'), '原文.md');
    await exactCopy(item.file, item.target); assert.deepEqual(await snapshot(item.file), before);
    const annotation = parseAnnotationYaml(await readFile(item.target + suffixes[1], 'utf8'));
    assert.equal(annotation.annotations[0].note, '副本独立便签'); assert.equal(annotation.tags[0].name, '保留标签');
    assert.equal(annotation.annotations[0].anchor.basisSha256, '0'.repeat(64));
    await openDocument(item.target);
    await wait('[...document.querySelectorAll(".markdown-body img")].some(i=>i.complete&&i.naturalWidth===1)', 'shared image');
    const view = await page.evaluate('window.mermarkd.loadAnnotations()'); assert.ok(view.unresolvedCount >= 1);
    await click('[data-mode="cards"]'); await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'copied canvas');
    const loaded = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.deepEqual(loaded, JSON.parse(await readFile(item.target + suffixes[2], 'utf8')));
    assert.equal(loaded.links[0].from, 'card-1');
    assert.equal(await page.evaluate('Boolean(document.querySelector(".react-flow__node[data-id=card-1]"))'), false);
    assert.deepEqual(await snapshot(item.file), before); assert.deepEqual(await readFile(image), imageBefore);
    return { originalSessionRetained: true, exactThreeFiles: true, pendingAnchorRetained: true, copiedFoldAndArrow: true,
      sharedImageDecoded: true, screenshot: await screenshot('copied-canvas') };
  });
  await scenario('missing-companions-remain-missing', async () => {
    const item = await fixture('missing', false), before = await snapshot(item.file);
    await start(item.file); await dialogs(item.target); assert.equal((await apiCopy()).status, 'copied');
    assert.deepEqual(await readFile(item.target), item.bytes); await absent(item.target + suffixes[1]); await absent(item.target + suffixes[2]);
    assert.deepEqual(await snapshot(item.file), before); return { missingStateRetained: true };
  });
  await scenario('cancel-zero-writes', async () => {
    const item = await fixture('cancel'), before = await snapshot(item.file), names = await readdir(item.directory);
    await start(item.file); await dialogs(item.target, { canceled: true }); assert.equal((await apiCopy()).status, 'cancelled');
    await absentBundle(item.target); assert.deepEqual(await snapshot(item.file), before); assert.deepEqual(await readdir(item.directory), names);
    return { canceledZeroWrites: true };
  });
  await scenario('all-three-target-kinds-protected', async () => {
    const item = await fixture('occupied'), before = await snapshot(item.file); await start(item.file);
    for (let i = 0; i < suffixes.length; i++) {
      const target = path.join(item.directory, `occupied-${i}.md`); await writeFile(target + suffixes[i], 'external target');
      const occupied = await snapshot(target); await dialogs(target); assert.equal((await apiCopy()).status, 'conflict');
      assert.deepEqual(await snapshot(target), occupied); assert.deepEqual(await snapshot(item.file), before);
    }
    return { threeTargetKindsProtected: true };
  });
  await scenario('cross-directory-and-invalid-companion', async () => {
    const item = await fixture('invalid'), before = await snapshot(item.file), outside = path.join(workspace, 'other-folder');
    await mkdir(outside); await start(item.file); await dialogs(path.join(outside, '副本.md'));
    assert.equal((await apiCopy()).status, 'conflict'); assert.deepEqual(await readdir(outside), []); assert.deepEqual(await snapshot(item.file), before);
    await writeFile(item.file + suffixes[1], 'schemaVersion: 999\n'); const malformed = await snapshot(item.file);
    await dialogs(item.target); assert.equal((await apiCopy()).status, 'conflict'); await absentBundle(item.target);
    assert.deepEqual(await snapshot(item.file), malformed); return { sameDirectoryEnforced: true, invalidCompanionNotOmitted: true };
  });
  await scenario('dirty-source-protection', async () => {
    const item = await fixture('dirty'), before = await snapshot(item.file); await start(item.file);
    await click('[data-mode="editor"]'); await wait('Boolean(document.querySelector(".cm-content[contenteditable=true]"))', 'source');
    await page.evaluate('document.querySelector(".cm-content").focus()'); await page.send('Input.insertText', { text: 'COPY-DIRTY-未保存' });
    await wait('document.querySelector(".app-shell")?.dataset.dirty==="true"', 'dirty source');
    await dialogs(item.target); await menu(); await click(copySelector); await wait('document.body.innerText.includes("请先保存正文")', 'input guard');
    assert.ok(await page.evaluate('document.querySelector(".cm-content").textContent.includes("COPY-DIRTY-未保存")'));
    assert.equal(await main.evaluate('globalThis.__file1SaveCalls'), 0); assert.equal((await apiCopy()).status, 'conflict');
    assert.equal(await main.evaluate('globalThis.__file1SaveCalls'), 0); await absentBundle(item.target); assert.deepEqual(await snapshot(item.file), before);
    return { rendererAndMainDirtyGuards: true, inputRetained: true };
  });
  await scenario('source-composition-protection', async () => {
    const item = await fixture('composing'), before = await snapshot(item.file); await start(item.file);
    await click('[data-mode="editor"]'); await wait('Boolean(document.querySelector(".cm-content[contenteditable=true]"))', 'source');
    await page.evaluate('document.querySelector(".cm-content").focus()');
    await page.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 }); await frame();
    assert.ok(await page.evaluate('document.querySelector(".cm-content").textContent.includes("ni")'));
    await dialogs(item.target);
    // DOM activation avoids mouse blur ending composition before the guard is exercised.
    await page.evaluate('document.querySelector(\'button[aria-label="文档菜单"]\').click()');
    await page.evaluate('document.querySelector("[data-workspace-create-copy]").click()'); await frame();
    assert.equal(await main.evaluate('globalThis.__file1SaveCalls'), 0);
    assert.ok(await page.evaluate('document.querySelector(".cm-content").textContent.includes("ni")'));
    await absentBundle(item.target); assert.deepEqual(await snapshot(item.file), before);
    return { chromiumCompositionRetained: true, dialogNotOpened: true };
  });
  await scenario('narrow-copy-menu', async () => {
    const item = await fixture('narrow'), before = await snapshot(item.file); await start(item.file);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 850, deviceScaleFactor: 1, mobile: false });
    await frame(); await menu();
    assert.equal(await page.evaluate(`(()=>{const e=document.querySelector('${copySelector}'),r=e?.getBoundingClientRect();
      return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`), true);
    assert.deepEqual(await snapshot(item.file), before); return { width: 420, screenshot: await screenshot('copy-menu-420') };
  });
  await scenario('explicit-recovery-preserves-old-snapshot', async () => {
    const item = await fixture('recovery'); await start(item.file);
    const journalDirectory = path.join(await main.evaluate("process.mainModule.require('electron').app.getPath('userData')"), 'document-copy-journals');
    const interrupted = path.join(item.directory, '先前副本.md'), oldBytes = await readFile(item.file);
    const crash = spawnSync(process.execPath, [path.join(root, 'tests/fixtures/document-copy-crash.mjs'), item.file,
      interrupted, journalDirectory, '.annotations.yaml'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(crash.status, 73, `crash fixture checkpoint: ${crash.stderr}`);
    await absent(interrupted); const partial = await snapshot(interrupted);
    const currentBytes = Buffer.concat([oldBytes, Buffer.from('\r\n新的已保存版本。\r\n')]); await writeFile(item.file, currentBytes);
    await openDocument(item.file, '新的已保存版本。'); const current = await snapshot(item.file);
    const fresh = path.join(item.directory, '当前版本副本.md'); await dialogs(fresh, { recovery: 1 });
    assert.equal((await apiCopy()).status, 'copied'); assert.deepEqual(await readFile(fresh), currentBytes);
    assert.deepEqual(await snapshot(interrupted), partial, 'skip leaves old partial targets untouched');
    await dialogs(interrupted, { recovery: 0 }); assert.equal((await apiCopy()).status, 'restored');
    assert.deepEqual(await readFile(interrupted), oldBytes); assert.notDeepEqual(await readFile(interrupted), currentBytes);
    for (const suffix of suffixes.slice(1)) assert.deepEqual(await readFile(interrupted + suffix), await readFile(item.file + suffix));
    assert.deepEqual(await snapshot(item.file), current); assert.deepEqual(await readdir(journalDirectory), []);
    return { realProcessExit: 73, skipRecoveryZeroWrites: true, explicitOldSnapshotRestored: true };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stop(); result.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = await realpath(workspace), temporary = await realpath(os.tmpdir());
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.ok(key(resolved).startsWith(key(temporary) + path.sep) && path.basename(resolved).startsWith('mermarkd-file1a-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`FILE1A fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);