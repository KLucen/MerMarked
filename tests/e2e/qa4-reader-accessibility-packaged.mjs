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

// Set a unique MERMARKD_QA_ARTIFACT_PREFIX for each old/new package comparison.
// A run requires its absolute MERMARKD_QA_EXE and passed MERMARKD_QA_BUILD_MANIFEST.
// --fixture-check creates/validates only private files and never launches a GUI.
const mode = process.argv[2] ?? 'run';
assert.ok(['run', '--fixture-check'].includes(mode));
const holdSetting = process.env.MERMARKD_QA_NATIVE_HOLD_MS;
if (holdSetting !== undefined) assert.match(holdSetting, /^\d+$/, 'Native hold must be an integer number of milliseconds');
const nativeHoldMs = holdSetting === undefined ? 0 : Number(holdSetting);
assert.ok(Number.isSafeInteger(nativeHoldMs) && nativeHoldMs >= 0 && nativeHoldMs <= 180000, 'Native hold must be between 0 and 180000 ms');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'qa4-reader-accessibility';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}${mode === '--fixture-check' ? '-fixture-check' : ''}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'Preserve previous evidence.');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa4-reader-ax-'));
const fixture = path.join(workspace, '标题无障碍验收.md');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const proof = async file => { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: digest(bytes) }; };
const description = '点击正文直接编辑；换行或复杂编辑可在源码中继续';
const duplicate = '中文重复😀';
const paragraph = '普通正文🌼保留完整语义。';
const anchorText = '批注锚点 中文😀精确保留。';
const tail = '末尾完整正文🪁没有截断。';
const headingCases = [
  { markdown: `# ${duplicate}`, text: duplicate, level: 1 },
  { markdown: `# ${duplicate}`, text: duplicate, level: 1 },
  { markdown: '## 格式 **强调😀** 与 [链接🚀](https://example.com)', text: '格式 强调😀 与 链接🚀', level: 2 },
  { markdown: '### 三级中文🌟', text: '三级中文🌟', level: 3 },
  { markdown: '#### 四级标题🍀', text: '四级标题🍀', level: 4 },
  { markdown: '##### 五级标题🌙', text: '五级标题🌙', level: 5 },
  { markdown: '###### 六级标题🪁', text: '六级标题🪁', level: 6 },
  { markdown: '> ## 引用标题🌿', text: '引用标题🌿', level: 2, ancestor: 'blockquote' },
  { markdown: '- ### 列表标题🧭', text: '列表标题🧭', level: 3, ancestor: 'li' },
];
const source = [headingCases[0].markdown, '', paragraph, '', anchorText, '',
  ...headingCases.slice(1).flatMap(item => [item.markdown, '']), tail].join('\n');
const originalBytes = Buffer.from('\ufeff' + source.replace(/\n/g, '\r\n'));
const addition = '已提交中文🚀';
const changedSource = source.replace(headingCases[0].markdown, headingCases[0].markdown + addition);
const expectedBytes = Buffer.from('\ufeff' + changedSource.replace(/\n/g, '\r\n'));
const suffixes = ['', '.annotations.yaml', '.mermarkd.json'];
const result = { kind: 'QA4-reader-accessible-names', mode, status: 'running', startedAt: new Date().toISOString(),
  workspace, fixture, script: await proof(fileURLToPath(import.meta.url)),
  helpers: await Promise.all(['tests/e2e/cdp-client.mjs', 'tests/e2e/packaged-window.mjs', 'tests/prototypes/source-controls.ts'].map(file => proof(path.join(root, file)))),
  rendererUrl: process.env.MERMARKD_QA_RENDERER_URL ?? null, nativeHoldMs, checks: [], axSnapshots: [],
  boundary: 'Actual Chromium accessibility nodes and browser-native input in an isolated profile. DOM/backend identifiers locate nodes but DOM aria attributes never stand in for AX names/descriptions. No performance budget, physical IME, screen-reader speech or native UIA acceptance is claimed.' };
let child, page, main, executable, asar, buildManifest;
// Reserve this prefix before launching anything; later writes update only this receipt.
await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
const saveReceipt = () => writeFile(reportPath, JSON.stringify(result, null, 2));

async function snapshot() {
  return Promise.all(suffixes.map(async suffix => {
    const file = fixture + suffix, bytes = await readFile(file), info = await stat(file, { bigint: true });
    return { suffix, bytes: bytes.length, sha256: digest(bytes), mtimeNs: String(info.mtimeNs) };
  }));
}
async function seed() {
  const content = originalBytes.subarray(3).toString('utf8'), sha256 = digest(originalBytes);
  let id = 0;
  const canvas = (await reconcileCanvasState(null, { bytes: originalBytes, content, sha256 }, () => `card-${id++}`)).model;
  const startByte = originalBytes.indexOf(Buffer.from(anchorText));
  assert.ok(startByte > 3);
  const annotations = { schemaVersion: 1, source: { sha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' }, tags: [],
    annotations: [{ id: 'retained-highlight', kind: 'highlight', color: 'amber',
      createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z',
      anchor: { basisSha256: sha256, startByte, endByte: startByte + Buffer.byteLength(anchorText), sourceExact: anchorText,
        displayQuote: anchorText, prefix: '', suffix: '' } }] };
  const yaml = serializeAnnotationYaml(annotations);
  assert.equal(parseAnnotationYaml(yaml).annotations.length, 1);
  await writeFile(fixture, originalBytes, { flag: 'wx' });
  await writeFile(fixture + suffixes[1], yaml, { flag: 'wx' });
  await writeFile(fixture + suffixes[2], serializeCanvasJson(canvas), { flag: 'wx' });
  result.initialFiles = await snapshot();
  result.fixtureIdentity = { sourceSha256: sha256, bytes: originalBytes.length, headings: headingCases.length,
    expectedSavedSha256: digest(expectedBytes), expectedSavedBytes: expectedBytes.length, bom: true, crlf: true, trailingNewline: false };
}
async function waitFor(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw Error(`Timed out: ${label}`);
}
const wait = (expression, label) => waitFor(() => page.evaluate(expression), label);
const frame = () => page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
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
  await frame();
}
async function reader(firstHeading = duplicate) {
  await wait(`(()=>{const a=document.querySelector('.markdown-body');return document.querySelector('.app-shell')?.dataset.activeMode==='reader'
    &&document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis==='ready'&&a?.getClientRects().length
    &&!a.closest('[hidden],[inert]')&&a.querySelector('h1')?.textContent===${JSON.stringify(firstHeading)}&&a.querySelector('h1').isContentEditable
    &&document.querySelector('.app-shell')?.dataset.leavePending==='false';})()`, 'Current visible complete reader');
}
async function editor(expectedSource) {
  await wait(`document.querySelector('.app-shell')?.dataset.activeMode==='editor'&&Boolean(__sourceControl())&&!__sourceControl().readOnly
    &&__sourceControl().value===${JSON.stringify(expectedSource)}&&document.querySelector('.app-shell')?.dataset.leavePending==='false'`, 'Current source editor');
}
async function backend(selector) {
  const document = await page.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: document.root.nodeId, selector });
  assert.ok(nodeId, `DOM identity ${selector}`);
  return (await page.send('DOM.describeNode', { nodeId })).node.backendNodeId;
}
const axValue = value => value?.value;
const axProperty = (node, name) => axValue(node.properties?.find(item => item.name === name)?.value);
const liveNodes = tree => tree.nodes.filter(node => !node.ignored);
function nodeFor(tree, backendNodeId, label) {
  const nodes = liveNodes(tree).filter(node => node.backendDOMNodeId === backendNodeId);
  assert.equal(nodes.length, 1, `${label}: exactly one exposed AX node for its actual DOM identity`);
  return nodes[0];
}
function descendants(tree, node) {
  const byId = new Map(tree.nodes.map(item => [item.nodeId, item])), found = [], pending = [node];
  while (pending.length) { const next = pending.pop(); if (!next) continue; found.push(next); pending.push(...(next.childIds ?? []).map(id => byId.get(id))); }
  return found;
}
async function captureAX(label) {
  await frame();
  const tree = await page.send('Accessibility.getFullAXTree');
  const file = path.join(qa, `${prefix}-${label}-ax.json`);
  await writeFile(file, JSON.stringify(tree, null, 2), { flag: 'wx' });
  result.axSnapshots.push({ label, ...(await proof(file)), nodes: tree.nodes.length, exposed: liveNodes(tree).length });
  return tree;
}
async function verifyReaderAX(label, firstHeading = duplicate) {
  await reader(firstHeading);
  const tree = await captureAX(label), article = nodeFor(tree, await backend('.markdown-body'), 'Reading article');
  assert.equal(axValue(article.role), 'article');
  const reading = descendants(tree, article).filter(node => !node.ignored);
  const headings = reading.filter(node => axValue(node.role) === 'heading');
  assert.equal(headings.length, headingCases.length, 'All root and nested headings remain semantic headings');
  for (let index = 0; index < headingCases.length; index++) {
    const expected = headingCases[index], selector = '.markdown-body :is(h1,h2,h3,h4,h5,h6)';
    const identity = await page.evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})][${index}];
      return e?{start:e.dataset.sourceBlockStart,text:e.textContent,nested:${expected.ancestor ? `Boolean(e.closest(${JSON.stringify(expected.ancestor)}))` : 'false'}}:null;})()`);
    assert.ok(identity?.start, `Mapped heading ${index}`);
    const node = nodeFor(tree, await backend(`.markdown-body [data-source-block-start="${identity.start}"]`), `Heading ${index}`);
    assert.equal(axValue(node.role), 'heading', `Heading ${index}: actual semantic role`);
    assert.equal(axProperty(node, 'level'), expected.level, `Heading ${index}: h${expected.level} level`);
    assert.equal(axValue(node.name), index === 0 ? firstHeading : expected.text, `Heading ${index}: accessible name comes from current rendered content`);
    assert.equal(axValue(node.description), description, `Heading ${index}: editing guidance is a description`);
    if (expected.ancestor) assert.equal(identity.nested, true, `${expected.ancestor} heading exercises a nested heading without an outline target`);
  }
  const paragraphs = await page.evaluate(`Array.from(document.querySelectorAll('.markdown-body p[data-reader-editable]'),e=>({start:e.dataset.sourceBlockStart,text:e.textContent}))`);
  assert.ok(paragraphs.some(item => item.text === paragraph));
  for (const item of paragraphs) {
    const node = nodeFor(tree, await backend(`.markdown-body [data-source-block-start="${item.start}"]`), 'Editable paragraph');
    assert.notEqual(axValue(node.name), description, 'Paragraphs are not all named after editing guidance');
    assert.equal(axValue(node.description), description, 'Paragraph editing guidance remains an AX description');
  }
  const staticText = reading.filter(node => axValue(node.role) === 'StaticText').map(node => axValue(node.name));
  for (const text of [paragraph, anchorText, tail, '强调😀', '链接🚀']) assert.ok(staticText.includes(text), `Full semantic StaticText includes ${text}`);
  result.checks.push(label);
  return reading.map(node => node.backendDOMNodeId).filter(Boolean);
}
async function verifyHiddenReader(label, readerBackends, expectedSource = null) {
  const tree = await captureAX(label), live = liveNodes(tree), old = new Set(readerBackends);
  assert.equal(live.some(node => old.has(node.backendDOMNodeId)), false, 'Hidden retained reader exposes no old article/heading/text nodes');
  if (expectedSource !== null) {
    const sourceNode = nodeFor(tree, await backend('[data-source-input]'), 'Source input');
    assert.equal(axValue(sourceNode.role), 'textbox', 'Source is a plain source textbox');
    assert.equal(axValue(sourceNode.name), 'Markdown 源码');
    assert.equal(axProperty(sourceNode, 'multiline'), true);
    const sourceNodes = descendants(tree, sourceNode).filter(node => !node.ignored);
    assert.equal(sourceNodes.some(node => axValue(node.role) === 'heading'), false, 'Markdown source does not acquire rendered heading semantics');
    assert.ok(sourceNodes.some(node => axValue(node.role) === 'StaticText' && axValue(node.name)?.includes('# ' + (expectedSource === source ? duplicate : duplicate + addition))),
      'The source accessibility subtree includes literal Markdown heading markers');
  }
  result.checks.push(label);
}
async function headingInput(text) {
  const selector = '.markdown-body > h1';
  await click(selector);
  assert.equal(await page.evaluate(`document.activeElement===document.querySelector(${JSON.stringify(selector)})&&document.activeElement.isContentEditable`), true, 'The real heading owns native editing focus');
  await page.evaluate(`(()=>{globalThis.__qa4NativeInput=[];const e=document.querySelector(${JSON.stringify(selector)});
    for(const type of ['beforeinput','input'])e.addEventListener(type,event=>__qa4NativeInput.push({type:event.type,isTrusted:event.isTrusted,inputType:event.inputType,data:event.data}),true);})()`);
  await key('End', 'End', 35);
  await page.send('Input.insertText', { text });
  await wait(`document.querySelector(${JSON.stringify(selector)})?.textContent===${JSON.stringify(duplicate + text)}`, 'Native input updates actual heading DOM');
  const backendNodeId = await backend(selector);
  await waitFor(async () => {
    const tree = await page.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
    return tree.nodes.some(node => !node.ignored && node.backendDOMNodeId === backendNodeId && axValue(node.name) === duplicate + text);
  }, 'AX heading name follows native unsaved DOM input');
  assert.ok(await page.evaluate(`__qa4NativeInput.some(e=>e.type==='input'&&e.isTrusted&&e.data===${JSON.stringify(text)})`), 'Actual trusted native input was observed');
  assert.equal(await page.evaluate('__sourceControl().value'), source, 'Unblurred native heading draft has not committed to source');
  assert.deepEqual(await snapshot(), result.initialFiles, 'Unblurred native input writes none of the three document files');
}
async function assertFrozenBuild() {
  assert.deepEqual(await proof(asar.path), asar, 'Selected package remains unchanged');
  assert.deepEqual(await proof(buildManifest.path), buildManifest, 'Selected build receipt remains unchanged');
  assert.deepEqual(await proof(result.script.path), result.script, 'Test script remains unchanged during a run');
}
async function stop() {
  page?.close(); main?.close(); page = main = undefined;
  if (child?.exitCode === null && child?.signalCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { child.kill('SIGKILL'); }
  }
  child = undefined;
}

try {
  await seed();
  assert.deepEqual(await readFile(fixture), originalBytes);
  assert.equal(originalBytes.at(-1) === 10 || originalBytes.at(-1) === 13, false);
  if (mode === '--fixture-check') {
    assert.equal(changedSource.split(addition).length - 1, 1, 'Only the first duplicate heading is edited');
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
    const port = 19000 + Math.floor(Math.random() * 300), profile = path.join(workspace, 'user-data');
    child = await spawn(executable, [`--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 8000}`, `--user-data-dir=${profile}`], { cwd: root, stdio: 'ignore' });
    page = await connectCdp(port, target => target.type === 'page'); main = await connectCdp(port + 8000, target => target.type === 'node');
    if (result.rendererUrl) {
      const url = new URL(result.rendererUrl).href; await page.send('Page.navigate', { url });
      await wait(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`, 'Selected development renderer');
    }
    await page.send('Page.bringToFront'); await page.send('DOM.enable'); await page.send('Accessibility.enable');
    result.environment = await main.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());
      return {execPath:process.execPath,userData:app.getPath('userData'),features:app.getAccessibilitySupportFeatures?.()??null,focused:w?.isFocused(),visible:w?.isVisible(),minimized:w?.isMinimized()};})()`);
    assert.equal(path.resolve(result.environment.userData).toLowerCase(), path.resolve(profile).toLowerCase(), 'Actual process uses the private profile');
    await main.evaluate(`(()=>{const {dialog}=process.mainModule.require('electron');dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(fixture)}]});
      dialog.showMessageBox=async(_owner,options)=>{throw Error('Unexpected native confirmation: '+options.title)};
      dialog.showSaveDialog=async()=>{throw Error('Existing private source never needs a save picker')};})()`);
    await wait('Boolean(document.querySelector("[data-start-open]"))&&typeof __sourceControl==="function"', 'Start page and source bridge');
    await click('[data-start-open]'); await reader();
    assert.equal(await page.evaluate('document.querySelector(".workspace-current-name")?.title.toLowerCase()'), fixture.toLowerCase());
    const readerBackends = await verifyReaderAX('initial-reader');
    assert.deepEqual(await snapshot(), result.initialFiles, 'Opening and AX inspection preserve source and companions');

    await click('[data-mode="editor"]'); await editor(source);
    await verifyHiddenReader('source-only', readerBackends, source);
    await click('[data-mode="cards"]');
    await wait('document.querySelector(".app-shell")?.dataset.activeMode==="cards"&&Boolean(document.querySelector("[data-canvas-flow]"))&&!document.querySelector("[data-canvas-flow]").inert', 'Canvas mode');
    await verifyHiddenReader('canvas-hidden-reader', readerBackends);
    await click('[data-mode="reader"]'); await verifyReaderAX('returned-reader');
    assert.deepEqual(await snapshot(), result.initialFiles, 'Mode changes and source semantics are zero-write');

    await headingInput('临时输入😀');
    await captureAX('native-heading-draft');
    await key('Escape', 'Escape', 27); await verifyReaderAX('escaped-reader');
    assert.equal(await page.evaluate('__sourceControl().value'), source, 'Escape restores the original source buffer');
    assert.deepEqual(await snapshot(), result.initialFiles, 'Escape restores the real heading without file writes');

    await headingInput(addition);
    await key('Enter', 'Enter', 13, 2);
    await wait(`__sourceControl().value===${JSON.stringify(changedSource)}&&document.activeElement!==document.querySelector('.markdown-body > h1')`, 'Actual blur commits a narrow heading edit');
    await verifyReaderAX('committed-heading', duplicate + addition);
    assert.deepEqual(await snapshot(), result.initialFiles, 'Blur commits only to the shared unsaved buffer');
    await click('[data-mode="editor"]'); await editor(changedSource);
    await click('[data-editor-undo]'); await editor(source);
    await click('[data-mode="reader"]'); await verifyReaderAX('undone-heading');
    await click('[data-mode="editor"]'); await editor(source);
    await click('[data-editor-redo]'); await editor(changedSource);
    await click('[data-mode="reader"]'); await verifyReaderAX('redone-heading', duplicate + addition);
    assert.deepEqual(await snapshot(), result.initialFiles, 'Cross-mode undo/redo preserves all persisted bytes and mtimes');

    await click('[data-workspace-save]');
    await wait('document.querySelector(".app-shell")?.dataset.dirty==="false"', 'Explicit Markdown save');
    await waitFor(async () => (await readFile(fixture)).equals(expectedBytes) &&
      parseAnnotationYaml(await readFile(fixture + suffixes[1], 'utf8')).source.sha256 === digest(expectedBytes), 'Exact source and mapped annotation save');
    assert.deepEqual(await readFile(fixture), expectedBytes, 'Save preserves BOM, CRLF, missing trailing newline, duplicate heading and Markdown formatting exactly');
    const mapped = parseAnnotationYaml(await readFile(fixture + suffixes[1], 'utf8')), annotation = mapped.annotations[0];
    assert.equal(mapped.annotations.length, 1); assert.deepEqual(mapped.tags, []);
    assert.equal(annotation.id, 'retained-highlight'); assert.equal(annotation.kind, 'highlight'); assert.equal(annotation.color, 'amber');
    assert.equal(annotation.anchor.basisSha256, digest(expectedBytes));
    assert.equal(annotation.anchor.sourceExact, anchorText); assert.equal(annotation.anchor.displayQuote, anchorText);
    assert.equal(annotation.anchor.startByte, expectedBytes.indexOf(Buffer.from(anchorText)));
    assert.equal(annotation.anchor.endByte, annotation.anchor.startByte + Buffer.byteLength(anchorText));
    result.savedFiles = await snapshot();
    assert.deepEqual(result.savedFiles[2], result.initialFiles[2], 'Markdown save never rewrites canvas bytes or mtime');
    assert.notEqual(result.savedFiles[0].sha256, result.initialFiles[0].sha256);
    assert.notEqual(result.savedFiles[1].sha256, result.initialFiles[1].sha256, 'Annotation sidecar advances to the new source hash');
    await verifyReaderAX('saved-reader', duplicate + addition);
    await assertFrozenBuild();
    if (nativeHoldMs > 0) {
      await reader(duplicate + addition);
      const title = 'MerMarkd QA4 标题原生验收';
      await page.evaluate(`document.title=${JSON.stringify(title)}`);
      await main.evaluate(`(()=>{const {BrowserWindow}=process.mainModule.require('electron');const w=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());w.setTitle(${JSON.stringify(title)});})()`);
      result.status = 'holding-for-native';
      result.nativeHold = { title, startedAt: new Date().toISOString(), endsAt: new Date(Date.now() + nativeHoldMs).toISOString(), milliseconds: nativeHoldMs };
      await saveReceipt();
      console.log(JSON.stringify({ status: result.status, title, reportPath, fixture, tail, nativeHold: result.nativeHold }));
      await new Promise(resolve => setTimeout(resolve, nativeHoldMs));
      assert.deepEqual(await snapshot(), result.savedFiles, 'Read-only native inspection preserves the saved source and companion files');
      await assertFrozenBuild();
    }
    result.status = 'passed';
  }
} catch (error) {
  result.status = 'failed'; result.error = error.stack ?? String(error);
  if (page) {
    await captureAX('failure').catch(() => undefined);
    result.failureState = await page.evaluate(`({mode:document.querySelector('.app-shell')?.dataset.activeMode,dirty:document.querySelector('.app-shell')?.dataset.dirty,
      analysis:document.querySelector('[data-reading-analysis]')?.dataset.readingAnalysis,source:typeof __sourceControl==='function'?__sourceControl()?.value:null,
      readerText:document.querySelector('.markdown-body')?.textContent,focus:document.activeElement?.outerHTML})`).catch(error => ({ error: error.message }));
  }
} finally {
  result.finalFiles = await snapshot().catch(error => ({ error: error.message }));
  await stop(); result.finishedAt = new Date().toISOString();
  await saveReceipt();
}
assert.equal(result.status, 'passed', `See ${reportPath}; isolated fixtures retained at ${workspace}`);
console.log(`QA4 reader accessibility ${mode} passed: ${reportPath}`);
