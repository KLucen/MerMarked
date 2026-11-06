import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux6b-'));
const documentA = path.join(workspace, '文档 A.md');
const documentB = path.join(workspace, '文档 B.md');
const firstSave420 = path.join(workspace, '窄屏 420.md');
const firstSave800 = path.join(workspace, '窄屏 800.md');
const firstSaveOpen = path.join(workspace, '首存后继续打开.md');
const contentA = '\ufeff# 文档 A\r\n\r\n甲段用于批注与保存验证。\r\n\r\n## 保存核对\r\n\r\n保留末行。';
const contentB = '# 文档 B\n\n乙段是另一份独立文档。\n';
await Promise.all([writeFile(documentA, contentA), writeFile(documentB, contentB)]);
const tracked = [documentA, documentB, firstSave420, firstSave800, firstSaveOpen];
const qa = path.join(root, 'out/qa');
const artifactPrefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX || 'ux6b';
await mkdir(qa, { recursive: true });
const port = 15400 + Math.floor(Math.random() * 100);
const clients = [];
let child;
let page;
let main;
let passed = false;
let originalClipboardText;

// Poll state transitions rather than relying on a fixed delay after user input.
async function poll(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  const body = page ? await page.evaluate('document.body.innerText.slice(0,2200)').catch(() => '') : '';
  throw Error(`${label}: ${body}`);
}
async function wait(expression, label) { await poll(() => page.evaluate(expression), label); }
async function unlocked() {
  await wait('document.querySelector(".app-shell")?.dataset.leavePending==="false"', 'departure guard released');
}
async function clickPoint(point, label) {
  assert.ok(point, `visible enabled ${label}`);
  assert.ok(point.x >= 0 && point.x <= await page.evaluate('innerWidth'), `${label} inside viewport`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function click(selector) {
  const point = await page.evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});
    if(!e || e.disabled || !e.getClientRects().length) return null;
    e.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await clickPoint(point, selector);
}
async function clickText(selector, text) {
  const point = await page.evaluate(`(() => {
    const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});
    if(!e || e.disabled || !e.getClientRects().length) return null;
    e.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await clickPoint(point, text);
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
  }
}
async function ctrl(letter) { await key(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), 2); }
async function frame() {
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function pasteSource(text) {
  // Chromium's Input.insertText may collapse blank lines in CodeMirror's
  // contenteditable. Use the real paste path for exact multiline source input.
  await main.evaluate(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(text)})`);
  await ctrl('v');
}
async function escape() { await key('Escape', 'Escape', 27); }
async function metrics(width, height = 800) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function screenshot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `${artifactPrefix}-${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function fileState(file) {
  try {
    const [bytes, info] = await Promise.all([readFile(file), stat(file)]);
    return { bytes: bytes.toString('base64'), mtime: info.mtimeMs };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function documentState(file) {
  return Promise.all(['', '.annotations.yaml', '.mermarkd.json'].map(suffix => fileState(file + suffix)));
}
async function snapshot() { return Promise.all(tracked.map(documentState)); }
async function dirty(value) {
  await wait(`document.querySelector('.app-shell')?.dataset.dirty===${JSON.stringify(String(value))}`, `dirty=${value}`);
}
async function start() {
  await wait('document.querySelector(".app-shell")?.dataset.documentOpen==="false" && document.querySelectorAll("[data-start-open]").length===1 && document.querySelectorAll("[data-start-new]").length===1', 'single start page open/new entry');
  await unlocked();
  assert.equal(await main.evaluate('process.mainModule.require("electron").BrowserWindow.getAllWindows().length'), 1, 'document close keeps the window');
}
async function reader(title) {
  await wait(`(() => {
    const reading=document.querySelector('.reading-main[data-reading-analysis="ready"]');
    const body=reading?.querySelector('.markdown-body');
    const paragraph=body?.querySelector('p[data-reader-editable]');
    return document.querySelector('.app-shell')?.dataset.activeMode==='reader'
      && reading && reading.getClientRects().length && !reading.closest('[hidden],[inert]')
      && body && body.getClientRects().length && !body.closest('[hidden],[inert]')
      && paragraph && paragraph.getClientRects().length && !paragraph.closest('[hidden],[inert]')
      && body.querySelector('h1')?.textContent===${JSON.stringify(title)};
  })()`, `ready visible reader ${title}`);
  await unlocked();
}
async function editor() {
  await wait('document.querySelector(".app-shell")?.dataset.activeMode==="editor" && Boolean(__sourceControl()) && !__sourceControl().readOnly', 'source editor ready');
  await unlocked();
}
async function editorFocused() {
  await wait('Boolean(__sourceControlElement()) && (__sourceControlElement()===document.activeElement || __sourceControlElement().contains(document.activeElement))', 'new document focuses source input');
}
async function sourceText() { return page.evaluate('__sourceControl().value'); }
async function sourceAppend(text) {
  if (await page.evaluate('document.querySelector(".app-shell").dataset.activeMode!=="editor"')) await click('[data-mode="editor"]');
  await editor();
  await page.send('Page.bringToFront');
  await frame();
  await click('[data-source-editor] .cm-content, [data-editor-textarea]');
  await editorFocused();
  await frame();
  await key('End', 'End', 35, 2);
  const atEnd = '(() => {const e=__sourceControl();return e.selectionStart===e.value.length && e.selectionEnd===e.value.length})()';
  await wait(atEnd, 'Ctrl+End places source caret at exact document end');
  await frame();
  assert.equal(await page.evaluate(atEnd), true, 'source caret remains at document end before paste');
  await pasteSource(text);
  await dirty(true);
}
async function choices(source, local = 2) {
  await main.evaluate(`globalThis.__ux6b.sourceChoice=${source};globalThis.__ux6b.localChoice=${local};void 0`);
}
async function openTarget(file, canceled = false) {
  await main.evaluate(`globalThis.__ux6b.openResult={canceled:${canceled},filePaths:${JSON.stringify(file ? [file] : [])}};void 0`);
}
async function saveTarget(file, canceled = false) {
  await main.evaluate(`globalThis.__ux6b.saveResult={canceled:${canceled},filePath:${JSON.stringify(file)}};void 0`);
}
async function counts() {
  return main.evaluate('({open:__ux6b.opens.length,save:__ux6b.saves.length,source:__ux6b.prompts.filter(p=>p.title==="正文尚未保存").length,local:__ux6b.prompts.filter(p=>p.title==="还有未提交的输入").length})');
}
async function waitCount(kind, value) {
  await poll(async () => (await counts())[kind] === value, `${kind} dialog count=${value}`);
  await unlocked();
}
async function menu() {
  await click('[aria-label="文档菜单"]');
  await wait('Boolean(document.querySelector("[data-workspace-new]")?.getClientRects().length)', 'document menu open');
}
async function openFromStart(file, title) { await openTarget(file); await click('[data-start-open]'); await reader(title); }
async function openByShortcut(file, title) { await openTarget(file); await ctrl('o'); await reader(title); }
async function recoveryBlocksDocumentShortcuts(label) {
  const identity = () => page.evaluate(`(() => ({
    open:document.querySelector('.app-shell')?.dataset.documentOpen,
    path:document.querySelector('.workspace-current-name')?.title ?? null,
    mode:document.querySelector('.app-shell')?.dataset.activeMode,
  }))()`);
  const beforeIdentity = await identity();
  const beforeFiles = await snapshot();
  const beforeDialogs = await counts();
  if (beforeIdentity.open === 'true') await menu();
  await click('[data-open-document-recovery]');
  const focusedModal = `(() => {
    const dialog=document.querySelector('[data-document-recovery][role="dialog"]');
    return Boolean(dialog?.getClientRects().length) && dialog.contains(document.activeElement)
      && document.querySelector('[aria-label="关闭保存恢复"]')?.disabled===false;
  })()`;
  await wait(focusedModal, `${label}: recovery dialog owns focus and is ready`);
  for (const letter of ['n', 'w', 'o']) {
    await ctrl(letter); await frame();
    assert.equal(await page.evaluate(focusedModal), true, `${label}: Ctrl+${letter.toUpperCase()} keeps focus in recovery dialog`);
    assert.equal(await page.evaluate('document.querySelector(".app-shell").dataset.leavePending'), 'false', `${label}: recovery shortcut starts no departure`);
    assert.deepEqual(await identity(), beforeIdentity, `${label}: Ctrl+${letter.toUpperCase()} cannot replace or close the document`);
    assert.deepEqual(await counts(), beforeDialogs, `${label}: Ctrl+${letter.toUpperCase()} opens no picker or confirmation`);
    assert.deepEqual(await snapshot(), beforeFiles, `${label}: Ctrl+${letter.toUpperCase()} writes none of the three document files`);
  }
  await click('[aria-label="关闭保存恢复"]');
  await wait('!document.querySelector("[data-document-recovery]")', `${label}: recovery dialog closed`);
  assert.deepEqual(await identity(), beforeIdentity, `${label}: dismissing recovery retains the document`);
  assert.deepEqual(await counts(), beforeDialogs);
  assert.deepEqual(await snapshot(), beforeFiles);
}
async function assertNoOverflow(label) {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true, `${label}: no page horizontal overflow`);
}
async function compose(text, tag) {
  await reader('文档 A');
  await page.send('Page.bringToFront');
  await click('.markdown-body p[data-reader-editable]');
  // Test-only selection setup, shared with UX6A: this scenario verifies form
  // and departure persistence, not native selection gestures. Focus and all
  // subsequent form input/actions still use real mouse and keyboard events.
  const selected = await page.evaluate(`(() => {
    const p=document.querySelector('.markdown-body p[data-reader-editable]');
    if(!p || p.textContent!=='甲段用于批注与保存验证。') return null;
    p.focus();
    const range=document.createRange();range.selectNodeContents(p);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return selection.toString();
  })()`);
  assert.equal(selected, '甲段用于批注与保存验证。', 'test selection has the exact annotation quote');
  await wait(`(() => {
    const p=document.querySelector('.markdown-body p[data-reader-editable]'),s=getSelection();
    return document.activeElement===p && s?.toString()==='甲段用于批注与保存验证。'
      && p.contains(s.anchorNode) && p.contains(s.focusNode);
  })()`, 'test selection remains exact in the native Selection object');
  await wait('Boolean(document.querySelector("[data-selection-capability]")) && document.querySelector(".selection-quote")?.title==="甲段用于批注与保存验证。"', 'annotation selection capability');
  await wait('document.querySelector(".add-note-button")?.disabled===false', 'selected text can start a note');
  await click('.add-note-button');
  await wait('Boolean(document.querySelector("#new-note-body")?.getClientRects().length) && !document.querySelector("#new-note-body").disabled', 'note composer ready');
  await click('#new-note-body'); await page.send('Input.insertText', { text });
  if (tag) {
    await click('#new-note-tag');
    await key('End', 'End', 35); await key('Enter', 'Enter', 13);
    await wait('Boolean(document.querySelector("#new-note-tag-name"))', 'new tag field');
    await click('#new-note-tag-name'); await page.send('Input.insertText', { text: tag });
  }
}
async function assertDraft(text, tag) {
  assert.equal(await page.evaluate('document.querySelector("#new-note-body")?.value'), text);
  assert.equal(await page.evaluate('document.querySelector("#new-note-tag-name")?.value'), tag);
  assert.equal(await page.evaluate('document.querySelector("#new-note-tag")?.value'), '__new__');
}

try {
  child = await spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
    [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  page = await connectCdp(port, target => target.type === 'page'); clients.push(page);
  main = await connectCdp(port + 200, target => target.type === 'node'); clients.push(main);
  if (process.env.MERMARKD_QA_RENDERER_URL) {
    await page.send('Page.navigate', { url: process.env.MERMARKD_QA_RENDERER_URL });
    await wait('Boolean(document.querySelector(".app-shell")) && typeof __sourceControl==="function" && typeof __sourceControlElement==="function"', 'requested renderer and source test bridge ready');
  }
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.bringToFront');
  const nativeMenu = await main.evaluate(`(() => {
    const walk=(items,parents=[])=>items.flatMap(item=>{
      const role=String(item.role??'').toLowerCase();
      return [{id:item.id,role,label:item.label,accelerator:item.accelerator,enabled:item.enabled,visible:item.visible,parents},
        ...walk(item.submenu?.items??[],[...parents,role])];
    });
    return walk(process.mainModule.require('electron').Menu.getApplicationMenu()?.items??[]);
  })()`);
  const closeMenuItem = nativeMenu.find(item => item.id === 'close-window');
  assert.ok(closeMenuItem, 'native menu retains explicit window close');
  assert.equal(closeMenuItem.accelerator, null, 'native window close has no accelerator');
  assert.ok(closeMenuItem.parents.includes('windowmenu') && closeMenuItem.enabled && closeMenuItem.visible, 'window close remains available in the native Window menu');
  assert.equal(closeMenuItem.role, '', 'window close does not inherit a role default accelerator');
  assert.ok(nativeMenu.every(item => !/^(?:ctrl|control|commandorcontrol|cmdorctrl)\+w$/i.test(String(item.accelerator ?? '').replace(/\s/g, ''))), 'no native menu accelerator consumes Ctrl+W');
  assert.ok(nativeMenu.some(item => item.role === 'editmenu'), 'native Edit menu remains available');
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']) {
    assert.ok(nativeMenu.some(item => item.role === role && item.parents.includes('editmenu')), `native Edit preserves ${role}`);
  }
  originalClipboardText = await main.evaluate('process.mainModule.require("electron").clipboard.readText()');
  await main.evaluate(`(() => {
    globalThis.__ux6b={sourceChoice:2,localChoice:2,localPromptDelayMs:0,prompts:[],opens:[],saves:[],events:[],openResult:{canceled:true,filePaths:[]},saveResult:{canceled:true}};
    const {dialog}=process.mainModule.require('electron');
    dialog.showMessageBox=async(_owner,options)=>{
      __ux6b.prompts.push({title:options.title,buttons:options.buttons,detail:options.detail});
      __ux6b.events.push({kind:'message',title:options.title,sourceChoice:__ux6b.sourceChoice,localChoice:__ux6b.localChoice});
      if(options.title==='正文尚未保存') return {response:__ux6b.sourceChoice};
      if(options.title==='还有未提交的输入') {
        if(__ux6b.localPromptDelayMs) await new Promise(resolve=>setTimeout(resolve,__ux6b.localPromptDelayMs));
        return {response:__ux6b.localChoice};
      }
      throw Error('Unexpected native confirmation: '+options.title);
    };
    dialog.showOpenDialog=async(_owner,options)=>{__ux6b.opens.push(options);__ux6b.events.push({kind:'open',canceled:__ux6b.openResult.canceled});return __ux6b.openResult;};
    dialog.showSaveDialog=async(_owner,options)=>{__ux6b.saves.push(options);__ux6b.events.push({kind:'save',canceled:__ux6b.saveResult.canceled});return __ux6b.saveResult;};
  })()`);
  await metrics(1200); await start();
  const original = await snapshot();
  await recoveryBlocksDocumentShortcuts('start page');
  await start();

  // Ctrl+N creates a source document. Cancelling first save retains both bytes
  // in memory and the exact close intent, without creating any companion files.
  await ctrl('n'); await editor(); await editorFocused();
  const unsaved = '# 未保存草稿\n\n不能丢失的正文。';
  await pasteSource(unsaved); await dirty(true);
  assert.equal(await sourceText(), unsaved);
  const directClose = await page.evaluate('window.mermarkd.closeMarkdown().then(()=>({accepted:true}),error=>({accepted:false,message:error.message}))');
  assert.equal(directClose.accepted, false, 'main process independently rejects dirty document close');
  assert.equal(await sourceText(), unsaved);
  await choices(0); await saveTarget(undefined, true);
  const firstCounts = await counts(); await ctrl('w'); await waitCount('save', firstCounts.save + 1);
  await wait('document.querySelector("[data-document-intent]")?.dataset.documentIntent==="close"', 'first-save cancellation retains close intent');
  await dirty(true); assert.equal(await sourceText(), unsaved);
  assert.deepEqual(await snapshot(), original, 'cancelled first save is zero-write');
  assert.deepEqual(await main.evaluate('__ux6b.prompts.at(-1).buttons'), ['保存并继续', '放弃正文修改并继续', '取消']);
  await screenshot('first-save-cancel');
  await click('[data-document-intent-cancel]');
  await wait('!document.querySelector("[data-document-intent]")', 'pending operation cancelled');
  assert.equal(await sourceText(), unsaved); await dirty(true);
  assert.deepEqual(await snapshot(), original, 'cancelling pending operation is zero-write');
  await choices(2); const cancelCloseCounts = await counts();
  await ctrl('w'); await waitCount('source', cancelCloseCounts.source + 1);
  assert.equal(await sourceText(), unsaved); await dirty(true);
  assert.equal(await page.evaluate('Boolean(document.querySelector("[data-document-intent]"))'), false);
  assert.deepEqual(await snapshot(), original, 'source close cancellation preserves all three files');
  await choices(1); await ctrl('w'); await start();
  assert.deepEqual(await snapshot(), original, 'discard closes only the document');

  // A real BOM/CRLF source conflict must stop before the target picker. Repairing
  // that external change and retrying saves once and resumes the original open.
  await openFromStart(documentA, '文档 A');
  assert.deepEqual(await snapshot(), original, 'opening existing document is zero-write');
  await recoveryBlocksDocumentShortcuts('opened document A');
  await reader('文档 A');
  await menu(); await openTarget(undefined, true);
  const menuCancelCounts = await counts();
  await clickText('.workspace-popover button', '打开文档 Ctrl+O');
  await waitCount('open', menuCancelCounts.open + 1);
  await wait('document.activeElement?.getAttribute("aria-label")==="文档菜单"', 'cancelled menu operation restores menu trigger focus');
  assert.deepEqual(await snapshot(), original, 'cancelled menu picker is zero-write');
  const addition = '\n\n应用中追加。'; await sourceAppend(addition);
  const editedA = contentA.slice(1).replace(/\r\n/g, '\n') + addition;
  assert.equal(await sourceText(), editedA);
  await choices(2); await openTarget(documentB); const cancelOpenCounts = await counts();
  await ctrl('o'); await waitCount('source', cancelOpenCounts.source + 1);
  assert.equal((await counts()).open, cancelOpenCounts.open, 'cancel happens before open picker');
  assert.equal(await sourceText(), editedA); assert.deepEqual(await snapshot(), original);
  await writeFile(documentA, contentA + '\r\n外部冲突。');
  const conflicted = await snapshot();
  await choices(0); const conflictCounts = await counts();
  await ctrl('o'); await waitCount('source', conflictCounts.source + 1);
  await wait('document.querySelector("[data-document-intent]")?.dataset.documentIntent==="open" && !document.querySelector("[data-document-intent-retry]").disabled', 'failed save keeps open intent');
  await dirty(true); assert.equal(await sourceText(), editedA);
  assert.equal((await counts()).open, conflictCounts.open, 'conflicted save never opens target picker');
  assert.deepEqual(await snapshot(), conflicted, 'conflicted save does not overwrite source or either sidecar');
  await screenshot('save-conflict');
  await writeFile(documentA, contentA);
  await openTarget(documentB); const retryCounts = await counts();
  await click('[data-document-intent-retry]'); await reader('文档 B');
  assert.equal((await counts()).source, retryCounts.source, 'retry uses preserved save decision');
  assert.equal((await counts()).open, retryCounts.open + 1, 'retry resumes original open exactly once');
  const savedA = contentA + addition.replace(/\n/g, '\r\n');
  assert.equal(await readFile(documentA, 'utf8'), savedA, 'save preserves BOM, CRLF and exact edited text');
  assert.equal(await readFile(documentB, 'utf8'), contentB);
  for (const file of [documentA, documentB]) {
    assert.deepEqual((await documentState(file)).slice(1), [null, null], 'source save creates no absent sidecars');
  }

  // UX6A local form authorization precedes source authorization and the picker.
  // Discard permission only takes effect after successfully replacing a document.
  await openByShortcut(documentA, '文档 A');
  const beforeNote = await snapshot();
  const noteDraft = '离开取消时保留便签和标签'; const tagDraft = '待整理';
  await compose(noteDraft, tagDraft); await click('#new-note-body');
  await choices(2, 2); await openTarget(documentB); const localCancelCounts = await counts();
  await ctrl('o'); await waitCount('local', localCancelCounts.local + 1);
  await assertDraft(noteDraft, tagDraft);
  await wait('document.activeElement?.id==="new-note-body"', 'cancel restores draft focus');
  assert.equal((await counts()).open, localCancelCounts.open);
  assert.equal((await counts()).source, localCancelCounts.source, 'local cancel does not ask to save source');
  assert.deepEqual(await snapshot(), beforeNote);
  await choices(2, 0); const returnCounts = await counts();
  await ctrl('o'); await waitCount('local', returnCounts.local + 1);
  await wait('document.activeElement?.id==="new-note-body"', 'return to inputs focuses note body');
  await assertDraft(noteDraft, tagDraft);
  await choices(2, 1); await openTarget(documentB, true); const pickerCancelCounts = await counts();
  await ctrl('o'); await waitCount('open', pickerCancelCounts.open + 1);
  await assertDraft(noteDraft, tagDraft);
  await wait('document.activeElement?.id==="new-note-body"', 'cancelled picker restores draft focus');
  assert.deepEqual(await snapshot(), beforeNote, 'discard permission and cancelled picker never write YAML');
  await openTarget(documentB); await ctrl('o'); await reader('文档 B');
  assert.equal(await page.evaluate('Boolean(document.querySelector("#new-note-body"))'), false);
  assert.deepEqual(await snapshot(), beforeNote, 'successful navigation drops local draft without saving it');
  await openByShortcut(documentA, '文档 A');
  assert.equal(await page.evaluate('Boolean(document.querySelector("#new-note-body"))'), false);
  assert.equal(await fileState(documentA + '.annotations.yaml'), null);

  // Existing saved notes use the same guard for Ctrl+W. Neither cancel nor
  // confirmed discard turns an edit form into a saved annotation mutation.
  const savedNoteText = '已明确保存的便签'; await compose(savedNoteText);
  await wait('!document.querySelector(".note-composer button[type=submit]").disabled', 'note can save');
  await page.evaluate(`(() => {
    const life=globalThis.__ux6bSavedNotice={shownAt:null,removedAt:null};
    const observer=new MutationObserver(()=>{
      const notice=document.querySelector('.notice.status');
      if(notice?.textContent.includes('批注已保存，Markdown 原文未修改。') && life.shownAt===null) life.shownAt=performance.now();
      if(life.shownAt!==null && !notice && life.removedAt===null) {life.removedAt=performance.now();observer.disconnect();}
    });
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  })()`);
  await click('.note-composer button[type=submit]');
  await wait('!document.querySelector("#new-note-body") && document.querySelector(".note-body")?.textContent==="已明确保存的便签"', 'note persisted');
  await wait('document.querySelector(".notice.status")?.textContent.includes("批注已保存，Markdown 原文未修改。") && __ux6bSavedNotice.shownAt!==null', 'successful note save displays a status notice');
  await poll(() => page.evaluate('__ux6bSavedNotice.removedAt!==null && !document.querySelector(".notice.status")'), 'saved-note status automatically dismisses after five seconds', 8000);
  const noticeLifetime = await page.evaluate('__ux6bSavedNotice.removedAt-__ux6bSavedNotice.shownAt');
  assert.ok(noticeLifetime >= 4900 && noticeLifetime <= 7500, `status notice lifetime is approximately five seconds: ${noticeLifetime}ms`);
  const afterNote = await snapshot();
  assert.deepEqual(afterNote[0][0], beforeNote[0][0], 'saving annotation preserves source bytes and mtime');
  for (let index = 1; index < tracked.length; index++) assert.deepEqual(afterNote[index], beforeNote[index], 'saving note leaves other documents untouched');
  assert.equal((await documentState(documentA))[0].bytes, Buffer.from(savedA).toString('base64'));
  assert.equal(await fileState(documentA + '.mermarkd.json'), null);
  await clickText('.note-card-actions button', '编辑');
  await wait('Boolean(document.querySelector(".note-edit-form textarea"))', 'saved note edit form');
  await click('.note-edit-form textarea'); await ctrl('a');
  const unsavedNoteEdit = '这次便签修改不能自动提交';
  await page.send('Input.insertText', { text: unsavedNoteEdit });
  await choices(2, 2); const editCancelCounts = await counts();
  await ctrl('w'); await waitCount('local', editCancelCounts.local + 1);
  assert.equal(await page.evaluate('document.querySelector(".note-edit-form textarea")?.value'), unsavedNoteEdit);
  await wait('document.activeElement?.matches(".note-edit-form textarea")', 'cancel restores saved-note edit focus');
  assert.deepEqual(await snapshot(), afterNote, 'edit-note close cancellation is zero-write');
  await choices(2, 1); await ctrl('w'); await start();
  assert.equal((await counts()).source, editCancelCounts.source, 'clean source close needs no source confirmation');
  assert.deepEqual(await snapshot(), afterNote, 'closing discards unsaved note edits without writing YAML');
  await openFromStart(documentA, '文档 A');
  await wait('document.querySelector(".note-body")?.textContent==="已明确保存的便签"', 'reopen retains saved note only');
  assert.equal(await page.evaluate('Boolean(document.querySelector(".note-edit-form"))'), false);

  // The two save labels refer to different files. An actual view save must
  // create the canvas companion while keeping Markdown and annotations intact.
  await openByShortcut(documentB, '文档 B');
  const beforeView = await documentState(documentB);
  await click('[data-mode="cards"]');
  await wait('document.querySelector("[data-canvas-save]")?.disabled===false', 'canvas ready');
  assert.equal(await page.evaluate('document.querySelector("[data-workspace-save]").textContent.trim()'), '保存正文');
  assert.equal(await page.evaluate('document.querySelector("[data-canvas-save]").textContent.trim()'), '保存视图');
  assert.equal(await page.evaluate('document.querySelector("[data-workspace-save]").disabled'), true, 'clean source save is separate from view save');
  await click('[data-canvas-save]');
  await poll(async () => Boolean(await fileState(documentB + '.mermarkd.json')), 'view companion persisted');
  const afterView = await documentState(documentB);
  assert.deepEqual(afterView.slice(0, 2), beforeView.slice(0, 2), 'view save preserves source and annotation bytes and mtimes');
  assert.ok(JSON.parse(await readFile(documentB + '.mermarkd.json', 'utf8')).source.sha256, 'view file has a source basis');
  await click('[data-mode="reader"]'); await reader('文档 B');
  await ctrl('w'); await start();

  // At both narrow widths all three menu entries are reachable with actual
  // clicks. First-save success and close/reopen are exercised in each layout.
  for (const [width, file] of [[420, firstSave420], [800, firstSave800]]) {
    await metrics(width); await assertNoOverflow(`${width} start`);
    await openFromStart(documentA, '文档 A'); await menu();
    assert.equal(await page.evaluate(`(() => {
      const controls=[document.querySelector('[data-workspace-new]'),document.querySelector('[data-workspace-close]'),
        [...document.querySelectorAll('.workspace-popover button')].find(e=>e.textContent.trim().startsWith('打开文档'))];
      return controls.every(e=>e&&!e.disabled&&e.getClientRects().length&&(()=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})());
    })()`), true, `${width}: new/open/close menu controls fit and are enabled`);
    await assertNoOverflow(`${width} menu`); await screenshot(`menu-${width}`);
    await openTarget(documentB); await clickText('.workspace-popover button', '打开文档 Ctrl+O'); await reader('文档 B');
    await menu(); await click('[data-workspace-new]'); await editor(); await editorFocused();
    const narrowText = `# 窄屏 ${width}\n\n首次保存的正文。`;
    await pasteSource(narrowText); await dirty(true);
    assert.equal(await sourceText(), narrowText);
    await assertNoOverflow(`${width} source`); await screenshot(`source-${width}`);
    const beforeNarrowSave = await snapshot();
    await saveTarget(file); await choices(0);
    if (width === 420) {
      await click('[data-workspace-save]'); await dirty(false);
      await wait(`document.querySelector('.workspace-current-name')?.title===${JSON.stringify(file)}`, 'first save changes document identity');
      await menu(); await click('[data-workspace-close]'); await start();
    } else {
      await menu(); await click('[data-workspace-close]'); await start();
    }
    assert.equal(await readFile(file, 'utf8'), narrowText, `${width}: exact first-save content`);
    assert.deepEqual((await documentState(file)).slice(1), [null, null], `${width}: first save does not create sidecars`);
    const afterNarrowSave = await snapshot();
    for (let index = 0; index < tracked.length; index++) {
      if (tracked[index] !== file) assert.deepEqual(afterNarrowSave[index], beforeNarrowSave[index], `${width}: first save leaves other documents untouched`);
    }
    await openFromStart(file, `窄屏 ${width}`);
    await assertNoOverflow(`${width} reopened reader`);
    assert.equal(await page.evaluate('document.querySelector("[data-workspace-save]").disabled'), true);
    await menu(); await click('[data-workspace-close]'); await start();
    assert.deepEqual(await snapshot(), afterNarrowSave, `${width}: close/reopen is zero-write`);
  }
  await metrics(1200);
  // First save can also be part of Ctrl+O itself: save the temporary document,
  // then automatically show the original picker and open its target.
  await ctrl('n'); await editor(); await editorFocused();
  const firstOpenText = '# 首存后继续打开\n\n这一行必须精确保存。';
  await pasteSource(firstOpenText); await dirty(true);
  const beforeFirstOpen = await snapshot();
  await choices(0); await saveTarget(firstSaveOpen); await openTarget(documentB);
  const firstOpenCounts = await counts();
  await ctrl('o'); await reader('文档 B');
  const afterFirstOpenCounts = await counts();
  assert.equal(afterFirstOpenCounts.source, firstOpenCounts.source + 1);
  assert.equal(afterFirstOpenCounts.save, firstOpenCounts.save + 1);
  assert.equal(afterFirstOpenCounts.open, firstOpenCounts.open + 1);
  assert.equal(await readFile(firstSaveOpen, 'utf8'), firstOpenText);
  assert.deepEqual((await documentState(firstSaveOpen)).slice(1), [null, null], 'first-save-and-open creates no empty sidecar');
  const afterFirstOpen = await snapshot();
  for (let index = 0; index < tracked.length - 1; index++) assert.deepEqual(afterFirstOpen[index], beforeFirstOpen[index], 'first-save-and-open preserves other documents');
  await ctrl('w'); await start();
  assert.deepEqual(await snapshot(), afterFirstOpen);

  // Keep the prior scenarios' complete snapshots separate from this combined
  // source-buffer/native-reader-input boundary. No companion is created for C.
  const documentC = path.join(workspace, '组合输入边界.md');
  const contentC = '# 组合输入边界\n\n原生段落。';
  const sourceAdditionC = '\n\n源码追加。';
  const nativeAdditionC = '段内输入。';
  const nativeParagraphC = '原生段落。' + nativeAdditionC;
  const sourceOnlyC = contentC + sourceAdditionC;
  const combinedC = contentC.replace('原生段落。', nativeParagraphC) + sourceAdditionC;
  await writeFile(documentC, contentC);
  const beforeCombined = await documentState(documentC);
  await openFromStart(documentC, '组合输入边界');
  await sourceAppend(sourceAdditionC);
  assert.equal(await sourceText(), sourceOnlyC);
  await click('[data-mode="reader"]'); await reader('组合输入边界');
  const nativePoint = await page.evaluate(`(() => {
    const p=document.querySelector('.markdown-body p[data-reader-editable]');
    if(p?.textContent!=='原生段落。') return null;
    p.scrollIntoView({block:'center'});
    const r=document.createRange();r.selectNodeContents(p);const b=r.getBoundingClientRect();
    return {x:b.right+1,y:b.top+b.height/2};
  })()`);
  await clickPoint(nativePoint, 'native editable paragraph end');
  await key('End', 'End', 35);
  await wait(`(() => {const p=document.querySelector('.markdown-body p[data-reader-editable]'),s=getSelection();
    return document.activeElement===p && s?.isCollapsed && p.contains(s.anchorNode)
      && s.anchorNode.nodeType===Node.TEXT_NODE && s.anchorOffset===s.anchorNode.textContent.length;})()`, 'native paragraph end caret');
  await page.send('Input.insertText', { text: nativeAdditionC });
  await wait(`document.activeElement===document.querySelector('.markdown-body p[data-reader-editable]') && document.activeElement.textContent===${JSON.stringify(nativeParagraphC)}`, 'unblurred native reader input retained');
  assert.equal(await sourceText(), sourceOnlyC, 'native input has not silently replaced source before blur');
  assert.deepEqual(await documentState(documentC), beforeCombined, 'native typing does not write any document file');

  await choices(0, 1); await openTarget(documentB, true);
  await main.evaluate('__ux6b.localPromptDelayMs=100;void 0');
  const combinedCounts = await counts();
  const combinedEventStart = await main.evaluate('__ux6b.events.length');
  // The delayed native confirmation gives actual inert blur/commit events a
  // turn. It does not authorize a different local or source input snapshot.
  await ctrl('o'); await waitCount('local', combinedCounts.local + 1); await frame();
  const retainedInput = async () => page.evaluate(`(() => ({
    source:__sourceControl()?.value,
    draft:document.querySelector('.reader-edit-feedback textarea')?.value,
    native:document.querySelector('.markdown-body p[data-reader-editable]')?.textContent,
    dirty:document.querySelector('.app-shell')?.dataset.dirty==='true',
    path:document.querySelector('.workspace-current-name')?.title,
  }))()`);
  let retained = await retainedInput();
  assert.equal(retained.path, documentC, 'cancelled/blocked open keeps the same document');
  assert.ok(retained.source === combinedC || retained.draft === nativeParagraphC ||
    (retained.native === nativeParagraphC && retained.dirty), 'native input remains in the shared source, retained draft, or dirty editable text');
  const firstCombinedCounts = await counts();
  const firstCombinedEvents = await main.evaluate(`__ux6b.events.slice(${combinedEventStart})`);
  assert.equal(firstCombinedEvents[0]?.title, '还有未提交的输入', 'local reader input is authorized first');
  assert.ok(firstCombinedCounts.open === combinedCounts.open || firstCombinedCounts.open === combinedCounts.open + 1, 'first attempt opens at most one picker');
  if (firstCombinedCounts.open > combinedCounts.open) {
    assert.deepEqual(firstCombinedEvents.map(event => event.kind === 'message' ? event.title : event.kind),
      ['还有未提交的输入', '正文尚未保存', 'open'], 'save authorization precedes the cancelled picker');
  }
  const firstCombinedDisk = await documentState(documentC);
  assert.deepEqual(firstCombinedDisk.slice(1), beforeCombined.slice(1), 'combined departure never writes annotation/canvas files');
  if (firstCombinedCounts.source === combinedCounts.source) {
    assert.deepEqual(firstCombinedDisk, beforeCombined, 'blocked local departure does not save source without source confirmation');
  } else {
    assert.equal(firstCombinedCounts.source, combinedCounts.source + 1, 'at most one explicit source save confirmation');
    const disk = await readFile(documentC, 'utf8');
    assert.ok([contentC, sourceOnlyC, combinedC].includes(disk), 'only an explicitly authorized source candidate can be persisted');
  }

  if (retained.source !== combinedC && retained.draft !== nativeParagraphC) {
    // A still-native dirty block must remain guarded on another real leave.
    await choices(0, 2); const nativeRetryCounts = await counts();
    await ctrl('o'); await waitCount('local', nativeRetryCounts.local + 1); await frame();
    assert.equal((await counts()).open, nativeRetryCounts.open, 'cancelling the second local confirmation cannot open the picker');
    retained = await retainedInput();
    assert.ok(retained.source === combinedC || retained.draft === nativeParagraphC ||
      (retained.native === nativeParagraphC && retained.dirty), 'second leave preserves native input again');
  }
  if (retained.source !== combinedC && retained.draft !== nativeParagraphC) {
    // Leave cancellation may keep the native block focused. An ordinary user
    // click now commits that retained block before an explicit save retry.
    await click('[aria-label="文档状态"]');
    await poll(async () => {
      const current = await retainedInput();
      return current.source === combinedC || current.draft === nativeParagraphC;
    }, 'explicit native blur applies the input or retains an exact recoverable draft');
    retained = await retainedInput();
    await escape();
  }
  if (retained.source !== combinedC) {
    // If blur conservatively retained an unapplied draft, the user can transfer
    // that exact retained text into source through the visible editing route.
    assert.equal(retained.draft, nativeParagraphC, 'unapplied native text is recoverable exactly');
    await click('[data-reader-continue-source]'); await editor(); await editorFocused(); await frame();
    await click('[data-source-editor] .cm-content, [data-editor-textarea]'); await ctrl('a');
    await wait('__sourceControl().selectionStart===0 && __sourceControl().selectionEnd===__sourceControl().value.length', 'real source select all for retained input');
    const recovered = retained.source.replace('原生段落。', retained.draft);
    assert.equal(recovered, combinedC);
    await pasteSource(recovered); await dirty(true);
    assert.equal(await sourceText(), combinedC, 'retained native draft is explicitly merged through source input');
    await click('[aria-label="关闭阅读编辑提示"]');
  }
  assert.equal(await sourceText(), combinedC, 'both source and native edits remain in the shared source');
  const beforeRetryCounts = await counts();
  const needsRetry = beforeRetryCounts.open === combinedCounts.open || await readFile(documentC, 'utf8') !== combinedC;
  if (needsRetry) {
    await choices(0, 1); await openTarget(documentB, true);
    await ctrl('o'); await waitCount('open', beforeRetryCounts.open + 1);
  }
  await unlocked();
  assert.equal(await readFile(documentC, 'utf8'), combinedC, 'explicit save ultimately persists both edits exactly');
  assert.equal(await sourceText(), combinedC, 'picker cancellation keeps the complete edited source');
  assert.equal((await retainedInput()).path, documentC);
  assert.deepEqual((await documentState(documentC)).slice(1), [null, null], 'combined source save never creates empty sidecars');
  assert.deepEqual(await snapshot(), afterFirstOpen, 'combined boundary leaves every earlier document untouched');
  const completedCombined = await documentState(documentC);
  await main.evaluate('__ux6b.localPromptDelayMs=0;void 0');
  await ctrl('w'); await start();
  assert.deepEqual(await documentState(documentC), completedCombined, 'closing after the cancelled picker adds no writes');
  await screenshot('start-after-close');
  const prompts = await main.evaluate('__ux6b.prompts');
  assert.ok(prompts.some(prompt => prompt.title === '正文尚未保存'));
  assert.ok(prompts.some(prompt => prompt.title === '还有未提交的输入'));
  assert.equal(prompts.some(prompt => prompt.title === 'Markdown 尚未保存'), false, 'document flow uses new source confirmation');
  passed = true;
  console.log(JSON.stringify({ status: 'passed', firstSaveCancel: true, retryOpenAfterConflict: true, bomCrlf: true,
    localDraftGuards: true, savedNoteEditGuards: true, sourceAndViewSaves: true, closeKeepsWindow: true,
    narrowMenuWidths: [420, 800], threeFileNoWriteAssertions: true, combinedNativeReaderInput: true,
    recoveryModalBlocksDocumentShortcuts: ['start', 'opened document'] }));
} catch (error) {
  if (page) await screenshot('failure').catch(() => {});
  console.error(`UX6B fixtures retained for inspection: ${workspace}`);
  throw error;
} finally {
  if (main && originalClipboardText !== undefined) {
    await main.evaluate(`process.mainModule.require('electron').clipboard.writeText(${JSON.stringify(originalClipboardText)})`).catch(error => {
      console.error('Unable to restore original clipboard text:', error.message);
    });
  }
  for (const client of clients) client.close();
  if (child?.exitCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  if (passed) {
    assert.ok(path.resolve(workspace).startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary fixture cleanup stays under temp');
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
