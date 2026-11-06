import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux7-'));
const fixture = path.join(workspace, '编辑范围.md');
const other = path.join(workspace, '另一份文档.md');
const plain = '普通段落 😀 保留文字。';
const formatted = '强调文字与链接文字。';
const longLine = '长行中文与 emoji 😀 保持原始换行。'.repeat(28);
const source = ['# 编辑范围', '', plain, '', '**强调文字**与[链接文字](https://example.com)。', '',
  '## 列表', '', '- 列表第一段。', '', '  列表第二段。', '', '## 表格', '',
  '| 项目 | 数据 |', '| --- | --- |', '| 单元格内容 | 123 |', '', '## 代码', '',
  '```ts', 'const greeting = "中文 😀";', '```', '', '## 长行', '', longLine].join('\n');
const raw = '\ufeff' + source.replace(/\n/g, '\r\n');
await Promise.all([writeFile(fixture, raw), writeFile(other, '# 另一份文档\n\n不同的完整正文。')]);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX || 'ux7';
const port = 15600 + Math.floor(Math.random() * 100);
const clients = [];
let child; let page; let main; let passed = false; let originalClipboard;

async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const body = page ? await page.evaluate('document.body.innerText.slice(0,2600)').catch(() => '') : '';
  const diagnostic = page ? await page.evaluate(`(() => {
    const describe=e=>e?{tag:e.tagName,id:e.id,class:e.className,start:e.dataset.sourceBlockStart,
      text:e.textContent?.slice(0,80),rect:e.getBoundingClientRect().toJSON()}:null;
    const shell=document.querySelector('.app-shell'),control=typeof __sourceControl==='function'?__sourceControl():null;
    return {target:document.querySelector('[data-reader-edit-target]')?.dataset.readerEditTarget,
      lastReaderTarget:globalThis.__ux7LastReaderTarget,activeMode:shell?.dataset.activeMode,
      leavePending:shell?.dataset.leavePending,focus:describe(document.activeElement),
      source:control?{start:control.selectionStart,end:control.selectionEnd,length:control.value.length}:null,
      blocks:[...document.querySelectorAll('.markdown-body h1,.markdown-body p')].slice(0,8).map(describe)};
  })()`).catch(error => ({ error: error.message })) : null;
  throw Error(`${label}: ${body}\nUX7 diagnostic: ${JSON.stringify(diagnostic)}`);
}
async function wait(expression, label) { await poll(() => page.evaluate(expression), label); }
async function frame() { await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const text = !modifiers ? key === 'Enter' ? '\r' : key.length === 1 ? key : undefined : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers,
    ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
}
async function ctrl(letter) { await key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2); }
async function clickPoint(point, label) {
  assert.ok(point, `visible enabled ${label}`);
  assert.ok(point.x >= 0 && point.x <= await page.evaluate('innerWidth'), `${label} fits viewport`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function click(selector) {
  const point = await page.evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e || e.disabled || !e.getClientRects().length) return null;
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    const r=e.getBoundingClientRect();return {x:Math.max(1,Math.min(innerWidth-1,r.x+r.width/2)),y:r.y+r.height/2};
  })()`);
  await clickPoint(point, selector); await frame();
}
async function clickText(selector, text) {
  const point = await page.evaluate(`(() => {
    const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent===${JSON.stringify(text)});
    if(!e || !e.getClientRects().length) return null;
    e.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    const r=e.getBoundingClientRect();return {x:r.x+Math.min(r.width/2,70),y:r.y+r.height/2};
  })()`);
  await clickPoint(point, text); await frame();
}
async function paste(text) {
  // This is actual paste. CDP insertText is not reliable for blank lines in CM.
  await main.evaluate(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(text)})`);
  await ctrl('v');
}
async function fileState(file) {
  try { const [bytes, info] = await Promise.all([readFile(file), stat(file)]); return { bytes: bytes.toString('base64'), mtime: info.mtimeMs }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function snapshot() {
  return Promise.all([fixture, other].map(file => Promise.all(['', '.annotations.yaml', '.mermarkd.json'].map(suffix => fileState(file + suffix)))));
}
async function unlocked() { await wait('document.querySelector(".app-shell")?.dataset.leavePending==="false"', 'leave guard unlocked'); }
async function reader(title = '编辑范围') {
  await wait(`(() => {
    const r=document.querySelector('.reading-main[data-reading-analysis="ready"]'), a=r?.querySelector('.markdown-body');
    return document.querySelector('.app-shell')?.dataset.activeMode==='reader' && a?.getClientRects().length
      && !a.closest('[inert],[hidden]') && a.querySelector('h1')?.textContent===${JSON.stringify(title)};
  })()`, `complete visible reader ${title}`); await unlocked();
}
async function editor() {
  await wait('document.querySelector(".app-shell")?.dataset.activeMode==="editor" && Boolean(__sourceControl()) && !__sourceControl().readOnly', 'source editor ready');
  await unlocked();
}
async function sourceText() { return page.evaluate('__sourceControl().value'); }
async function sourceFocused() {
  await wait('Boolean(__sourceControlElement()) && (__sourceControlElement()===document.activeElement || __sourceControlElement().contains(document.activeElement))', 'source owns focus');
}
async function atOffset(offset, label) {
  await wait(`__sourceControl().selectionStart===${offset} && __sourceControl().selectionEnd===${offset}`, label);
  await sourceFocused();
}
async function inputLine(text) {
  await click('[data-editor-goto-input]'); await ctrl('a'); await page.send('Input.insertText', { text });
}
async function screenshot(label) {
  const image = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `${prefix}-${label}.png`), Buffer.from(image.data, 'base64'));
}
async function noOverflow(label) {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `${label}: no page horizontal overflow`);
}
async function closeFeedback() {
  if (await page.evaluate(`Boolean(document.querySelector('[aria-label="关闭阅读编辑提示"]'))`)) await click('[aria-label="关闭阅读编辑提示"]');
}
async function readBlock(selector, expectedSourceOffset, label) {
  await reader();
  const selectedBlock = await page.evaluate(`(() => {
    const p=document.querySelector(${JSON.stringify(selector)});
    if(!p) return null;
    p.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    const block={selector:${JSON.stringify(selector)},start:Number(p.dataset.sourceBlockStart),text:p.textContent,
      rect:p.getBoundingClientRect().toJSON(),expectedLfOffset:${expectedSourceOffset}};
    globalThis.__ux7LastReaderTarget=block;return block;
  })()`);
  assert.ok(selectedBlock && Number.isSafeInteger(selectedBlock.start), `${label}: actual parser-backed block start`);
  assert.equal(raw.slice(1, 1 + selectedBlock.start).replace(/\r\n/g, '\n').length, expectedSourceOffset,
    `${label}: DOM source start normalizes to the expected BOM/CRLF source offset`);
  await click(selector);
  await wait(`document.querySelector('[data-reader-edit-target]')?.dataset.readerEditTarget===${JSON.stringify(String(selectedBlock.start))}
    && document.querySelector('[data-reader-edit-source]')?.disabled===false`, `${label}: guidance retains the exact clicked block`);
  assert.equal(await page.evaluate('document.querySelectorAll("[data-reader-edit-target]").length'), 1, 'one contextual edit guide');
  if (label === 'plain paragraph') {
    assert.equal(await page.evaluate(`(() => {
      const hint=document.querySelector('[data-reader-edit-target]'),r=hint.getBoundingClientRect();
      return getComputedStyle(hint).position==='fixed' && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;
    })()`), true, 'editing guidance floats within the viewport without participating in article layout');
    await screenshot('reader-guidance');
  }
  await click('[data-reader-edit-source]'); await editor(); await atOffset(expectedSourceOffset, `${label}: exact LF source offset`);
  assert.equal(await sourceText(), source, `${label}: navigating leaves complete source unchanged`);
}

try {
  child = await spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
    [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  page = await connectCdp(port, target => target.type === 'page'); clients.push(page);
  main = await connectCdp(port + 200, target => target.type === 'node'); clients.push(main);
  if (process.env.MERMARKD_QA_RENDERER_URL) {
    await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
    await wait('Boolean(document.querySelector(".app-shell")) && typeof __sourceControl==="function"', 'development renderer and test bridge ready');
  }
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await page.send('Page.bringToFront');
  originalClipboard = await main.evaluate('process.mainModule.require("electron").clipboard.readText()');
  await main.evaluate(`(() => {
    globalThis.__ux7={openPath:${JSON.stringify(fixture)},opens:0,prompts:0};
    const {dialog}=process.mainModule.require('electron');
    dialog.showOpenDialog=async()=>{__ux7.opens++;return {canceled:false,filePaths:[__ux7.openPath]}};
    dialog.showMessageBox=async(_owner,options)=>{__ux7.prompts++;throw Error('Unexpected native confirmation: '+options.title)};
    dialog.showSaveDialog=async()=>{throw Error('This zero-write scenario never requests a save')};
  })()`);
  const original = await snapshot();
  await click('[data-start-open]'); await reader();
  assert.deepEqual(await snapshot(), original, 'open and reader analysis are zero-write');

  // Context is outside the article. Focusing a reversible paragraph exposes a
  // source route without making each rendered block mount another button.
  await readBlock('.markdown-body p[data-reader-editable]', source.indexOf(plain), 'plain paragraph');
  const firstCaret = await page.evaluate('__sourceControl().selectionStart');
  await ctrl('g');
  await wait('document.activeElement?.matches("[data-editor-goto-input]")', 'Ctrl+G focuses line input');
  for (const invalid of ['0', '1.5', String(source.split('\n').length + 1)]) {
    await inputLine(invalid); await key('Enter', 'Enter', 13);
    await wait('Boolean(document.querySelector("[data-editor-goto-error]"))', 'invalid line is explained');
    assert.equal(await page.evaluate('__sourceControl().selectionStart'), firstCaret, 'invalid line cannot move source caret');
  }
  const listLine = source.slice(0, source.indexOf('## 列表')).split('\n').length;
  await inputLine(String(listLine)); await key('Enter', 'Enter', 13);
  await wait('!document.querySelector("[data-editor-goto-form]")', 'valid line closes input');
  await atOffset(source.indexOf('## 列表'), 'goto uses UTF-16 LF line offset after emoji');
  await ctrl('g'); await wait('document.activeElement?.matches("[data-editor-goto-input]")', 'line input reopened');
  await inputLine('1');
  // Synthetic composition events test only the gate. They are not evidence of
  // OS input-method behavior or actual Chinese IME acceptance.
  await page.evaluate(`document.querySelector('[data-editor-goto-input]').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}))`);
  await key('Enter', 'Enter', 13); await key('Escape', 'Escape', 27); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-editor-goto-form]")) && document.activeElement?.matches("[data-editor-goto-input]")'), true,
    'synthetic composition prevents line submission and Escape dismissal');
  assert.equal(await page.evaluate('__sourceControl().selectionStart'), source.indexOf('## 列表'), 'composition gate keeps source caret unchanged');
  assert.equal(await sourceText(), source, 'synthetic composition in a navigation field cannot change Markdown');
  await page.evaluate(`document.querySelector('[data-editor-goto-input]').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'1'}))`);
  await key('Escape', 'Escape', 27); await wait('!document.querySelector("[data-editor-goto-form]")', 'Escape dismisses goto'); await sourceFocused();

  await click('[data-editor-options-toggle]');
  await wait('Boolean(document.querySelector("[data-editor-options]"))', 'display and shortcut help');
  assert.ok((await page.evaluate('document.querySelector("[data-editor-options]").textContent')).includes('Ctrl+G'));
  assert.equal(await page.evaluate('document.querySelector("[data-editor-undo]").disabled'), true);
  await click('[data-editor-soft-wrap]');
  await wait('Boolean(document.querySelector("[data-source-editor] .cm-lineWrapping"))', 'CodeMirror visual line wrapping enabled');
  assert.equal(await sourceText(), source, 'soft wrap never inserts source newlines');
  assert.equal(await page.evaluate('document.querySelector("[data-editor-undo]").disabled'), true, 'view option creates no undo entry');
  assert.deepEqual(await snapshot(), original, 'source navigation and display controls preserve bytes/mtime');

  // A recovery modal must own its keyboard commands, even when source is active.
  await click('[aria-label="文档菜单"]'); await click('[data-open-document-recovery]');
  await wait('document.querySelector("[data-document-recovery]")?.contains(document.activeElement)', 'recovery modal focus');
  await ctrl('g'); await frame();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-editor-goto-form]"))'), false, 'Ctrl+G cannot open a background line control');
  assert.equal(await page.evaluate('document.querySelector("[data-document-recovery]")?.contains(document.activeElement)'), true);
  await click('[aria-label="关闭保存恢复"]'); await wait('!document.querySelector("[data-document-recovery]")', 'recovery dismissed');

  await click('[data-mode="reader"]'); await reader();
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-editor-options]"))'), false, 'mode switch closes temporary display help');
  await clickText('.markdown-body p[data-reader-editable]', formatted);
  await wait('Boolean(document.querySelector("[data-reader-edit-source]"))', 'formatted text has local source route');
  await click('[data-reader-edit-source]'); await editor(); await atOffset(source.indexOf('**强调文字**'), 'formatted paragraph source location');

  // Native input spanning multiple formatted leaves must be rejected and its
  // exact text retained; no flattened DOM may replace Markdown syntax.
  await click('[data-mode="reader"]'); await reader(); await clickText('.markdown-body p[data-reader-editable]', formatted);
  await ctrl('a');
  await wait(`getSelection()?.toString()===${JSON.stringify(formatted)}`, 'native select-all remains within editable paragraph');
  const rejected = '跨越格式与链接的整段替换 😀';
  await page.send('Input.insertText', { text: rejected });
  await key('Enter', 'Enter', 13, 2);
  await wait(`document.querySelector('.reader-edit-feedback textarea')?.value===${JSON.stringify(rejected)}`, 'rejected formatted input retained exactly');
  assert.equal(await sourceText(), source, 'rejected input preserves full Markdown syntax');
  await click('[data-reader-continue-source]'); await editor(); await atOffset(source.indexOf('**强调文字**'), 'rejected input source destination');
  assert.equal(await page.evaluate('document.querySelector(".reader-edit-feedback textarea")?.value'), rejected, 'source navigation keeps unapplied text');
  await closeFeedback();

  // Restricted lists/table/code use their own parser-backed block location.
  // A loose list is used so the renderer has an actual mapped paragraph.
  for (const [selector, from, to, label] of [
    ['.markdown-body li p', source.indexOf('## 列表'), source.indexOf('## 表格'), 'list paragraph'],
    ['.markdown-body td', source.indexOf('| 单元格内容'), source.indexOf('## 代码'), 'table cell'],
    ['.markdown-body pre', source.indexOf('```ts'), source.indexOf('## 长行'), 'code block'],
  ]) {
    await click('[data-mode="reader"]'); await reader(); await click(selector);
    await wait('Boolean(document.querySelector("[data-reader-edit-source]"))', `${label}: local guidance`);
    await click('[data-reader-edit-source]'); await editor(); await sourceFocused();
    const offset = await page.evaluate('__sourceControl().selectionStart');
    assert.ok(offset >= from && offset < to, `${label}: points within the correct source block`);
    assert.equal(await sourceText(), source);
  }

  await click('[data-mode="reader"]'); await reader(); await clickText('.markdown-body p[data-reader-editable]', plain);
  await key('End', 'End', 35); await key('Enter', 'Enter', 13);
  await wait('Boolean(document.querySelector(".reader-edit-feedback"))', 'Enter explains source-only paragraph splitting');
  assert.equal(await sourceText(), source); await closeFeedback();
  await clickText('.markdown-body p[data-reader-editable]', plain); await key('End', 'End', 35);
  const multiline = '不能直接拼入\n第二行 😀'; await paste(multiline);
  await wait(`document.querySelector('.reader-edit-feedback textarea')?.value===${JSON.stringify(multiline)}`, 'real multiline reader paste retained');
  assert.equal(await sourceText(), source); assert.deepEqual(await snapshot(), original);
  await click('[data-reader-continue-source]'); await editor(); await atOffset(source.indexOf(plain), 'multiline paste routes to the original source block');
  assert.equal(await page.evaluate('document.querySelector(".reader-edit-feedback textarea")?.value'), multiline);
  await closeFeedback();

  // One legal native edit still participates in the shared source history.
  await click('[data-mode="reader"]'); await reader(); await clickText('.markdown-body p[data-reader-editable]', plain);
  await key('End', 'End', 35); await page.send('Input.insertText', { text: '追加' }); await key('Enter', 'Enter', 13, 2);
  const changed = source.replace(plain, plain + '追加');
  await wait(`__sourceControl()?.value===${JSON.stringify(changed)}`, 'native reader edit reaches shared source buffer');
  await click('[data-mode="editor"]'); await editor(); await sourceFocused();
  await ctrl('z'); await wait(`__sourceControl().value===${JSON.stringify(source)}`, 'source undo reverses native reader edit');
  await ctrl('y'); await wait(`__sourceControl().value===${JSON.stringify(changed)}`, 'source redo reapplies native reader edit');
  await ctrl('z'); await wait(`__sourceControl().value===${JSON.stringify(source)}`, 'return to exact persisted source');
  await wait('document.querySelector(".app-shell")?.dataset.dirty==="false"', 'exact undo restores clean source');

  for (const width of [420, 800]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }); await frame();
    await click('[data-editor-options-toggle]');
    if (!await page.evaluate('document.querySelector("[data-editor-soft-wrap]").checked')) await click('[data-editor-soft-wrap]');
    await click('[data-editor-goto-toggle]'); await wait('document.activeElement?.matches("[data-editor-goto-input]")', 'narrow goto focus');
    await noOverflow(`${width} display controls`); await screenshot(`controls-${width}`);
    await key('Escape', 'Escape', 27); await sourceFocused(); await click('[data-editor-options-toggle]');
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false }); await frame();
  await click('[data-editor-options-toggle]'); await ctrl('g');
  await main.evaluate(`__ux7.openPath=${JSON.stringify(other)}`); await ctrl('o'); await reader('另一份文档');
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-editor-options],[data-editor-goto-form]"))'), false, 'document replacement closes temporary controls');
  assert.deepEqual(await snapshot(), original, 'every edit was undone; display, navigation and mode changes write none of the three content files');
  assert.equal(await main.evaluate('__ux7.prompts'), 0, 'no unexpected save/discard permission was needed');
  passed = true;
  console.log(JSON.stringify({ status: 'passed', sourceWrapWithoutMutation: true, exactGotoLine: true, shortcutHelp: true,
    contextualReaderRoutes: true, rejectedFormattedInputRetained: true, multilinePasteRetained: true,
    crossModeUndoRedo: true, modalShortcutIsolation: true, syntheticCompositionGate: true, narrowWidths: [420, 800], threeFileZeroWrites: true,
    actualImeDeviceAcceptance: 'not performed by this synthetic-input test' }));
} catch (error) {
  if (page) await screenshot('failure').catch(() => {});
  console.error(`UX7 fixtures retained: ${workspace}`); throw error;
} finally {
  if (main && originalClipboard !== undefined) await main.evaluate(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(originalClipboard)})`).catch(() => {});
  for (const client of clients) client.close();
  if (child?.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  if (passed) {
    assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep), 'cleanup stays within temporary fixture directory');
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
