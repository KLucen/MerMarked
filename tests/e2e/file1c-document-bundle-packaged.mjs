import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasStateV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'file1c-document-bundle';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve earlier evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-file1c-'));
const extractor = path.join(root, 'tests/fixtures/document-bundle-extract.ps1');
const extractionHost = process.env.MERMARKD_QA_POWERSHELL ?? 'pwsh.exe';
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))), extractorSha256: digest(await readFile(extractor)), extractionHost,
  asarSha256: digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))), cases: [],
  boundary: 'Actual packaged renderer/IPC/filesystem and independent .NET ZIP extraction, generated documents and isolated profiles. Native dialog responses mocked in main. No physical dialog, IME, AX, installation or timing acceptance.' };
let child, page, main, launches = 0;
const menuSelector = 'button[aria-label="文档菜单"]', bundleSelector = '[data-workspace-create-bundle]';
const imageName = '中文 空格😀.png', imageEntry = `assets/${imageName}`;

function png(red = 255) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]), out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); body.copy(out, 4); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 255 - red, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(name, { companions = true, extra = '' } = {}) {
  const directory = path.join(workspace, name), sourceDirectory = path.join(directory, 'source'), targetDirectory = path.join(directory, 'destination');
  await mkdir(path.join(sourceDirectory, 'assets'), { recursive: true }); await mkdir(targetDirectory);
  const href = `assets/${encodeURIComponent(imageName)}`;
  const content = ['---', 'cover: assets/not-copied.png', '---', '', '# 第一章', '', '这是保留中文😀。', '',
    `![第一张](${href})`, `![同一张][picture]`, `[查看图片](${href})`, '', `[picture]: ${href}`, '',
    '[外部网站](https://example.com/reading?q=one#section) [本节](#第一章) [邮件](mailto:reader@example.com)', '',
    '`![代码图片](assets/not-copied.png)`', '', '```md', '[示例](../not-a-document.md)', '```', '', extra, '',
    '## 子章节', '', '子节正文。', '', '# 第二章', '', '第二章正文。'].join('\r\n');
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes), file = path.join(sourceDirectory, '原文.md');
  const imagePath = path.join(sourceDirectory, 'assets', imageName), imageBytes = png();
  await writeFile(file, bytes); await writeFile(imagePath, imageBytes);
  if (companions) {
    const quote = '保留中文😀。', start = 3 + Buffer.byteLength(content.slice(0, content.indexOf(quote)));
    await writeFile(file + suffixes[1], serializeAnnotationYaml({ schemaVersion: 1,
      source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [{ id: 'tag-one', name: '保留标签' }],
      annotations: [{ id: 'note-one', kind: 'note', color: 'amber', tagId: 'tag-one', note: '打包保留的私人便签',
        anchor: { basisSha256: '0'.repeat(64), startByte: start, endByte: start + Buffer.byteLength(quote),
          sourceExact: quote, prefix: '这是', suffix: '\r\n\r\n', displayQuote: quote, sectionHint: '第一章' },
        createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' }] }));
    let id = 0;
    const prepared = await reconcileCanvasStateV2(null, { bytes, content, sha256 }, () => `card-${id++}`);
    assert.equal(prepared.model.cards.length, 3);
    const positions = [{ x: 80, y: 80 }, { x: 24, y: 300 }, { x: 650, y: 90 }];
    const model = { ...prepared.model, cards: prepared.model.cards.map((card, index) => ({
      ...card, position: positions[index], descendantsCollapsed: index === 0 })),
      links: [{ id: 'bundle-link', from: 'card-1', to: 'card-2', label: '保留关系' }], viewport: { x: 120, y: 100, zoom: 0.7 } };
    await writeFile(file + suffixes[2], serializeCanvasStateV2Json(model));
  }
  return { directory, sourceDirectory, targetDirectory, file, target: path.join(targetDirectory, '文档与图片.zip'), bytes, imagePath, imageBytes };
}
async function fileState(file) {
  try { const bytes = await readFile(file), info = await stat(file); return { sha256: digest(bytes), bytes: bytes.length, mtimeMs: info.mtimeMs }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { missing: true }; }
}
const snapshot = item => Promise.all([...suffixes.map(suffix => item.file + suffix), item.imagePath].map(fileState));
async function absent(file) { await assert.rejects(stat(file), error => error.code === 'ENOENT'); }
async function emptyDestination(item) { assert.deepEqual(await readdir(item.targetDirectory), [], 'no published archive or private staging'); }
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
  const shown = await page.evaluate(`Boolean(document.querySelector('${bundleSelector}')?.getClientRects().length)`);
  if (shown !== open) await click(menuSelector);
}
async function openDocument(file) {
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]})`);
  if (await page.evaluate('Boolean(document.querySelector("[data-start-open]"))')) await click('[data-start-open]');
  else { await menu(); assert.equal(await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.workspace-popover-panel button')]
    .find(e=>e.getClientRects().length&&e.textContent.trim().startsWith('打开文档'));if(!b)return false;b.dataset.file1Open='true';return true;})()`), true); await click('[data-file1-open]'); }
  await wait(`(async()=>{const rows=await window.mermarkd.listRecentDocuments();return rows[0]?.path.toLowerCase()===${JSON.stringify(path.resolve(file).toLowerCase())};})()`, 'requested document became current');
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'`, 'document ready');
  await menu(); await wait(`document.querySelector('${bundleSelector}')?.disabled===false`, 'bundle entry ready'); await menu(false);
}
async function start(file) {
  const port = 20800 + Math.floor(Math.random() * 350);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`,
    `--user-data-dir=${path.join(workspace, `profile-${++launches}`)}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open]"))', 'start page'); await openDocument(file);
}
async function dialogs(target, { response = 0, saveCanceled = false, mutation = null } = {}) {
  await main.evaluate(`(()=>{const d=process.mainModule.require('electron').dialog;
    globalThis.__file1cSaveCalls=0;globalThis.__file1cPreviews=[];globalThis.__file1cMutationApplied=false;
    d.showSaveDialog=async()=>{globalThis.__file1cSaveCalls++;return {canceled:${saveCanceled},filePath:${JSON.stringify(target)}}};
    d.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.__file1cPreviews.push(options);
      if(options.title!=='确认文档副本包')throw Error('Unexpected native dialog in isolated FILE1C test');
      const mutation=${JSON.stringify(mutation)};if(mutation){await process.mainModule.require('node:fs/promises').writeFile(mutation.file,Buffer.from(mutation.bytes,'base64'));globalThis.__file1cMutationApplied=true;}
      return {response:${response},checkboxChecked:false};};})()`);
}
const apiBundle = () => page.evaluate('window.mermarkd.createSavedDocumentBundle()');
const previews = () => main.evaluate('globalThis.__file1cPreviews');
async function assertPreview(target, count, totalBytes, companions = true) {
  const items = await previews(); assert.equal(items.length, 1);
  const preview = items[0]; assert.deepEqual(preview.buttons, ['创建副本包', '取消']); assert.equal(preview.defaultId, 1); assert.equal(preview.cancelId, 1);
  const text = `${preview.message ?? ''}\n${preview.detail ?? ''}`;
  assert.ok(text.toLowerCase().includes(path.resolve(target).toLowerCase()), 'preview identifies destination');
  assert.equal(Number(text.match(/共\s+(\d+)\s*个文件/u)?.[1]), count, 'preview identifies the exact file count');
  assert.equal(Number(text.match(/其中\s+(\d+)\s*张图片/u)?.[1]), 1, 'preview identifies the unique image count');
  assert.equal(Number(text.match(/内容合计\s+(\d+)\s*字节/u)?.[1]), totalBytes, 'preview identifies exact total input bytes');
  assert.ok(text.includes(imageEntry), 'preview identifies the relative image');
  if (companions) assert.match(text, /批注|便签/u, 'saved notes are explicitly included');
  return { title: preview.title, files: count, images: 1, totalBytes, destinationIdentified: true, cancelIsDefault: true };
}
async function screenshot(name) {
  const file = path.join(qa, `${prefix}-${name}.png`), capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(capture.data, 'base64'), { flag: 'wx' }); return file;
}
async function extract(item, name = 'extracted') {
  const destination = path.join(item.directory, name); await mkdir(destination);
  const stdout = execFileSync(extractionHost, ['-NoProfile', '-NonInteractive', '-File', extractor,
    '-Archive', item.target, '-Destination', destination], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return { directory: destination, ...JSON.parse(stdout.trim()) };
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
  await scenario('document-and-local-image-zip-round-trip', async () => {
    const item = await fixture('complete'), before = await snapshot(item); await start(item.file); await dialogs(item.target);
    const initialMode = await page.evaluate('document.querySelector(".app-shell").dataset.activeMode');
    await menu(); await click(bundleSelector);
    await wait(`!document.querySelector('.app-shell')?.inert&&document.body.innerText.includes('已创建副本包')`, 'bundle completed');
    const totalBytes = before.reduce((sum, file) => sum + file.bytes, 0), preview = await assertPreview(item.target, 4, totalBytes);
    assert.equal(await page.evaluate('document.querySelector(".workspace-current-name").textContent'), '原文.md');
    assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), initialMode);
    assert.deepEqual(await readdir(item.targetDirectory), [path.basename(item.target)]); assert.deepEqual(await snapshot(item), before);
    const decoded = await extract(item), extracted = path.join(decoded.directory, path.basename(item.file));
    assert.equal(decoded.decoder, 'System.IO.Compression.ZipFile');
    assert.deepEqual(decoded.files.sort(), [...suffixes.map(suffix => path.basename(item.file) + suffix), imageEntry].sort());
    assert.equal(decoded.totalBytes, totalBytes);
    for (const suffix of suffixes) assert.deepEqual(await readFile(extracted + suffix), await readFile(item.file + suffix));
    assert.deepEqual(await readFile(path.join(decoded.directory, imageEntry)), item.imageBytes);
    const annotation = parseAnnotationYaml(await readFile(extracted + suffixes[1], 'utf8'));
    assert.equal(annotation.annotations[0].anchor.basisSha256, '0'.repeat(64)); assert.equal(annotation.annotations[0].note, '打包保留的私人便签');
    await openDocument(extracted);
    await wait('[...document.querySelectorAll(".markdown-body img")].length===2&&[...document.querySelectorAll(".markdown-body img")].every(i=>i.complete&&i.naturalWidth===1)', 'extracted relative images decoded');
    const view = await page.evaluate('window.mermarkd.loadAnnotations()'); assert.equal(view.count, 1); assert.ok(view.unresolvedCount >= 1);
    await click('[data-mode="cards"]'); await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'extracted canvas ready');
    const loaded = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.deepEqual(loaded, JSON.parse(await readFile(extracted + suffixes[2], 'utf8'))); assert.equal(loaded.links[0].from, 'card-1');
    assert.equal(await page.evaluate('Boolean(document.querySelector(".react-flow__node[data-id=card-1]"))'), false);
    const shot = await screenshot('extracted-canvas');
    await writeFile(extracted, Buffer.concat([item.bytes, Buffer.from('\r\n解压副本独立修改。\r\n')]));
    await writeFile(path.join(decoded.directory, imageEntry), png(0)); assert.deepEqual(await snapshot(item), before);
    return { preview, independentDecoder: decoded.decoder, exactSourceAndCompanions: true, originalSessionAndModeRetained: true,
      encodedUnicodePathRetained: true, duplicateImageDeduplicated: true, extractedImagesDecoded: true, copiedFoldAndArrow: true,
      pendingBasisRetained: true, independentExtractedFiles: true, screenshot: shot };
  });
  await scenario('save-and-preview-cancellation-zero-writes', async () => {
    for (const saveCanceled of [true, false]) {
      const item = await fixture(`cancel-${saveCanceled}`), before = await snapshot(item); await start(item.file);
      await dialogs(item.target, { response: 1, saveCanceled }); assert.equal((await apiBundle()).status, 'cancelled');
      assert.equal((await previews()).length, saveCanceled ? 0 : 1); await emptyDestination(item); assert.deepEqual(await snapshot(item), before); await stop();
    }
    return { saveCancellationZeroWrites: true, previewCancellationZeroWrites: true };
  });
  await scenario('unsupported-resource-plans-refused', async () => {
    const cases = [['parent', '![外部](../outside.png)'], ['html', '<img src="assets/anything.png">'], ['document', '[另文](other.md)'],
      ['query', '![带参数](assets/a.png?raw=1)'], ['scheme', '[未知](custom:attachment)']];
    for (const [name, extra] of cases) {
      const item = await fixture(`blocked-${name}`, { extra }), before = await snapshot(item); await start(item.file); await dialogs(item.target);
      assert.equal((await apiBundle()).status, 'conflict', name); assert.equal((await previews()).length, 0); await emptyDestination(item);
      assert.deepEqual(await snapshot(item), before); await stop();
    }
    return { refusedKinds: cases.map(([name]) => name), noSilentBrokenBundle: true };
  });
  await scenario('missing-and-invalid-image-refused', async () => {
    for (const kind of ['missing', 'bad-header']) {
      const item = await fixture(`image-${kind}`); if (kind === 'missing') await rm(item.imagePath); else await writeFile(item.imagePath, '<svg>not a PNG</svg>');
      const before = await snapshot(item); await start(item.file); await dialogs(item.target);
      assert.equal((await apiBundle()).status, 'conflict', kind); assert.equal((await previews()).length, 0); await emptyDestination(item);
      assert.deepEqual(await snapshot(item), before); await stop();
    }
    return { imageMustExistAndMatchSupportedHeader: true };
  });
  await scenario('preview-time-source-companion-or-image-change-refused', async () => {
    for (const kind of ['markdown', 'annotations', 'image']) {
      const item = await fixture(`changed-${kind}`), before = await snapshot(item); await start(item.file);
      const changedFile = kind === 'image' ? item.imagePath : item.file + (kind === 'annotations' ? suffixes[1] : '');
      const changed = kind === 'image' ? png(0) : kind === 'markdown' ? Buffer.concat([item.bytes, Buffer.from('\r\n外部正文更新。\r\n')])
        : Buffer.from((await readFile(changedFile, 'utf8')).replace('打包保留的私人便签', '外部更新的私人便签'));
      await dialogs(item.target, { mutation: { file: changedFile, bytes: changed.toString('base64') } });
      assert.equal((await apiBundle()).status, 'conflict', kind); assert.equal((await previews()).length, 1); await emptyDestination(item);
      assert.equal(await main.evaluate('globalThis.__file1cMutationApplied'), true); assert.deepEqual(await readFile(changedFile), changed);
      const after = await snapshot(item), changedIndex = kind === 'image' ? 3 : kind === 'annotations' ? 1 : 0;
      for (let i = 0; i < after.length; i++) if (i !== changedIndex) assert.deepEqual(after[i], before[i]); await stop();
    }
    return { stalePreviewCannotPublish: true, changedFiles: ['markdown', 'annotations', 'image'], externalChangesRetained: true };
  });
  await scenario('existing-archive-is-never-overwritten', async () => {
    const item = await fixture('occupied'), before = await snapshot(item); await writeFile(item.target, 'existing external archive');
    const occupied = await fileState(item.target); await start(item.file); await dialogs(item.target);
    assert.equal((await apiBundle()).status, 'conflict'); assert.equal((await previews()).length, 0);
    assert.deepEqual(await fileState(item.target), occupied); assert.deepEqual(await readdir(item.targetDirectory), [path.basename(item.target)]);
    assert.deepEqual(await snapshot(item), before); return { existingArchiveRetained: true };
  });
  await scenario('missing-companions-stay-missing-in-zip', async () => {
    const item = await fixture('missing-companions', { companions: false }), before = await snapshot(item); await start(item.file); await dialogs(item.target);
    assert.equal((await apiBundle()).status, 'copied'); await assertPreview(item.target, 2, before[0].bytes + before[3].bytes, false);
    const decoded = await extract(item); assert.deepEqual(decoded.files.sort(), [path.basename(item.file), imageEntry].sort());
    await absent(path.join(decoded.directory, path.basename(item.file) + suffixes[1])); await absent(path.join(decoded.directory, path.basename(item.file) + suffixes[2]));
    assert.deepEqual(await snapshot(item), before); return { noInventedCompanions: true, independentDecoder: decoded.decoder };
  });
  await scenario('invalid-companion-not-silently-omitted', async () => {
    const item = await fixture('invalid-companion'); await start(item.file); await writeFile(item.file + suffixes[1], 'schemaVersion: 999\n');
    const before = await snapshot(item); await dialogs(item.target); assert.equal((await apiBundle()).status, 'conflict');
    assert.equal((await previews()).length, 0); await emptyDestination(item); assert.deepEqual(await snapshot(item), before);
    return { invalidSidecarRetained: true };
  });
  await scenario('dirty-source-input-retained-and-dialog-not-opened', async () => {
    const item = await fixture('dirty'), before = await snapshot(item); await start(item.file);
    await click('[data-mode="editor"]'); await wait('Boolean(document.querySelector(".cm-content[contenteditable=true]"))', 'source surface');
    await page.evaluate('document.querySelector(".cm-content").focus()'); await page.send('Input.insertText', { text: 'BUNDLE-DIRTY-未保存' });
    await wait('document.querySelector(".app-shell")?.dataset.dirty==="true"', 'dirty source');
    await frame(); await page.evaluate('document.activeElement?.blur()'); await frame(); await dialogs(item.target); await menu(); await click(bundleSelector);
    await wait('document.body.innerText.includes("请先保存正文")', 'bundle input guard');
    assert.ok(await page.evaluate('document.querySelector(".cm-content").textContent.includes("BUNDLE-DIRTY-未保存")'));
    assert.equal(await main.evaluate('globalThis.__file1cSaveCalls'), 0); assert.equal((await apiBundle()).status, 'conflict');
    assert.equal(await main.evaluate('globalThis.__file1cSaveCalls'), 0); await emptyDestination(item); assert.deepEqual(await snapshot(item), before);
    return { rendererAndMainDirtyGuards: true, inputRetained: true };
  });
  await scenario('narrow-menu-can-create-document-bundle', async () => {
    const item = await fixture('narrow'), before = await snapshot(item); await start(item.file);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 850, deviceScaleFactor: 1, mobile: false }); await frame(); await menu();
    assert.equal(await page.evaluate(`(()=>{const e=document.querySelector('${bundleSelector}'),r=e?.getBoundingClientRect();
      return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`), true);
    const shot = await screenshot('bundle-menu-420'); await dialogs(item.target); await click(bundleSelector);
    await wait(`!document.querySelector('.app-shell')?.inert&&document.body.innerText.includes('已创建副本包')`, 'narrow bundle completed');
    await assertPreview(item.target, 4, before.reduce((sum, file) => sum + file.bytes, 0)); const decoded = await extract(item);
    assert.equal(decoded.files.length, 4); assert.deepEqual(await snapshot(item), before);
    return { width: 420, menuReachable: true, independentDecoder: decoded.decoder, screenshot: shot };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stop(); result.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = await realpath(workspace), temporary = await realpath(os.tmpdir());
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.ok(key(resolved).startsWith(key(temporary) + path.sep) && path.basename(resolved).startsWith('mermarkd-file1c-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`FILE1C fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
