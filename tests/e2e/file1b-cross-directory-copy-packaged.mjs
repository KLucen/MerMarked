import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'file1b-cross-directory-copy';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve earlier evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-file1b-'));
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  asarSha256: digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))), cases: [],
  boundary: 'Actual packaged renderer/IPC/filesystem with generated documents and isolated profiles. Native dialog responses mocked in main. No physical dialog, IME, AX, installation or timing acceptance.' };
let child, page, main, launches = 0;
const menuSelector = 'button[aria-label="文档菜单"]', copySelector = '[data-workspace-create-copy]';

async function fixture(name, { companions = true, extra = '' } = {}) {
  const directory = path.join(workspace, name), sourceDirectory = path.join(directory, 'source'), targetDirectory = path.join(directory, 'destination');
  await mkdir(sourceDirectory, { recursive: true }); await mkdir(targetDirectory);
  const content = ['# 第一章', '', '这是保留中文😀。', '', '[外部网站](https://example.com/reading?q=one#section)',
    '[本节](#第一章)', '[邮件](mailto:reader@example.com)', '', '`![代码图片](assets/not-an-image.png)`', '',
    '```md', '[示例路径](../not-a-document.md)', '```', '', extra, '', '## 子章节', '', '子节正文。', '', '# 第二章', '', '第二章正文。'].join('\r\n');
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes), file = path.join(sourceDirectory, '原文.md');
  await writeFile(file, bytes);
  if (companions) {
    const quote = '保留中文😀。', start = 3 + Buffer.byteLength(content.slice(0, content.indexOf(quote)));
    await writeFile(file + suffixes[1], serializeAnnotationYaml({ schemaVersion: 1,
      source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [{ id: 'tag-one', name: '保留标签' }],
      annotations: [{ id: 'note-one', kind: 'note', color: 'amber', tagId: 'tag-one', note: '跨目录独立便签',
        anchor: { basisSha256: '0'.repeat(64), startByte: start, endByte: start + Buffer.byteLength(quote),
          sourceExact: quote, prefix: '这是', suffix: '\r\n\r\n', displayQuote: quote, sectionHint: '第一章' },
        createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' }] }));
    let id = 0;
    const prepared = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `card-${id++}`);
    assert.equal(prepared.model.cards.length, 3, 'fixture has three semantic sections');
    const positions = [{ x: 80, y: 80 }, { x: 24, y: 300 }, { x: 650, y: 90 }];
    const model = { ...prepared.model, cards: prepared.model.cards.map((card, index) => ({
      ...card, position: positions[index], descendantsCollapsed: index === 0 })),
      links: [{ id: 'copy-link', from: 'card-1', to: 'card-2', label: '保留关系' }], viewport: { x: 120, y: 100, zoom: 0.7 } };
    await writeFile(file + suffixes[2], serializeCanvasStateV2Json(model));
  }
  return { directory, sourceDirectory, targetDirectory, file, target: path.join(targetDirectory, '异地副本.md'), bytes };
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
async function emptyDestination(item) { assert.deepEqual(await readdir(item.targetDirectory), [], 'no published files or private staging in target directory'); }
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
async function openDocument(file) {
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]})`);
  if (await page.evaluate('Boolean(document.querySelector("[data-start-open]"))')) await click('[data-start-open]');
  else { await menu(); assert.equal(await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.workspace-popover-panel button')]
    .find(e=>e.getClientRects().length&&e.textContent.trim().startsWith('打开文档'));if(!b)return false;b.dataset.file1Open='true';return true;})()`), true); await click('[data-file1-open]'); }
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'`, 'document ready');
  await menu(); await wait(`document.querySelector('${copySelector}')?.disabled===false`, 'copy entry ready'); await menu(false);
}
async function start(file) {
  const port = 20100 + Math.floor(Math.random() * 350);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`,
    `--user-data-dir=${path.join(workspace, `profile-${++launches}`)}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start page'); await openDocument(file);
}
async function dialogs(target, { response = 0, mutation = null } = {}) {
  await main.evaluate(`(()=>{const d=process.mainModule.require('electron').dialog;
    globalThis.__file1bSaveCalls=0;globalThis.__file1bPreviews=[];globalThis.__file1bMutationApplied=false;
    d.showSaveDialog=async()=>{globalThis.__file1bSaveCalls++;return {canceled:false,filePath:${JSON.stringify(target)}}};
    d.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.__file1bPreviews.push(options);
      if(options.title!=='确认跨目录副本')throw Error('Unexpected native dialog in isolated FILE1B test');
      const mutation=${JSON.stringify(mutation)};if(mutation){await process.mainModule.require('node:fs/promises').writeFile(mutation.file,Buffer.from(mutation.bytes,'base64'));globalThis.__file1bMutationApplied=true;}
      return {response:${response},checkboxChecked:false};};})()`);
}
const apiCopy = () => page.evaluate('window.mermarkd.createSavedDocumentCopy()');
const previews = () => main.evaluate('globalThis.__file1bPreviews');
async function assertPreview(target, count) {
  const items = await previews(); assert.equal(items.length, 1, 'exactly one explicit preview');
  const preview = items[0]; assert.deepEqual(preview.buttons, ['创建副本', '取消']);
  assert.equal(preview.defaultId, 1, 'creation requires an explicit choice'); assert.equal(preview.cancelId, 1);
  const text = `${preview.message ?? ''}\n${preview.detail ?? ''}`;
  assert.ok(text.toLowerCase().includes(path.resolve(target).toLowerCase()), 'preview identifies the full destination');
  assert.equal(Number(text.match(/将创建\s+(\d+)\s*个文件/u)?.[1]), count, 'preview identifies the number of content files');
  return { title: preview.title, files: count, destinationIdentified: true, cancelIsDefault: true };
}
async function screenshot(name) {
  const file = path.join(qa, `${prefix}-${name}.png`), capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' }); return file;
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { child.kill('SIGKILL'); } child = undefined; }
}
async function scenario(name, run) {
  const record = { name, status: 'running', startedAt: new Date().toISOString() }; result.cases.push(record);
  try { Object.assign(record, await run()); record.status = 'passed'; console.log(`passed: ${name}`); }
  catch (error) { record.status = 'failed'; record.error = error.stack ?? String(error); console.log(`failed: ${name}`);
    if (page) record.screenshot = await screenshot(`${name}-failure`).catch(() => undefined); }
  finally { await stop(); record.finishedAt = new Date().toISOString(); }
}
try {
  await scenario('portable-bundle-preview-and-round-trip', async () => {
    const item = await fixture('portable'), before = await snapshot(item.file); await start(item.file); await dialogs(item.target);
    const initialMode = await page.evaluate('document.querySelector(".app-shell").dataset.activeMode');
    await menu(); await click(copySelector);
    await wait(`!document.querySelector('.app-shell')?.inert&&document.body.innerText.includes('已创建')&&document.body.innerText.includes('异地副本.md')`, 'cross-directory copy completed');
    const preview = await assertPreview(item.target, 3);
    assert.equal(await page.evaluate('document.querySelector(".workspace-current-name").textContent'), '原文.md');
    assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), initialMode);
    await exactCopy(item.file, item.target); assert.deepEqual(await snapshot(item.file), before);
    assert.deepEqual((await readdir(item.targetDirectory)).sort(), suffixes.map(suffix => path.basename(item.target) + suffix).sort());
    const annotation = parseAnnotationYaml(await readFile(item.target + suffixes[1], 'utf8'));
    assert.equal(annotation.annotations[0].note, '跨目录独立便签'); assert.equal(annotation.tags[0].name, '保留标签');
    assert.equal(annotation.annotations[0].anchor.basisSha256, '0'.repeat(64));
    await openDocument(item.target);
    const view = await page.evaluate('window.mermarkd.loadAnnotations()'); assert.equal(view.count, 1); assert.ok(view.unresolvedCount >= 1);
    await click('[data-mode="cards"]'); await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'copied canvas');
    const loaded = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.deepEqual(loaded, JSON.parse(await readFile(item.target + suffixes[2], 'utf8')));
    assert.equal(loaded.links[0].from, 'card-1'); assert.equal(loaded.cards.find(card => card.id === 'card-0').descendantsCollapsed, true);
    assert.equal(await page.evaluate('Boolean(document.querySelector(".react-flow__node[data-id=card-1]"))'), false);
    const image = await screenshot('copied-canvas');
    await writeFile(item.target, Buffer.concat([item.bytes, Buffer.from('\r\n副本独立修改。\r\n')]));
    assert.deepEqual(await snapshot(item.file), before, 'editing the copy does not change source bytes or timestamps');
    return { preview, exactThreeFiles: true, originalSessionAndModeRetained: true, pendingAnchorRetained: true, copiedFoldAndArrow: true, independentCopy: true, screenshot: image };
  });
  await scenario('cancel-preview-zero-writes', async () => {
    const item = await fixture('cancel'), before = await snapshot(item.file); await start(item.file); await dialogs(item.target, { response: 1 });
    assert.equal((await apiCopy()).status, 'cancelled'); const preview = await assertPreview(item.target, 3);
    await emptyDestination(item); assert.deepEqual(await snapshot(item.file), before);
    return { preview, canceledZeroWrites: true };
  });
  await scenario('local-markdown-dependencies-refused-before-preview', async () => {
    const cases = [ ['image', '![本地图片](assets/pixel.png)'], ['link', '[本地附件](notes/reference.pdf)'],
      ['reference', '[本地引用][local]\r\n\r\n[local]: assets/file.png'], ['unused-definition', '[unused]: orphan.png'] ];
    for (const [name, extra] of cases) {
      const item = await fixture(`local-${name}`, { extra }), before = await snapshot(item.file); await start(item.file); await dialogs(item.target);
      assert.equal((await apiCopy()).status, 'conflict', name); assert.equal((await previews()).length, 0, name);
      await emptyDestination(item); assert.deepEqual(await snapshot(item.file), before); await stop();
    }
    return { refusedKinds: cases.map(([name]) => name), noConfirmationOrTargetWrites: true };
  });
  await scenario('raw-html-refused-before-preview', async () => {
    const cases = [ ['image', '<img src="assets/pixel.png">'], ['inline-tag', '<em>纯文本 HTML</em>'], ['comment', '<!-- hidden local attachment: assets/file.png -->'] ];
    for (const [name, extra] of cases) {
      const item = await fixture(`html-${name}`, { extra }), before = await snapshot(item.file); await start(item.file); await dialogs(item.target);
      assert.equal((await apiCopy()).status, 'conflict', name); assert.equal((await previews()).length, 0, name);
      await emptyDestination(item); assert.deepEqual(await snapshot(item.file), before); await stop();
    }
    return { refusedKinds: cases.map(([name]) => name), hiddenSourceNotOmitted: true };
  });
  await scenario('preview-time-source-or-companion-change-refused', async () => {
    for (const kind of ['markdown', 'annotations']) {
      const item = await fixture(`changed-${kind}`), before = await snapshot(item.file); await start(item.file);
      const file = item.file + (kind === 'annotations' ? suffixes[1] : '');
      const changed = kind === 'markdown' ? Buffer.concat([item.bytes, Buffer.from('\r\n预览期间的外部修改。\r\n')])
        : Buffer.from((await readFile(file, 'utf8')).replace('跨目录独立便签', '外部更新的便签'));
      await dialogs(item.target, { mutation: { file, bytes: changed.toString('base64') } });
      assert.equal((await apiCopy()).status, 'conflict', kind); await assertPreview(item.target, 3);
      assert.equal(await main.evaluate('globalThis.__file1bMutationApplied'), true);
      await emptyDestination(item); assert.deepEqual(await readFile(file), changed, 'external change is preserved');
      const after = await snapshot(item.file);
      for (let i = 0; i < suffixes.length; i++) if (i !== (kind === 'annotations' ? 1 : 0)) assert.deepEqual(after[i], before[i]);
      await stop();
    }
    return { changedFiles: ['markdown', 'annotations'], stalePreviewCannotPublish: true, externalChangesRetained: true };
  });
  await scenario('existing-target-bundle-members-protected', async () => {
    const item = await fixture('occupied'), before = await snapshot(item.file); await start(item.file);
    for (let i = 0; i < suffixes.length; i++) {
      const target = path.join(item.targetDirectory, `occupied-${i}.md`); await writeFile(target + suffixes[i], 'external target');
      const occupied = await snapshot(target), names = await readdir(item.targetDirectory); await dialogs(target);
      assert.equal((await apiCopy()).status, 'conflict'); assert.equal((await previews()).length, 0);
      assert.deepEqual(await snapshot(target), occupied); assert.deepEqual(await readdir(item.targetDirectory), names);
      assert.deepEqual(await snapshot(item.file), before);
    }
    return { allThreeTargetKindsProtected: true, targetNeverOverwritten: true };
  });
  await scenario('missing-companions-stay-missing-across-directories', async () => {
    const item = await fixture('missing', { companions: false }), before = await snapshot(item.file); await start(item.file); await dialogs(item.target);
    assert.equal((await apiCopy()).status, 'copied'); const preview = await assertPreview(item.target, 1);
    assert.deepEqual(await readFile(item.target), item.bytes); await absent(item.target + suffixes[1]); await absent(item.target + suffixes[2]);
    assert.deepEqual(await readdir(item.targetDirectory), [path.basename(item.target)]); assert.deepEqual(await snapshot(item.file), before);
    return { preview, missingStateRetained: true };
  });
  await scenario('invalid-companion-not-silently-omitted', async () => {
    const item = await fixture('invalid'); await start(item.file);
    await writeFile(item.file + suffixes[1], 'schemaVersion: 999\n'); const before = await snapshot(item.file); await dialogs(item.target);
    assert.equal((await apiCopy()).status, 'conflict'); assert.equal((await previews()).length, 0);
    await emptyDestination(item); assert.deepEqual(await snapshot(item.file), before); return { invalidCompanionPreserved: true };
  });
  await scenario('narrow-menu-can-create-cross-directory-copy', async () => {
    const item = await fixture('narrow'), before = await snapshot(item.file); await start(item.file);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 850, deviceScaleFactor: 1, mobile: false }); await frame(); await menu();
    assert.equal(await page.evaluate(`(()=>{const e=document.querySelector('${copySelector}'),r=e?.getBoundingClientRect();
      return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`), true);
    const image = await screenshot('copy-menu-420'); await dialogs(item.target); await click(copySelector);
    await wait(`!document.querySelector('.app-shell')?.inert&&document.body.innerText.includes('已创建')&&document.body.innerText.includes('异地副本.md')`, 'narrow copy completed');
    await assertPreview(item.target, 3); await exactCopy(item.file, item.target); assert.deepEqual(await snapshot(item.file), before);
    return { width: 420, menuReachable: true, screenshot: image };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stop(); result.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = await realpath(workspace), temporary = await realpath(os.tmpdir());
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.ok(key(resolved).startsWith(key(temporary) + path.sep) && path.basename(resolved).startsWith('mermarkd-file1b-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`FILE1B fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
