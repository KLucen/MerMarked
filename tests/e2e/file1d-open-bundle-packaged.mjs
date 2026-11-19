import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasStateV2, serializeCanvasStateV2Json } from '../../src/core/canvas-state-v2.ts';
import { planDocumentBundle } from '../../src/core/document-bundle-plan.ts';
import { createSavedDocumentBundle } from '../../src/main/document-bundle-store.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'file1d-open-bundle';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'preserve earlier evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-file1d-'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const imageName = '中文 空格😀.png', imageEntry = `assets/${imageName}`;
const menuSelector = 'button[aria-label="文档菜单"]', bundleSelector = '[data-workspace-open-bundle]';
const result = { status: 'running', startedAt: new Date().toISOString(), executable,
  scriptSha256: digest(await readFile(fileURLToPath(import.meta.url))),
  asarSha256: digest(await readFile(path.join(path.dirname(executable), 'resources/app.asar'))), cases: [],
  boundary: 'Actual packaged renderer/IPC/filesystem, generated producer ZIPs and isolated absolute profiles. Native dialogs mocked by title. No physical dialog, IME, AX, installation or timing acceptance.' };
let child, page, main, launches = 0;

function png() {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]), output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length); body.copy(output, 4); output.writeUInt32BE(crc32(body), output.length - 4); return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
async function fixture(name) {
  const directory = path.join(workspace, name), sourceDirectory = path.join(directory, 'source'), parent = path.join(directory, 'destination');
  await mkdir(path.join(sourceDirectory, 'assets'), { recursive: true }); await mkdir(parent);
  const href = `assets/${encodeURIComponent(imageName)}`;
  const content = ['---', 'cover: assets/not-copied.png', '---', '', '# 第一章', '', '这是保留中文😀。', '',
    `![第一张](${href})`, '![同一张][picture]', `[查看图片](${href})`, '', `[picture]: ${href}`, '',
    '[外部网站](https://example.com/reading?q=one#section) [本节](#第一章) [邮件](mailto:reader@example.com)', '',
    '`![代码图片](assets/not-copied.png)`', '', '```md', '[示例](../not-a-document.md)', '```', '',
    '## 子章节', '', '子节正文。', '', '# 第二章', '', '第二章正文。'].join('\r\n');
  const bytes = Buffer.from('\ufeff' + content), sha256 = digest(bytes), file = path.join(sourceDirectory, '原文.md');
  const imagePath = path.join(sourceDirectory, 'assets', imageName), imageBytes = png(), archive = path.join(directory, '文档与图片.zip');
  await writeFile(file, bytes); await writeFile(imagePath, imageBytes);
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
  const model = { ...prepared.model, cards: prepared.model.cards.map((card, index) => ({ ...card,
    position: positions[index], descendantsCollapsed: index === 0 })),
    links: [{ id: 'bundle-link', from: 'card-1', to: 'card-2', label: '保留关系' }], viewport: { x: 120, y: 100, zoom: 0.7 } };
  await writeFile(file + suffixes[2], serializeCanvasStateV2Json(model));
  const entries = await Promise.all([...suffixes.map(suffix => ({ path: path.basename(file) + suffix, file: file + suffix })),
    { path: imageEntry, file: imagePath }].map(async entry => ({ path: entry.path, data: await readFile(entry.file) })));
  const receipt = await createSavedDocumentBundle({ sourcePath: file, targetPath: archive, expectedSourceSha256: sha256,
    planSnapshot: async files => {
      const plan = await planDocumentBundle(files[0].bytes.toString('utf8').replace(/^\ufeff/, ''));
      assert.equal(plan.portable, true); assert.deepEqual(plan.images, [{ path: imageEntry }]); return plan.images.map(image => image.path);
    }, review: async summary => { assert.equal(summary.files.length, 4); assert.equal(summary.imageCount, 1); } });
  return { directory, sourceDirectory, parent, file, bytes, imagePath, imageBytes, archive, entries, receipt };
}
async function fileState(file) {
  const bytes = await readFile(file), info = await stat(file); return { sha256: digest(bytes), bytes: bytes.length, mtimeMs: info.mtimeMs };
}
const snapshot = item => Promise.all([...suffixes.map(suffix => item.file + suffix), item.imagePath].map(fileState));
async function emptyDestination(item) { assert.deepEqual(await readdir(item.parent), [], 'no output or private staging before approval'); }
async function tree(directory, prefix = '') {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name; assert.equal(entry.isSymbolicLink(), false, 'import does not introduce links');
    if (entry.isDirectory()) rows.push(...await tree(path.join(directory, entry.name), relative + '/'));
    else { assert.equal(entry.isFile(), true); rows.push(relative); }
  }
  return rows.sort();
}
async function assertImported(item, directory) {
  assert.equal(path.dirname(directory).toLowerCase(), item.parent.toLowerCase());
  assert.match(path.basename(directory), /^原文 - 副本-[a-f0-9]{8}$/u);
  assert.deepEqual(await tree(directory), item.entries.map(entry => entry.path).sort());
  for (const entry of item.entries) assert.deepEqual(await readFile(path.join(directory, entry.path)), entry.data, entry.path);
  return path.join(directory, path.basename(item.file));
}
// This intentionally independent stored-ZIP builder creates CRC-correct but unsafe
// archives the real producer refuses to create. It is never used for valid fixtures.
function unsafeArchive(entries) {
  const local = [], central = []; let offset = 0, centralSize = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path), data = Buffer.from(entry.data), crc = crc32(data), header = Buffer.alloc(30), record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8); record.writeUInt16LE(33, 14); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(0x20, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + name.length + data.length; centralSize += record.length + name.length;
  }
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, ...central, end]);
}
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
async function currentPath() { return page.evaluate('(async()=>(await window.mermarkd.listRecentDocuments())[0]?.path??null)()'); }
async function ready(file) {
  await wait(`(async()=>(await window.mermarkd.listRecentDocuments())[0]?.path.toLowerCase()===${JSON.stringify(path.resolve(file).toLowerCase())})()`, 'requested real path recorded');
  await wait(`document.querySelector('.workspace-current-name')?.textContent===${JSON.stringify(path.basename(file))}
    &&document.querySelector('.workspace-current-name')?.title.toLowerCase()===${JSON.stringify(path.resolve(file).toLowerCase())}
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'`, 'document ready');
}
async function openDocument(file) {
  await main.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(file)}]})`);
  if (await page.evaluate('Boolean(document.querySelector("[data-start-open]"))')) await click('[data-start-open]');
  else { await menu(); assert.equal(await page.evaluate(`(()=>{const b=[...document.querySelectorAll('.workspace-popover-panel button')]
    .find(e=>e.getClientRects().length&&e.textContent.trim().startsWith('打开文档'));if(!b)return false;b.dataset.file1dOpen='true';return true;})()`), true); await click('[data-file1d-open]'); }
  await ready(file);
}
async function start(file) {
  const port = 21200 + Math.floor(Math.random() * 350);
  child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`,
    `--user-data-dir=${path.join(workspace, `profile-${++launches}`)}`], { cwd: root, stdio: 'ignore' });
  page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
  if (process.env.MERMARKD_QA_RENDERER_URL) await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 850, deviceScaleFactor: 1, mobile: false });
  await wait('Boolean(document.querySelector("[data-start-open-bundle]"))', 'start bundle action'); if (file) await openDocument(file);
}
async function dialogs(item, { cancel = null, leave = 2, mutation = null } = {}) {
  await main.evaluate(`(()=>{const d=process.mainModule.require('electron').dialog;globalThis.__file1dCalls=[];
    globalThis.__file1dSourceAtArchiveSelection=null;
    d.showOpenDialog=async(...args)=>{const o=args.at(-1);globalThis.__file1dCalls.push(o);
      if(o.title==='打开文档副本包'){
        globalThis.__file1dSourceAtArchiveSelection=(await process.mainModule.require('node:fs/promises').readFile(${JSON.stringify(item.file)})).toString('base64');
        return {canceled:${cancel === 'archive'},filePaths:[${JSON.stringify(item.archive)}]};}
      if(o.title==='选择副本包解包位置')return {canceled:${cancel === 'parent'},filePaths:[${JSON.stringify(item.parent)}]};
      throw Error('Unexpected native open dialog in isolated FILE1D test');};
    d.showMessageBox=async(...args)=>{const o=args.at(-1);globalThis.__file1dCalls.push(o);
      if(o.title==='正文尚未保存')return {response:${leave},checkboxChecked:false};
      if(o.title==='确认打开副本包'){
        const mutation=${JSON.stringify(mutation)};if(mutation)await process.mainModule.require('node:fs/promises').writeFile(mutation.file,Buffer.from(mutation.bytes,'base64'));
        return {response:${cancel === 'preview' ? 1 : 0},checkboxChecked:false};}
      throw Error('Unexpected native message box in isolated FILE1D test');};})()`);
}
const calls = () => main.evaluate('globalThis.__file1dCalls');
const archiveCalls = async () => (await calls()).filter(call => call.title === '打开文档副本包');
async function waitNative(count) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if ((await calls()).length >= count) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error(`Timed out waiting for ${count} native dialogs`);
}
async function assertPreview(item) {
  const dialogs = await calls(), selections = dialogs.filter(call => call.properties);
  assert.deepEqual(selections.map(call => call.title), ['打开文档副本包', '选择副本包解包位置']);
  assert.ok(selections[0].properties.includes('openFile')); assert.ok(selections[1].properties.includes('openDirectory'));
  const previews = dialogs.filter(call => call.title === '确认打开副本包'); assert.equal(previews.length, 1);
  const preview = previews[0], text = `${preview.message ?? ''}\n${preview.detail ?? ''}`;
  assert.deepEqual(preview.buttons, ['解包并打开', '取消']); assert.equal(preview.defaultId, 1); assert.equal(preview.cancelId, 1);
  const directory = text.match(/新文件夹：([^\r\n]+)/u)?.[1]; assert.ok(directory && path.isAbsolute(directory), 'preview names absolute new directory');
  assert.equal(path.dirname(directory).toLowerCase(), item.parent.toLowerCase()); assert.match(path.basename(directory), /^原文 - 副本-[a-f0-9]{8}$/u);
  assert.equal(Number(text.match(/共\s+(\d+)\s*个文件/u)?.[1]), item.entries.length);
  assert.equal(Number(text.match(/其中\s+(\d+)\s*张图片/u)?.[1]), 1);
  assert.equal(Number(text.match(/内容合计\s+(\d+)\s*字节/u)?.[1]), item.entries.reduce((sum, entry) => sum + entry.data.length, 0));
  assert.match(text, /包含已有批注与便签/u); return directory;
}
async function beginImport(startPage = false) { if (!startPage) await menu(); await click(startPage ? '[data-start-open-bundle]' : bundleSelector); }
async function importedDocument(item) {
  await wait(`(async()=>{const p=(await window.mermarkd.listRecentDocuments())[0]?.path;return !!p&&p.toLowerCase().startsWith(${JSON.stringify((item.parent + path.sep).toLowerCase())})})()`, 'imported document replaced session');
  const file = await currentPath(); await ready(file); assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), 'reader'); return file;
}
async function rejectedImport() {
  const failure = await page.evaluate(`window.mermarkd.openDocumentBundle().then(value=>({rejected:false,value}),error=>({rejected:true,message:error.message}))`);
  assert.equal(failure.rejected, true); assert.match(failure.message, /副本包|未保存|保存正文/u); return failure.message;
}
async function unchangedSession(item, mode) {
  assert.equal((await currentPath()).toLowerCase(), item.file.toLowerCase());
  assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.activeMode'), mode);
  assert.equal(await page.evaluate('document.querySelector(".workspace-current-name").textContent'), path.basename(item.file));
}
async function dirty(text) {
  await click('[data-mode="editor"]'); await wait('Boolean(document.querySelector(".cm-content[contenteditable=true]"))', 'source surface');
  await page.evaluate('document.querySelector(".cm-content").focus()'); await page.send('Input.insertText', { text });
  await wait('document.querySelector(".app-shell")?.dataset.dirty==="true"', 'dirty source');
  await frame(); await page.evaluate('document.activeElement?.blur()'); await frame();
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
  await scenario('start-page-import-exact-tree-images-notes-canvas', async () => {
    const item = await fixture('start'), before = await snapshot(item), archiveBefore = await fileState(item.archive);
    await start(); await dialogs(item); await beginImport(true); const file = await importedDocument(item), directory = await assertPreview(item);
    assert.equal(file, await assertImported(item, directory)); assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    await wait('[...document.querySelectorAll(".markdown-body img")].length===2&&[...document.querySelectorAll(".markdown-body img")].every(i=>i.complete&&i.naturalWidth===1)', 'imported images decode');
    const annotations = parseAnnotationYaml(await readFile(file + suffixes[1], 'utf8')); assert.equal(annotations.annotations[0].anchor.basisSha256, '0'.repeat(64));
    assert.equal(annotations.annotations[0].note, '打包保留的私人便签');
    const view = await page.evaluate('window.mermarkd.loadAnnotations()'); assert.equal(view.count, 1); assert.ok(view.unresolvedCount >= 1);
    await click('[data-mode="cards"]'); await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'imported canvas ready');
    const model = (await page.evaluate('window.mermarkd.loadCanvasV2()')).model;
    assert.deepEqual(model, JSON.parse(await readFile(file + suffixes[2], 'utf8'))); assert.equal(model.links[0].from, 'card-1');
    assert.equal(await page.evaluate('Boolean(document.querySelector(".react-flow__node[data-id=card-1]"))'), false);
    assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { exactBomCrlfUnicodeAndCompanions: true, uniqueImageCount: 1, repeatedImagesDecoded: 2, pendingBasisRetained: true,
      foldAndArrowRetained: true, recentPath: file, archiveUnchanged: true, screenshot: await screenshot('imported-canvas') };
  });
  await scenario('menu-import-keeps-original-document-and-companions', async () => {
    const item = await fixture('menu'), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
    await dialogs(item); await beginImport(); const file = await importedDocument(item), directory = await assertPreview(item);
    assert.equal(file, await assertImported(item, directory)); assert.notEqual(file, item.file);
    assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { actualMenuEntry: true, independentDirectory: directory, originalThreeFilesAndImageUnchanged: true };
  });
  await scenario('archive-parent-preview-cancel-zero-output-and-mode-retained', async () => {
    for (const cancel of ['archive', 'parent', 'preview']) {
      const item = await fixture(`cancel-${cancel}`), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
      await click('[data-mode="editor"]'); await dialogs(item, { cancel }); await beginImport();
      const expectedCalls = cancel === 'archive' ? 1 : cancel === 'parent' ? 2 : 3;
      await waitNative(expectedCalls);
      await wait(`!document.querySelector('.app-shell')?.inert&&document.querySelector('${menuSelector}')?.disabled===false`, 'cancelled intent idle');
      assert.equal((await calls()).length, expectedCalls); await unchangedSession(item, 'editor'); await emptyDestination(item);
      assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore); await stop();
    }
    return { archiveCancel: true, parentCancel: true, previewCancel: true, zeroOutput: true, editorModeRetained: true };
  });
  await scenario('malformed-crc-and-traversal-rejected-before-parent-dialog', async () => {
    for (const kind of ['malformed', 'crc', 'traversal']) {
      const item = await fixture(`unsafe-${kind}`), before = await snapshot(item);
      let bytes = await readFile(item.archive);
      if (kind === 'malformed') bytes = Buffer.from('not a zip archive');
      if (kind === 'crc') { bytes = Buffer.from(bytes); bytes[30 + bytes.readUInt16LE(26)] ^= 1; }
      if (kind === 'traversal') bytes = unsafeArchive([{ path: '../outside.md', data: item.bytes }]);
      await writeFile(item.archive, bytes); const archiveBefore = await fileState(item.archive); await start(item.file); await dialogs(item);
      if (kind === 'malformed') {
        await beginImport(); await wait('document.body.innerText.includes("无法安全打开副本包")&&Boolean(document.querySelector("[data-document-intent-retry]"))', 'renderer presents safe failure and retry');
      } else await rejectedImport();
      assert.deepEqual((await calls()).map(call => call.title), ['打开文档副本包']);
      await unchangedSession(item, 'reader'); await emptyDestination(item); assert.deepEqual(await snapshot(item), before);
      assert.deepEqual(await fileState(item.archive), archiveBefore); await stop();
    }
    return { rejected: ['malformed ZIP', 'bad CRC', 'zip-slip'], parentDialogNotOpened: true, noOutput: true };
  });
  await scenario('extra-missing-and-html-payload-refused-before-parent-dialog', async () => {
    const variants = ['extra', 'missing-image', 'html', 'annotations-invalid', 'annotations-unknown-schema',
      'canvas-invalid', 'canvas-unknown-schema', 'annotations-invalid-utf8', 'canvas-invalid-utf8'];
    for (const kind of variants) {
      const item = await fixture(`semantic-${kind}`), before = await snapshot(item); let entries = item.entries;
      if (kind === 'extra') entries = [...entries, { path: 'unlisted.png', data: png() }];
      if (kind === 'missing-image') entries = entries.filter(entry => entry.path !== imageEntry);
      if (kind === 'html') entries = entries.map(entry => entry.path.endsWith('.md') ? { ...entry, data: Buffer.from('<img src="assets/unsafe.png">') } : entry);
      if (kind.startsWith('annotations-')) entries = entries.map(entry => {
        if (!entry.path.endsWith(suffixes[1])) return entry;
        const data = kind === 'annotations-invalid' ? Buffer.from('schemaVersion: [unterminated\n')
          : kind === 'annotations-unknown-schema' ? Buffer.from(entry.data.toString('utf8').replace('schemaVersion: 1', 'schemaVersion: 999'))
          : Buffer.concat([entry.data, Buffer.from([0xff])]);
        assert.notDeepEqual(data, entry.data, 'annotation variant changes only the archive payload'); return { ...entry, data };
      });
      if (kind.startsWith('canvas-')) entries = entries.map(entry => {
        if (!entry.path.endsWith(suffixes[2])) return entry;
        const data = kind === 'canvas-invalid' ? Buffer.from('{"schemaVersion":2,')
          : kind === 'canvas-unknown-schema' ? Buffer.from(JSON.stringify({ ...JSON.parse(entry.data.toString('utf8')), schemaVersion: 999 }))
          : Buffer.concat([entry.data, Buffer.from([0xff])]);
        assert.notDeepEqual(data, entry.data, 'canvas variant changes only the archive payload'); return { ...entry, data };
      });
      await writeFile(item.archive, unsafeArchive(entries)); const archiveBefore = await fileState(item.archive); await start(item.file); await dialogs(item);
      await rejectedImport(); assert.deepEqual((await calls()).map(call => call.title), ['打开文档副本包']);
      await unchangedSession(item, 'reader'); await emptyDestination(item); assert.deepEqual(await snapshot(item), before);
      assert.deepEqual(await fileState(item.archive), archiveBefore); await stop();
    }
    return { refused: variants, noSilentPartialBundle: true };
  });
  await scenario('existing-parent-files-preserved-and-second-import-independent', async () => {
    const item = await fixture('occupied'), sentinel = path.join(item.parent, '已有文件.txt'); await writeFile(sentinel, '不得覆盖');
    const sentinelBefore = await fileState(sentinel), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
    const directories = [];
    for (let i = 0; i < 2; i++) {
      await dialogs(item); await beginImport();
      await wait(`(async()=>{const p=(await window.mermarkd.listRecentDocuments())[0]?.path;return !!p&&p.toLowerCase().startsWith(${JSON.stringify((item.parent + path.sep).toLowerCase())})&&p!==${JSON.stringify(i ? path.join(directories[0], path.basename(item.file)) : item.file)}})()`, 'fresh import path');
      const directory = await assertPreview(item), file = await currentPath(); await ready(file); assert.equal(file, await assertImported(item, directory)); directories.push(directory);
    }
    assert.notEqual(directories[0], directories[1]); assert.equal((await readdir(item.parent)).length, 3);
    await assertImported(item, directories[0]); assert.deepEqual(await fileState(sentinel), sentinelBefore);
    assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { independentDirectories: directories, existingParentFileUnchanged: true, repeatedImportNeverOverwrites: true };
  });
  await scenario('dirty-cancel-and-direct-ipc-guard-retain-input', async () => {
    const item = await fixture('dirty-cancel'), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
    await dirty('FILE1D-DIRTY-未保存'); await dialogs(item, { leave: 2 }); await beginImport();
    await waitNative(1);
    await wait('!document.querySelector(".app-shell")?.inert', 'dirty cancellation unlocked');
    assert.deepEqual((await calls()).map(call => call.title), ['正文尚未保存']); assert.equal((await archiveCalls()).length, 0);
    assert.ok(await page.evaluate('document.querySelector(".cm-content").textContent.includes("FILE1D-DIRTY-未保存")'));
    await rejectedImport(); assert.equal((await archiveCalls()).length, 0); await unchangedSession(item, 'editor'); await emptyDestination(item);
    assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { sharedLeaveGuardCancelled: true, directMainGuard: true, inputRetained: true, archiveDialogCount: 0 };
  });
  await scenario('dirty-save-continues-import-with-source-saved-first', async () => {
    const item = await fixture('dirty-save'), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
    await dirty('FILE1D-SAVE-先保存'); await dialogs(item, { leave: 0 }); await beginImport();
    const file = await importedDocument(item), directory = await assertPreview(item); assert.equal(file, await assertImported(item, directory));
    assert.match(await readFile(item.file, 'utf8'), /FILE1D-SAVE-先保存/u);
    assert.match(Buffer.from(await main.evaluate('globalThis.__file1dSourceAtArchiveSelection'), 'base64').toString('utf8'), /FILE1D-SAVE-先保存/u);
    assert.deepEqual((await calls()).map(call => call.title), ['正文尚未保存', '打开文档副本包', '选择副本包解包位置', '确认打开副本包']);
    const after = await snapshot(item); assert.notEqual(after[0].sha256, before[0].sha256);
    const annotations = parseAnnotationYaml(await readFile(item.file + suffixes[1], 'utf8'));
    assert.equal(annotations.annotations[0].note, '打包保留的私人便签');
    assert.equal(annotations.annotations[0].anchor.basisSha256, '0'.repeat(64));
    assert.deepEqual(after.slice(2), before.slice(2)); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { saveBeforeArchiveDialog: true, originalSourceSaved: true, bundleStillContainsOriginalExactSnapshot: true, importedReader: true };
  });
  await scenario('dirty-discard-continues-import-with-original-source-retained', async () => {
    const item = await fixture('dirty-discard'), before = await snapshot(item), archiveBefore = await fileState(item.archive); await start(item.file);
    await dirty('FILE1D-DISCARD-放弃'); await dialogs(item, { leave: 1 }); await beginImport();
    const file = await importedDocument(item), directory = await assertPreview(item); assert.equal(file, await assertImported(item, directory));
    assert.deepEqual((await calls()).map(call => call.title), ['正文尚未保存', '打开文档副本包', '选择副本包解包位置', '确认打开副本包']);
    assert.deepEqual(await snapshot(item), before); assert.deepEqual(await fileState(item.archive), archiveBefore);
    return { sharedLeaveGuardDiscarded: true, originalFilesUnchanged: true, importedReader: true };
  });
  await scenario('archive-external-change-during-preview-refused-without-output', async () => {
    const item = await fixture('changed-preview'), before = await snapshot(item), modified = Buffer.from('外部进程替换后的 ZIP'); await start(item.file);
    await click('[data-mode="editor"]'); await dialogs(item, { mutation: { file: item.archive, bytes: modified.toString('base64') } });
    await beginImport(); await wait('document.body.innerText.includes("无法安全打开副本包")&&Boolean(document.querySelector("[data-document-intent-retry]"))', 'changed archive failure and retry');
    await assertPreview(item); await emptyDestination(item); await unchangedSession(item, 'editor');
    assert.deepEqual(await readFile(item.archive), modified); assert.deepEqual(await snapshot(item), before);
    return { externalZipRetained: true, staleSnapshotRefused: true, noOutput: true, originalModeRetained: true };
  });
  await scenario('420px-start-and-menu-actions-reachable', async () => {
    const item = await fixture('narrow'), before = await snapshot(item); await start();
    await page.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 850, deviceScaleFactor: 1, mobile: false }); await frame();
    const visibleWithinWidth = selector => page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();
      return !!r&&r.width>0&&r.left>=-1&&r.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1;})()`);
    assert.equal(await visibleWithinWidth('[data-start-open-bundle]'), true); const startShot = await screenshot('start-420');
    await dialogs(item); await beginImport(true); await importedDocument(item); await assertPreview(item);
    await menu(); assert.equal(await visibleWithinWidth(bundleSelector), true); const menuShot = await screenshot('menu-420');
    await dialogs(item, { cancel: 'archive' }); await click(bundleSelector); await waitNative(1); await frame();
    assert.equal((await archiveCalls()).length, 1); assert.deepEqual(await snapshot(item), before);
    return { width: 420, startActionClicked: true, menuActionClicked: true, noHorizontalOverflow: true, screenshots: [startShot, menuShot] };
  });
  result.status = result.cases.every(record => record.status === 'passed') ? 'passed' : 'failed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stop(); result.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const resolved = await realpath(workspace), temporary = await realpath(os.tmpdir()), key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    assert.ok(key(resolved).startsWith(key(temporary) + path.sep) && path.basename(resolved).startsWith('mermarkd-file1d-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`FILE1D fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
