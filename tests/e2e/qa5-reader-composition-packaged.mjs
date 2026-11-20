import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';
import { reconcileCanvasState, serializeCanvasJson } from '../../src/core/canvas-state.ts';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

// Run the identical frozen script against separately identified old/new ASARs.
// Controlled CompositionEvent/InputEvent sequences below are synthetic. They
// exercise the actual reader and shared session, and do not prove physical IME.
// --fixture-check validates only private fixtures and never launches a GUI.
const mode = process.argv[2] ?? 'run';
assert.ok(['run', '--fixture-check'].includes(mode));
const holdSetting = process.env.MERMARKD_QA_NATIVE_HOLD_MS;
if (holdSetting !== undefined) assert.match(holdSetting, /^\d+$/, 'Native hold is an integer number of milliseconds');
const nativeHoldMs = holdSetting === undefined ? 0 : Number(holdSetting);
assert.ok(Number.isSafeInteger(nativeHoldMs) && nativeHoldMs >= 0 && nativeHoldMs <= 180000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'qa5-reader-composition';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa');
await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}${mode === '--fixture-check' ? '-fixture-check' : ''}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'Preserve previous evidence; select a unique artifact prefix');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa5-reader-composition-'));
const fixture = path.join(workspace, '阅读组合输入验收.md');
const replacement = path.join(workspace, '正常离开后的另一文档.md');
const nativeFixture = path.join(workspace, '原生输入专用临时文档.md');
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = async file => { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: digest(bytes) }; };
const heading = '阅读组合输入验收';
const body = '正文';
const finalBody = '正文你';
const anchorText = '批注锚点 中文😀精确保留。';
const source = `# ${heading}\n\n${body}\n\n${anchorText}\n\n末尾原文🌼保留。`;
const changed = text => source.replace(`\n\n${body}\n\n`, `\n\n${text}\n\n`);
const changedSource = changed(finalBody);
const encode = text => Buffer.from('\ufeff' + text.replace(/\n/g, '\r\n'));
const originalBytes = encode(source), expectedBytes = encode(changedSource);
const replacementSource = '# 正常离开的新文档\n\n另一份正文不可被旧输入污染。\n\n' + anchorText;
const nativeSource = '# 原生输入专用验收\n\n原生输入正文\n\n' + anchorText;
const result = { kind: 'QA5-reader-composition-settle', mode, status: 'running', startedAt: new Date().toISOString(),
  workspace, fixture, replacement, nativeFixture, nativeHoldMs, script: await proof(fileURLToPath(import.meta.url)),
  helpers: await Promise.all(['tests/e2e/cdp-client.mjs', 'tests/e2e/packaged-window.mjs', 'tests/prototypes/source-controls.ts'].map(file => proof(path.join(root, file)))),
  rendererUrl: process.env.MERMARKD_QA_RENDERER_URL ?? null, checks: [], fixtures: [],
  expectedOldFailure: 'compositionend-before-final-input must commit final Chinese DOM; never 正文ni',
  boundary: 'Synthetic controlled composition/input events on the actual packaged reader, shared source buffer, real mode/document departure and three persisted files. IPC observation delegates unchanged handlers. Native hold only records evidence for separate physical IME acceptance; automated success never claims physical IME success.' };
let child, page, main, executable, asar, buildManifest;
await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
const saveReceipt = () => writeFile(reportPath, JSON.stringify(result, null, 2));

async function snapshot(file = fixture) {
  return Promise.all(suffixes.map(async suffix => {
    const bytes = await readFile(file + suffix), info = await stat(file + suffix, { bigint: true });
    return { suffix, bytes: bytes.length, sha256: digest(bytes), mtimeNs: String(info.mtimeNs) };
  }));
}
async function seed(file, text) {
  const bytes = encode(text), content = bytes.subarray(3).toString('utf8'), sha256 = digest(bytes);
  let id = 0;
  const canvas = (await reconcileCanvasState(null, { bytes, content, sha256 }, () => `card-${id++}`)).model;
  const startByte = bytes.indexOf(Buffer.from(anchorText));
  assert.ok(startByte > 3);
  const annotations = { schemaVersion: 1, source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
    annotations: [{ id: 'retained-highlight', kind: 'highlight', color: 'amber',
      createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
      anchor: { basisSha256: sha256, startByte, endByte: startByte + Buffer.byteLength(anchorText),
        sourceExact: anchorText, displayQuote: anchorText, prefix: '', suffix: '' } }] };
  const yaml = serializeAnnotationYaml(annotations);
  assert.equal(parseAnnotationYaml(yaml).annotations.length, 1);
  await writeFile(file, bytes, { flag: 'wx' });
  await writeFile(file + suffixes[1], yaml, { flag: 'wx' });
  await writeFile(file + suffixes[2], serializeCanvasJson(canvas), { flag: 'wx' });
  result.fixtures.push({ file, sourceSha256: sha256, initialFiles: await snapshot(file), bom: true, crlf: true, trailingNewline: false });
}
async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error(`Timed out: ${label}`);
}
const wait = (expression, label) => waitFor(() => page.evaluate(expression), label);
const frames = () => page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(resolve,0))))');
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function click(selector) {
  const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!(e instanceof HTMLElement)||e.hasAttribute('disabled')||e.closest('[hidden],[inert]'))return null;
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=e.getBoundingClientRect();
    const x=r.x+Math.min(r.width/2,45),y=r.y+r.height/2;
    return r.width&&r.height&&e.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
  assert.ok(point, `Visible enabled action ${selector}`);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  await frames();
}
async function reader(text = body, expectedHeading = heading) {
  await wait(`(()=>{const a=document.querySelector('.markdown-body'),p=a?.querySelector('p');return document.querySelector('.app-shell')?.dataset.activeMode==='reader'
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'&&a?.getClientRects().length&&!a.closest('[hidden],[inert]')
    &&a.querySelector('h1')?.textContent===${JSON.stringify(expectedHeading)}&&p?.textContent===${JSON.stringify(text)}&&p.isContentEditable
    &&document.querySelector('.app-shell')?.dataset.leavePending==='false';})()`, 'Current complete editable reader');
}
async function editor(expected) {
  await wait(`document.querySelector('.app-shell')?.dataset.activeMode==='editor'&&Boolean(__sourceControl())&&!__sourceControl().readOnly
    &&__sourceControl().value===${JSON.stringify(expected)}&&document.querySelector('.app-shell')?.dataset.leavePending==='false'`, 'Current complete source editor');
}
async function state() {
  return page.evaluate(`({mode:document.querySelector('.app-shell')?.dataset.activeMode,dirty:document.querySelector('.app-shell')?.dataset.dirty,
    leavePending:document.querySelector('.app-shell')?.dataset.leavePending,analysis:document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis,
    source:typeof __sourceControl==='function'?__sourceControl()?.value:null,paragraph:document.querySelector('.markdown-body p')?.textContent,
    focus:document.activeElement?.outerHTML,documentPath:document.querySelector('.workspace-current-name')?.title})`);
}
const counts = () => main.evaluate('({...__qa5Ipc.counts})');
const count = (values, channel) => values[channel] ?? 0;
async function untouched(label) { assert.deepEqual(await snapshot(), result.initialFiles, label); }
async function scenario(name, run) {
  const record = { name, provenance: 'synthetic DOM CompositionEvent/InputEvent; actual product component and shared session', status: 'running',
    ipcBefore: await counts(), eventStart: await page.evaluate('__qa5SyntheticEvents.length') };
  result.checks.push(record);
  await page.evaluate(`globalThis.__qa5Scenario=${JSON.stringify(name)}`);
  try { await run(record); await untouched(`${name}: source and both sidecars keep their bytes and mtimes`); record.status = 'passed'; }
  catch (error) { record.status = 'failed'; record.error = error.stack ?? String(error); throw error; }
  finally { record.state = await state(); record.ipcAfter = await counts(); record.eventEnd = await page.evaluate('__qa5SyntheticEvents.length'); await saveReceipt(); }
}
async function prepare() {
  await reader();
  await page.evaluate(`(()=>{const e=document.querySelector('.markdown-body p[data-reader-editable]');if(!e)throw Error('Editable paragraph missing');
    globalThis.__qa5Target=e;e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
}
async function committed(text, record) {
  await wait('__sourceControl().value!==' + JSON.stringify(source), 'One reader edit reaches the shared source buffer');
  assert.equal(await page.evaluate('__sourceControl().value'), changed(text), record.name === 'compositionend-before-final-input' ? result.expectedOldFailure : `${record.name}: exact final reader source`);
  await reader(text); await frames();
  await waitFor(async () => count(await counts(), 'markdown-editor:update') >= count(record.ipcBefore, 'markdown-editor:update') + 1, 'Reader update observed in main process');
  assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 1, 'Exactly one shared buffer publication');
}
async function undoToBaseline(text, exerciseRedo = false) {
  await click('[data-mode="editor"]'); await editor(changed(text));
  await click('[data-editor-undo]'); await editor(source);
  if (exerciseRedo) {
    await click('[data-editor-redo]'); await editor(changed(text));
    await click('[data-mode="reader"]'); await reader(text);
    await click('[data-mode="editor"]'); await editor(changed(text));
    await click('[data-editor-undo]'); await editor(source);
  }
  await click('[data-mode="reader"]'); await reader();
  await untouched('Shared cross-mode undo/redo does not save any of the three document files');
}
async function assertFrozenBuild() {
  assert.deepEqual(await proof(asar.path), asar, 'Selected ASAR remains unchanged');
  assert.deepEqual(await proof(buildManifest.path), buildManifest, 'Passed build receipt remains unchanged');
  assert.deepEqual(await proof(result.script.path), result.script, 'Old/new comparison script remains unchanged during the run');
  for (const helper of result.helpers) assert.deepEqual(await proof(helper.path), helper, 'Test helper remains unchanged during the run');
}
async function selectOpenTarget(file) {
  assert.ok([fixture, replacement, nativeFixture].includes(file), 'Native picker only returns this run\'s private fixtures');
  await main.evaluate(`globalThis.__qa5OpenTarget=${JSON.stringify(file)}`);
}
async function openWithShortcut(file) {
  await selectOpenTarget(file); await key('o', 'KeyO', 79, 2);
  await wait(`document.querySelector('.workspace-current-name')?.title.toLowerCase()===${JSON.stringify(file.toLowerCase())}
    &&document.querySelector('.app-shell')?.dataset.leavePending==='false'`, 'Normal guarded document departure');
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child?.exitCode === null && child?.signalCode === null) {
    const ownedPid = child.pid;
    try { execFileSync('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { child.kill('SIGKILL'); }
    result.teardown = { ownedPid, attempted: true };
  }
  child = undefined;
}

try {
  await seed(fixture, source); await seed(replacement, replacementSource); await seed(nativeFixture, nativeSource);
  result.initialFiles = await snapshot();
  result.expectedSaved = { sha256: digest(expectedBytes), bytes: expectedBytes.length };
  assert.deepEqual(await readFile(fixture), originalBytes);
  assert.equal(originalBytes.at(-1) === 10 || originalBytes.at(-1) === 13, false);
  assert.equal(changedSource.split(finalBody).length - 1, 1);
  if (mode === '--fixture-check') {
    assert.equal(encode(source).subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(encode(source).toString('utf8').replace(/\r\n/g, '').includes('\n'), false);
    for (const seeded of result.fixtures) assert.deepEqual(await snapshot(seeded.file), seeded.initialFiles);
    result.status = 'passed';
  } else {
    executable = process.env.MERMARKD_QA_EXE;
    const manifestPath = process.env.MERMARKD_QA_BUILD_MANIFEST;
    assert.ok(executable && path.isAbsolute(executable), 'Select an absolute MERMARKD_QA_EXE');
    assert.ok(manifestPath && path.isAbsolute(manifestPath), 'Select its absolute MERMARKD_QA_BUILD_MANIFEST');
    asar = await proof(path.join(path.dirname(executable), 'resources/app.asar'));
    buildManifest = await proof(manifestPath);
    const build = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(build.status, 'passed'); assert.match(build.sourceCommit ?? '', /^[a-f0-9]{40}$/i);
    const artifacts = Array.isArray(build.artifacts) ? build.artifacts : [build.artifacts?.asar].filter(Boolean);
    assert.equal(artifacts.filter(item => item.sha256?.toLowerCase() === asar.sha256 && item.bytes === asar.bytes).length, 1, 'ASAR matches exactly one passed build artifact');
    Object.assign(result, { executable, asar, buildManifest, runtimeSourceCommit: build.sourceCommit });
    const rendererPort = 19700 + Math.floor(Math.random() * 250), inspectorPort = rendererPort + 8000, profile = path.join(workspace, 'user-data');
    child = await spawn(executable, [`--remote-debugging-port=${rendererPort}`, `--inspect=127.0.0.1:${inspectorPort}`, `--user-data-dir=${profile}`], { cwd: root, stdio: 'ignore' });
    page = await connectCdp(rendererPort, target => target.type === 'page'); main = await connectCdp(inspectorPort, target => target.type === 'node');
    Object.assign(result, { rendererPort, inspectorPort, pid: child.pid, profile });
    if (result.rendererUrl) {
      const url = new URL(result.rendererUrl).href; await page.send('Page.navigate', { url });
      await wait(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`, 'Selected development renderer');
    }
    await page.send('Page.bringToFront');
    result.environment = await main.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());
      return {execPath:process.execPath,userData:app.getPath('userData'),features:app.getAccessibilitySupportFeatures?.()??null,focused:w?.isFocused(),visible:w?.isVisible(),minimized:w?.isMinimized()};})()`);
    assert.equal(path.resolve(result.environment.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'The actual process uses the private profile');
    await main.evaluate(`(()=>{const {dialog,ipcMain}=process.mainModule.require('electron');globalThis.__qa5OpenTarget=${JSON.stringify(fixture)};
      globalThis.__qa5Ipc={counts:{},calls:[],dialogs:[]};globalThis.__qa5AllowDiscard=false;
      const channels=['markdown-editor:update','markdown-editor:save','annotations:delete-highlight','annotations:create-highlight','annotations:create-note','document:open','workspace:confirm-leave-inputs','workspace:confirm-leave-document'];
      for(const channel of channels){const original=ipcMain._invokeHandlers.get(channel);if(typeof original!=='function')throw Error('Missing IPC handler '+channel);
        ipcMain.removeHandler(channel);ipcMain.handle(channel,(event,...args)=>{__qa5Ipc.counts[channel]=(__qa5Ipc.counts[channel]??0)+1;
          __qa5Ipc.calls.push({channel,time:Date.now(),content:channel==='markdown-editor:update'?args[0]?.content:undefined});return original(event,...args);});}
      dialog.showOpenDialog=async()=>({canceled:false,filePaths:[__qa5OpenTarget]});
      dialog.showMessageBox=async(_owner,options)=>{__qa5Ipc.dialogs.push({title:options.title,buttons:options.buttons,time:Date.now()});
        if(__qa5AllowDiscard&&['正文尚未保存','还有未提交的输入'].includes(options.title))return {response:1};
        throw Error('Unexpected native confirmation in isolated test: '+options.title);};
      dialog.showSaveDialog=async()=>{throw Error('Existing private sources need no save picker');};})()`);
    await wait('Boolean(document.querySelector("[data-start-open]"))&&typeof __sourceControl==="function"', 'Start page and test source bridge');
    await page.evaluate(`(()=>{globalThis.__qa5Scenario='setup';globalThis.__qa5SyntheticEvents=[];
      for(const type of ['focusin','focusout','keydown','paste','compositionstart','compositionupdate','compositionend','beforeinput','input'])window.addEventListener(type,event=>{
        const t=event.target;if(!(t instanceof Element))return;
        __qa5SyntheticEvents.push({scenario:__qa5Scenario,type:event.type,isTrusted:event.isTrusted,time:performance.now(),mode:document.querySelector('.app-shell')?.dataset.activeMode,
          target:t.dataset.sourceBlockStart??null,text:t.matches('[data-reader-editable]')?t.textContent:null,data:event.data??null,inputType:event.inputType??null,isComposing:event.isComposing??null,key:event.key??null});},true);
      globalThis.__qa5Compose=(type,data='')=>__qa5Target.dispatchEvent(new CompositionEvent(type,{bubbles:true,data}));
      globalThis.__qa5Input=(text,composing=true)=>{__qa5Target.textContent=text;__qa5Target.dispatchEvent(new InputEvent('input',{bubbles:true,data:text,inputType:composing?'insertCompositionText':'insertText',isComposing:composing}));};
      globalThis.__qa5Shortcut=(key,code,keyCode)=>window.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,code,keyCode,which:keyCode,ctrlKey:true}));})()`);
    await click('[data-start-open]'); await reader();
    await wait('Boolean(document.querySelector(".highlight-delete"))', 'Seeded retained annotation action');
    await untouched('Opening the isolated source is zero-write');

    await scenario('final-input-before-compositionend', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文n');__qa5Input('正文ni');__qa5Input('正文你');__qa5Target.blur();__qa5Compose('compositionend','你');})()`);
      await committed(finalBody, record);
    });
    await undoToBaseline(finalBody);

    await scenario('compositionend-before-final-input', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();
        __qa5Target.textContent='正文你';__qa5Compose('compositionend','你');
        __qa5Target.dispatchEvent(new InputEvent('input',{bubbles:true,data:'你',inputType:'insertText',isComposing:false}));})()`);
      await committed(finalBody, record);
    });
    await undoToBaseline(finalBody, true);

    await scenario('compositionend-reads-final-dom-without-another-input', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();
        __qa5Target.textContent='正文你';__qa5Compose('compositionend','你');})()`);
      await committed(finalBody, record);
    });
    await undoToBaseline(finalBody);

    await scenario('final-input-in-later-browser-task', async record => {
      await prepare();
      record.during = await page.evaluate(`(async()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();__qa5Compose('compositionend','你');
        const during={source:__sourceControl().value,text:__qa5Target.textContent};
        await new Promise(resolve=>setTimeout(()=>{__qa5Input('正文你',false);resolve();},0));return during;})()`);
      assert.equal(record.during.source, source, 'An ended composition remains unpublished before its final input');
      await committed(finalBody, record);
    });
    await undoToBaseline(finalBody);

    await scenario('cancelled-composition-without-final-input', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();__qa5Target.textContent='正文';__qa5Compose('compositionend');})()`);
      await frames(); await frames(); await reader();
      assert.equal(await page.evaluate('__sourceControl().value'), source, 'Cancellation reads restored DOM without needing another input event');
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0, 'Cancellation creates no shared history publication');
      await click('[data-mode="editor"]'); await editor(source); await click('[data-mode="reader"]'); await reader();
    });

    await scenario('escape-cancels-focused-settling', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.textContent='正文你';__qa5Compose('compositionend','你');
        __qa5Target.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:'Escape',code:'Escape',keyCode:27,which:27}));})()`);
      await frames(); await frames(); await reader();
      assert.equal(await page.evaluate('__sourceControl().value'), source, 'Escape restores the original source and cancels the pending callback');
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0);
      await click('[data-mode="editor"]'); await editor(source); await click('[data-mode="reader"]'); await reader();
    });

    await scenario('refocus-defers-the-same-block-until-fresh-blur', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();__qa5Target.textContent='正文你';__qa5Compose('compositionend','你');__qa5Target.focus();})()`);
      await frames(); await frames();
      assert.equal(await page.evaluate('__sourceControl().value'), source, 'Refocus retains the editable draft without publishing it');
      assert.equal(await page.evaluate('__qa5Target.textContent'), finalBody);
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0);
      await page.evaluate('__qa5Target.blur()'); await committed(finalBody, record);
    });
    await undoToBaseline(finalBody);

    await scenario('new-composition-invalidates-previous-settle', async record => {
      await prepare();
      // Keep focus throughout: a refocus would independently cancel the old
      // callback and could conceal a broken new-composition generation guard.
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.textContent='正文你';__qa5Compose('compositionend','你');
        __qa5Compose('compositionstart');__qa5Input('正文你hao');})()`);
      await frames(); await frames();
      assert.equal(await page.evaluate('__sourceControl().value'), source, 'The previous completion cannot finish a newer live composition');
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0);
      await page.evaluate(`(()=>{__qa5Target.blur();__qa5Target.textContent='正文你好';__qa5Compose('compositionend','好');__qa5Input('正文你好',false);})()`);
      await committed('正文你好', record);
    });
    await undoToBaseline('正文你好');

    await scenario('duplicate-blur-publishes-once', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();__qa5Target.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
        __qa5Target.textContent='正文你';__qa5Compose('compositionend','你');__qa5Input('正文你',false);__qa5Target.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);
      await committed(finalBody, record); await frames(); await frames();
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 1, 'Repeated blur cannot create a second commit');
    });
    await undoToBaseline(finalBody);

    await scenario('composition-and-settle-block-mode-save-annotations-and-departure', async record => {
      await selectOpenTarget(replacement); await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');})()`);
      await wait('document.querySelector(".app-shell")?.dataset.dirty==="true"', 'Reader draft state reaches shell commands');
      const attempt = `(()=>{document.querySelector('[data-mode="editor"]').click();__qa5Shortcut('s','KeyS',83);__qa5Shortcut('o','KeyO',79);
        const a=document.querySelector('.highlight-delete');if(!a)throw Error('Retained annotation command missing');const disabled=a.disabled;a.click();
        return {mode:document.querySelector('.app-shell')?.dataset.activeMode,path:document.querySelector('.workspace-current-name')?.title,annotationDisabled:disabled};})()`;
      record.composingAttempt = await page.evaluate(attempt);
      assert.equal(record.composingAttempt.mode, 'reader'); assert.equal(record.composingAttempt.annotationDisabled, true);
      record.settlingAttempt = await page.evaluate(`(()=>{__qa5Target.blur();__qa5Target.textContent='正文你';__qa5Compose('compositionend','你');return ${attempt};})()`);
      assert.equal(record.settlingAttempt.mode, 'reader'); assert.equal(record.settlingAttempt.annotationDisabled, true);
      await committed(finalBody, record);
      assert.equal((await state()).mode, 'reader'); assert.equal((await state()).documentPath.toLowerCase(), fixture.toLowerCase());
      const after = await counts();
      for (const channel of ['markdown-editor:save', 'annotations:delete-highlight', 'annotations:create-highlight', 'annotations:create-note', 'document:open', 'workspace:confirm-leave-inputs', 'workspace:confirm-leave-document']) {
        assert.equal(count(after, channel) - count(record.ipcBefore, channel), 0, `${channel}: blocked before IPC during both composition and settling`);
      }
    });
    await undoToBaseline(finalBody);

    await scenario('ordinary-noncomposition-blur-keeps-one-shared-edit', async record => {
      await prepare();
      record.immediate = await page.evaluate(`(()=>{__qa5Input('正文普通',false);__qa5Target.blur();return {text:__qa5Target.textContent,source:__sourceControl().value};})()`);
      await committed('正文普通', record);
      // The following real undo proves that ordinary typing forms one shared
      // edit. Callback synchrony itself is covered by the pure session tests.
      const event = await page.evaluate(`__qa5SyntheticEvents.filter(e=>e.scenario===${JSON.stringify(record.name)}&&e.type==='compositionstart')`);
      assert.deepEqual(event, []);
    });
    await undoToBaseline('正文普通');

    await scenario('rejected-paste-preserves-existing-reader-draft', async record => {
      record.provenance = 'Trusted CDP insertText followed by a synthetic ClipboardEvent on the actual paste handler; actual feedback dismissal and shared blur commit. Does not modify the system clipboard.';
      await prepare();
      await page.send('Input.insertText', { text: '保留' });
      await wait('__qa5Target.textContent==="正文保留"&&document.querySelector(".app-shell")?.dataset.dirty==="true"', 'Existing native draft before rejected paste');
      assert.equal(await page.evaluate(`(()=>{const data=new DataTransfer();data.setData('text/plain','拒绝的粘贴\\n第二行');
        return __qa5Target.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`), false, 'The actual paste handler prevents the multiline insertion');
      await wait('document.querySelector("textarea[aria-label=未应用的输入]")?.value==="拒绝的粘贴\\n第二行"&&!document.querySelector(".markdown-body p").isContentEditable', 'Native multiline paste pauses reader editing');
      record.disabled = await page.evaluate(`({connected:__qa5Target.isConnected,same:document.querySelector('.markdown-body p')===__qa5Target,
        text:__qa5Target.textContent,source:__sourceControl().value})`);
      assert.equal(record.disabled.connected, true, 'Permission-only disable keeps the edited DOM connected');
      assert.equal(record.disabled.same, true, 'Permission-only disable does not replace the edited paragraph');
      assert.equal(record.disabled.text, '正文保留', 'Rejecting a paste retains the preceding unpublished native input');
      assert.equal(record.disabled.source, source, 'Rejected paste does not publish or save the preceding draft');
      const nativeEvents = await page.evaluate(`__qa5SyntheticEvents.filter(e=>e.scenario===${JSON.stringify(record.name)})`);
      assert.ok(nativeEvents.some(event => event.type === 'paste' && !event.isTrusted), 'The controlled paste reaches the actual handler without changing the system clipboard');
      assert.ok(nativeEvents.some(event => event.type === 'input' && event.isTrusted), 'The earlier draft came from browser input');
      await untouched('Rejecting multiline paste keeps all source and sidecar bytes and mtimes');
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0);
      await click('[aria-label="关闭阅读编辑提示"]');
      await reader('正文保留');
      assert.equal(await page.evaluate('document.querySelector(".app-shell")?.dataset.dirty'), 'true', 'Dismissing the paste feedback retains the preceding draft dirty state');
      assert.equal(await page.evaluate('document.querySelector(".markdown-body p")===__qa5Target'), true, 'Re-enabling editing also preserves the native paragraph');
      await page.evaluate('__qa5Target.focus();__qa5Target.blur()');
      await committed('正文保留', record);
    });
    await undoToBaseline('正文保留');

    await scenario('settle-then-discard-leaves-normally-and-old-detached-events-are-inert', async record => {
      await prepare();
      await page.evaluate(`(()=>{globalThis.__qa5Detached=__qa5Target;__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();
        __qa5Target.textContent='正文你';__qa5Compose('compositionend','你');__qa5Input('正文你',false);})()`);
      await committed(finalBody, record);
      await main.evaluate('globalThis.__qa5AllowDiscard=true');
      await openWithShortcut(replacement);
      await reader('另一份正文不可被旧输入污染。', '正常离开的新文档');
      assert.equal(await page.evaluate('__qa5Detached.isConnected'), false, 'The application really unmounted the old document; the test never removes React DOM');
      const beforeDelayed = await counts();
      await page.evaluate(`(()=>{const e=__qa5Detached;e.textContent='旧文档迟到污染';e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'污染'}));
        e.dispatchEvent(new InputEvent('input',{bubbles:true,data:'污染',inputType:'insertText'}));e.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`);
      await frames(); await frames();
      assert.equal(await page.evaluate('__sourceControl().value'), replacementSource, 'Delayed events from an actually detached old block cannot edit the new source');
      assert.equal(count(await counts(), 'markdown-editor:update') - count(beforeDelayed, 'markdown-editor:update'), 0);
      assert.deepEqual(await snapshot(replacement), result.fixtures.find(item => item.file === replacement).initialFiles);
      await openWithShortcut(fixture); await reader();
      await main.evaluate('globalThis.__qa5AllowDiscard=false');
    });

    await scenario('test-owned-disconnected-composition-target-releases-shell-guard', async record => {
      // This deliberately owns a separate DOM node outside React. Removing it
      // tests window-level capture liveness, never ReaderEditableBlock unmount.
      await page.evaluate(`(()=>{const e=document.createElement('span');e.contentEditable='true';e.dataset.qa5OwnedDummy='true';
        document.body.append(e);e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.remove();})()`);
      await click('[data-mode="editor"]'); await editor(source);
      await click('[data-mode="reader"]'); await reader();
      assert.equal(count(await counts(), 'markdown-editor:update') - count(record.ipcBefore, 'markdown-editor:update'), 0);
    });

    await scenario('final-chinese-edit-before-explicit-save', async record => {
      await prepare();
      await page.evaluate(`(()=>{__qa5Compose('compositionstart');__qa5Input('正文ni');__qa5Target.blur();__qa5Compose('compositionend','你');
        setTimeout(()=>__qa5Input('正文你',false),0);})()`);
      await committed(finalBody, record);
    });
    await click('[data-mode="editor"]'); await editor(changedSource);
    await click('[data-editor-undo]'); await editor(source);
    await click('[data-mode="reader"]'); await reader();
    await click('[data-mode="editor"]'); await editor(source);
    await click('[data-editor-redo]'); await editor(changedSource);
    await click('[data-mode="reader"]'); await reader(finalBody);
    await untouched('The final shared undo and redo still save no document files');
    const beforeSave = await counts();
    await page.evaluate(`(()=>{const e=document.createElement('span');e.contentEditable='true';e.dataset.qa5OwnedDummy='true';
      document.body.append(e);e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.remove();})()`);
    await click('[data-workspace-save]');
    await wait('document.querySelector(".app-shell")?.dataset.dirty==="false"', 'Explicit source save completes');
    await waitFor(async () => (await readFile(fixture)).equals(expectedBytes) && parseAnnotationYaml(await readFile(fixture + suffixes[1], 'utf8')).source.sha256 === digest(expectedBytes), 'Exact BOM/CRLF source and mapped annotation save');
    assert.deepEqual(await readFile(fixture), expectedBytes, 'Explicit save preserves exact BOM, CRLF and missing final newline; no intermediate pinyin survives');
    const mapped = parseAnnotationYaml(await readFile(fixture + suffixes[1], 'utf8')), annotation = mapped.annotations[0];
    assert.equal(mapped.annotations.length, 1); assert.deepEqual(mapped.tags, []);
    assert.equal(annotation.id, 'retained-highlight'); assert.equal(annotation.kind, 'highlight'); assert.equal(annotation.color, 'amber');
    assert.equal(annotation.anchor.basisSha256, digest(expectedBytes));
    assert.equal(annotation.anchor.sourceExact, anchorText); assert.equal(annotation.anchor.displayQuote, anchorText);
    assert.equal(annotation.anchor.startByte, expectedBytes.indexOf(Buffer.from(anchorText)));
    assert.equal(annotation.anchor.endByte, annotation.anchor.startByte + Buffer.byteLength(anchorText));
    result.savedFiles = await snapshot();
    assert.deepEqual(result.savedFiles[2], result.initialFiles[2], 'Explicit source save never rewrites the canvas file or its mtime');
    assert.equal(count(await counts(), 'markdown-editor:save') - count(beforeSave, 'markdown-editor:save'), 1);
    result.checks.push({ name: 'explicit-save-exact-bytes-and-annotation-mapping', status: 'passed', provenance: 'Actual shell save and persisted three-file verification' });
    await assertFrozenBuild();

    if (nativeHoldMs > 0) {
      await openWithShortcut(nativeFixture); await reader('原生输入正文', '原生输入专用验收');
      const nativeInitial = await snapshot(nativeFixture), nativeCounts = await counts(), title = 'MerMarkd QA5 阅读输入法原生验收';
      await page.evaluate(`(()=>{document.title=${JSON.stringify(title)};globalThis.__qa5NativeEvents=[];globalThis.__qa5Scenario='native-hold';
        for(const type of ['keydown','compositionstart','compositionupdate','compositionend','beforeinput','input'])window.addEventListener(type,event=>{
          const t=event.target;__qa5NativeEvents.push({type:event.type,isTrusted:event.isTrusted,time:performance.now(),mode:document.querySelector('.app-shell')?.dataset.activeMode,
            target:t instanceof Element?t.dataset.sourceBlockStart??null:null,data:event.data??null,inputType:event.inputType??null,isComposing:event.isComposing??null,key:event.key??null,
            text:t instanceof Element&&t.matches('[data-reader-editable]')?t.textContent:null});},true);
        const p=document.querySelector('.markdown-body p[data-reader-editable]');p.scrollIntoView({block:'center'});p.focus();
        const r=document.createRange();r.selectNodeContents(p);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
      await main.evaluate(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());w.setTitle(${JSON.stringify(title)});w.show();w.focus();})()`);
      result.status = 'holding-for-native';
      result.nativeHold = { title, fixture: nativeFixture, rendererPort, inspectorPort, pid: child.pid, environment: result.environment,
        startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + nativeHoldMs).toISOString(), milliseconds: nativeHoldMs,
        initialFiles: nativeInitial, source: nativeSource, sourceMayBecomeDirty: true,
        boundary: 'Separate physical IME inspection. Natural typing may update the shared dirty buffer. No automatic native-pass claim. Explicit user save, if observed by IPC, is recorded for manual byte verification.' };
      await saveReceipt();
      console.log(JSON.stringify({ status: result.status, title, reportPath, ...result.nativeHold }));
      const deadline = Date.now() + nativeHoldMs;
      while (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      const nativeAfter = await snapshot(nativeFixture), afterCounts = await counts();
      result.nativeObservation = { state: await state(), events: await page.evaluate('__qa5NativeEvents'), files: nativeAfter,
        saveRequests: count(afterCounts, 'markdown-editor:save') - count(nativeCounts, 'markdown-editor:save'), acceptedBySuite: false };
      if (result.nativeObservation.saveRequests === 0) assert.deepEqual(nativeAfter, nativeInitial, 'Native typing without an explicit save preserves all persisted bytes and mtimes');
      else result.nativeObservation.explicitSaveObserved = 'Recorded for separate native acceptance and expected-byte verification; suite does not label this native success';
      assert.deepEqual(await snapshot(), result.savedFiles, 'Native fixture inspection never changes the automated fixture');
      await assertFrozenBuild();
    }
    result.ipc = await main.evaluate('__qa5Ipc');
    result.syntheticEvents = await page.evaluate('__qa5SyntheticEvents');
    result.status = 'passed';
  }
} catch (error) {
  result.status = 'failed'; result.error = error.stack ?? String(error);
  if (page) {
    result.failureState = await state().catch(error => ({ error: error.message }));
    result.syntheticEvents = await page.evaluate('__qa5SyntheticEvents??[]').catch(() => []);
    result.nativeObservation = await page.evaluate('typeof __qa5NativeEvents==="undefined"?null:{events:__qa5NativeEvents}').catch(() => null);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
    if (shot) { const file = path.join(qa, `${prefix}-failure.png`); await writeFile(file, Buffer.from(shot.data, 'base64'), { flag: 'wx' }); result.failureScreenshot = await proof(file); }
  }
  if (main) result.ipc = await main.evaluate('__qa5Ipc').catch(() => null);
} finally {
  result.finalFiles = await Promise.all(result.fixtures.map(async item => ({ file: item.file, files: await snapshot(item.file) }))).catch(error => ({ error: error.message }));
  await stop(); result.finishedAt = new Date().toISOString(); await saveReceipt();
}
assert.equal(result.status, 'passed', `See ${reportPath}; private fixtures retained at ${workspace}`);
console.log(`QA5 reader composition ${mode} passed: ${reportPath}`);
