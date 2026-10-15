import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-ux3-'));
const fixture = path.join(workspace, '工作笔记.md');
const content = '# 阅读笔记\r\n\r\n已有批注对应的原文。\r\n\r\n准备修改的句子。\r\n\r\n重复引文。\r\n\r\n重复引文。\r\n\r\n跨**强调**和[链接](https://example.com)的内容。\r\n\r\n```text\r\n代码中的原文\r\n```\r\n';
await writeFile(fixture, '\ufeff' + content);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const port = 15200 + Math.floor(Math.random() * 100);
const child = spawn(path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'),
  [`--inspect=${port + 200}`, `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(workspace, 'user-data')}`],
  { cwd: root, stdio: 'ignore', windowsHide: true });
const clients = [];
async function connect(port, type) {
  let page;
  for (let i = 0; i < 150; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === type); } catch {}
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(page, `endpoint ${type}`);
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const pending = new Map(); let nextId = 1;
  socket.addEventListener('message', (event) => {
    const result = JSON.parse(event.data); const request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id); result.error ? request.reject(Error(JSON.stringify(result.error))) : request.resolve(result.result);
  });
  const client = {
    send(method, params = {}) { return new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); },
  };
  clients.push(client); return client;
}
let page;
async function wait(expression, label) {
  for (let i = 0; i < 150; i++) {
    if (await page.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error(`${label}: ${await page.evaluate('document.body.innerText.slice(0,1800)')}`);
}
async function click(selector) {
  const point = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e || e.disabled || !e.getClientRects().length) return null; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
  assert.ok(point, `visible enabled ${selector}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}
async function screenshot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(qa, `ux3-${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function select(selector) {
  await page.send('Page.bringToFront');
  await page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'center'}); e.focus(); const r=document.createRange(); r.selectNodeContents(e); const s=getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); })()`);
  await wait(`Boolean(document.querySelector('[data-selection-capability]')) && document.querySelector('.selection-quote')?.title===document.querySelector(${JSON.stringify(selector)}).textContent`, 'selection capability');
}
async function escape() {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}

async function metrics(width, height) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function snapshot() {
  return Promise.all([fixture, fixture+'.annotations.yaml', fixture+'.mermarkd.json'].map(async file => {
    try { return { content: await readFile(file,'utf8'), mtime: (await stat(file)).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
}
async function visible(selector) { return page.evaluate('Boolean(document.querySelector('+JSON.stringify(selector)+')?.getClientRects().length)'); }
async function assertLayout() {
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'no page overflow');
  assert.equal(await page.evaluate('[...document.querySelectorAll(".topbar button")].filter(e=>e.getClientRects().length).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})'),true,'all topbar controls fit');
}
async function dirty(value) {
  await wait(`document.querySelector('.app-shell').dataset.dirty===${JSON.stringify(String(value))}`, 'dirty=' + value);
}
async function editParagraph(selector, text) {
  await select(selector);
  await page.send('Input.insertText', {text});
  await page.evaluate('document.activeElement.blur()');
  await dirty(true);
  await wait(`document.querySelector(${JSON.stringify(selector)})?.textContent===${JSON.stringify(text)}`, 'reader buffer');
}
async function compose(selector, text) {
  await select(selector); await click('.add-note-button');
  await wait('Boolean(document.querySelector("#new-note-body")) && !document.querySelector("#new-note-body").disabled', 'composer ready');
  if (text) { await click('#new-note-body'); await page.send('Input.insertText',{text}); }
}
async function saveNote(count) {
  await wait('!document.querySelector(".note-composer button[type=submit]").disabled', 'annotation write ready');
  await click('.note-composer button[type=submit]');
  await wait(`!document.querySelector('#new-note-body') && document.querySelectorAll('.note-card').length===${count}`, 'note saved');
}
try {
  page = await connect(port, 'page'); const main = await connect(port + 200, 'node');
  await wait('Boolean(document.querySelector("[data-start-open]"))','start');
  await main.evaluate('process.mainModule.require("electron").dialog.showOpenDialog = async () => ({canceled:false,filePaths:['+JSON.stringify(fixture)+']})');
  await metrics(1200,800); await click('[data-start-open]');
  await wait('Boolean(document.querySelector("p[data-reader-editable]"))','reader ready');
  await click('[data-mode="cards"]');
  await wait('Boolean(document.querySelector(".react-flow__node"))','canvas ready');
  await wait('!document.querySelector("[data-canvas-save]").disabled','canvas save ready');
  await click('[data-canvas-save]');
  await wait('document.querySelector("[data-canvas-status]").textContent.includes("已保存")','seed canvas');
  await click('[data-mode="reader"]');
  await compose('.markdown-body > p:nth-of-type(1)','已有批注，正文未保存时也能参考。');
  await saveNote(1);
  const seeded=await snapshot(); assert.ok(seeded.every(Boolean));
  console.log('UX3: seeded all three files');

  const second='.markdown-body > p:nth-of-type(2)';
  const revised='修改后的中文与 emoji 😀。';
  await editParagraph(second,revised);
  assert.equal(await visible('[data-annotation-reference]'),true);
  assert.equal(await page.evaluate('document.querySelector(".note-body").textContent'),'已有批注，正文未保存时也能参考。');
  assert.equal(await page.evaluate('[...document.querySelectorAll(".note-card button")].every(e=>e.disabled)'),true);
  assert.equal(await page.evaluate('[...CSS.highlights.keys()].some(k=>k.startsWith("mermarkd-"))'),false);
  assert.deepEqual(await snapshot(),seeded,'dirty edit does not write any document file');
  await screenshot('reference-only');
  await compose(second,'针对保存后原文的新批注。');
  await dirty(false);
  const saved=await snapshot();
  assert.equal(saved[0].content,'\ufeff'+content.replace('准备修改的句子。',revised));
  assert.equal(await page.evaluate('document.querySelectorAll(".note-card").length'),1,'saving source does not submit annotation');
  assert.equal(saved[2].content,seeded[2].content,'saving prose preserves canvas');
  await saveNote(2);
  const annotated=await snapshot();
  assert.deepEqual(annotated[0],saved[0],'note writes YAML only');
  assert.deepEqual(annotated[2],saved[2]);
  assert.ok(annotated[1].content.includes(revised));
  await click('[data-mode="editor"]'); await click('[data-editor-undo]'); await dirty(true);
  await click('[data-mode="reader"]');
  assert.equal(await visible('[data-annotation-reference]'),true);
  await click('[data-mode="editor"]'); await click('[data-editor-redo]'); await dirty(false);
  await click('[data-mode="reader"]');
  assert.deepEqual(await snapshot(),annotated,'undo, redo and mode changes preserve all saved bytes and mtimes');
  console.log('UX3: dirty reference, save continuation, annotation and undo/redo passed');

  // Drafts survive mode changes. Identical quotes elsewhere cannot silently inherit an old intent.
  await compose('.markdown-body > p:nth-of-type(3)','需要保留的草稿');
  await click('[data-mode="editor"]'); await click('[data-mode="reader"]');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'需要保留的草稿');
  await editParagraph(second,revised+'再次编辑。');
  await wait('Boolean(document.querySelector("[data-note-reselect]"))','old intent is unresolved');
  assert.equal(await page.evaluate('document.querySelector(".note-composer button[type=submit]").disabled'),true);
  await click('[data-note-reselect]');
  await select('.markdown-body > p:nth-of-type(4)'); await click('.add-note-button');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'需要保留的草稿');
  assert.equal(await visible('[data-note-save-source]'),true,'reselection is explicit and source still dirty');
  await click('[data-note-save-source]'); await dirty(false); await saveNote(3);
  const yaml=await readFile(fixture+'.annotations.yaml','utf8');
  const { parse } = await import('yaml'); const notes=parse(yaml).annotations;
  const relocated=notes.find(n=>n.note==='需要保留的草稿');
  assert.ok(relocated,'draft saved');
  // The second identical quote was selected deliberately; verify byte coordinates, including BOM/CRLF.
  const bytes=await readFile(fixture); const expected=bytes.lastIndexOf(Buffer.from('重复引文。'));
  assert.equal(relocated.anchor.startByte,expected);
  assert.equal(relocated.anchor.endByte,expected+Buffer.byteLength('重复引文。'));
  console.log('UX3: cross-mode draft and explicit duplicate-quote reselection passed');

  const beforeRestrictions=await snapshot();
  // Composition event ordering is a logic regression, not real OS IME acceptance.
  const beforeComposition=await page.evaluate('document.querySelector("[data-editor-textarea]").value');
  await page.evaluate(`(() => {
    const e=document.querySelector(${JSON.stringify(second)}); e.focus();
    e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    e.textContent+='组合文字'; e.dispatchEvent(new Event('input',{bubbles:true}));
    e.blur();
  })()`);
  assert.equal(await page.evaluate('document.querySelector("[data-editor-textarea]").value'),beforeComposition,'blur during composition defers commit');
  await page.evaluate(`document.querySelector(${JSON.stringify(second)}).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`);
  await wait('document.querySelector("[data-editor-textarea]").value.includes("组合文字")','composition commits after end');
  await click('[data-mode="editor"]'); await click('[data-editor-undo]'); await dirty(false);
  await click('[data-mode="reader"]');
  await select(second);
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await wait('Boolean(document.querySelector("[data-reader-continue-source]"))','Enter restriction');
  await click('[data-reader-continue-source]');
  await wait('document.querySelector(".app-shell").dataset.activeMode==="editor"','source continuation');
  assert.ok(await page.evaluate('document.querySelector("[data-editor-textarea]").selectionStart>0'));
  await click('[data-mode="reader"]'); await select(second);
  await main.evaluate('process.mainModule.require("electron").clipboard.writeText("多行输入\\n第二行😀")');
  await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
  await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
  await wait('Boolean(document.querySelector("textarea[aria-label=未应用的输入]"))','paste recovery');
  assert.equal(await page.evaluate('document.querySelector("textarea[aria-label=未应用的输入]").value'),'多行输入\n第二行😀');
  await dirty(false);
  assert.deepEqual(await snapshot(),beforeRestrictions,'restricted editing does not write files');
  for (const [width,height] of [[1200,800],[800,700],[420,800]]) {
    await metrics(width,height);
    if (await page.evaluate('Boolean(document.querySelector("[aria-modal=true]"))')) await escape();
    await assertLayout();
    assert.equal(await page.evaluate('(()=>{const r=document.querySelector(".reader-edit-feedback").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()'),true);
    await screenshot('restricted-'+width);
  }
  await metrics(1200,800);
  await click('.reader-feedback-actions button:last-child');
  // Replacing multiple Markdown leaves must retain the attempted input without changing source.
  await select('.markdown-body > p:nth-of-type(5)');
  await page.send('Input.insertText',{text:'跨格式替换的未应用文字'});
  await page.evaluate('document.activeElement.blur()');
  await wait('document.querySelector("textarea[aria-label=未应用的输入]")?.value==="跨格式替换的未应用文字"','cross-leaf recovery');
  await dirty(false);
  assert.equal(await page.evaluate('document.querySelector(".markdown-body > p:nth-of-type(5)").textContent'),'跨强调和链接的内容。');
  assert.deepEqual(await snapshot(),beforeRestrictions);
  await click('.reader-feedback-actions button:last-child');
  const codePoint=await page.evaluate('(()=>{const e=document.querySelector(".markdown-body pre");e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:r.x+30,y:r.y+20}})()');
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...codePoint,button:'left',clickCount:2});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...codePoint,button:'left',clickCount:2});
  await wait('document.querySelector(".reader-edit-feedback")?.textContent.includes("暂不能直接编辑")','code block source entry');
  await click('[data-reader-continue-source]');
  await wait('document.querySelector(".app-shell").dataset.activeMode==="editor"','code source');
  await wait('(()=>{const e=document.querySelector("[data-editor-textarea]");return e.value.slice(e.selectionStart,e.selectionStart+7)==="```text"})()','code source caret');
  await click('[data-mode="reader"]'); await click('.reader-feedback-actions button:last-child');
  assert.deepEqual(await snapshot(),beforeRestrictions);
  console.log('UX3: restricted Enter, paste, cross-leaf editing and responsive layout passed');

  // Make a pending draft first, then force a real external conflict before source save.
  await compose(second,'冲突时也不能丢失的批注草稿');
  await editParagraph(second,'尚未保存的本地修改。');
  await click('[data-note-reselect]'); await select(second); await click('.add-note-button');
  const external=Buffer.concat([await readFile(fixture),Buffer.from('\r\n外部程序增加内容。\r\n')]);
  await writeFile(fixture,external);
  const beforeConflict=await snapshot();
  await click('[data-note-save-source]');
  await wait('document.querySelector(".note-continuation-error")?.textContent.includes("尚未保存")','save conflict feedback');
  assert.equal(await page.evaluate('document.querySelector("#new-note-body").value'),'冲突时也不能丢失的批注草稿');
  assert.equal(await page.evaluate('document.querySelector(".note-composer button[type=submit]").disabled'),true);
  await dirty(true);
  assert.deepEqual(await snapshot(),beforeConflict,'external bytes and both sidecars survive failed save');
  for (const [width,height] of [[1200,800],[800,700],[420,800]]) {
    await metrics(width,height);
    if (!await visible('#annotation-sidebar')) await click('[data-workspace-right-toggle]');
    await assertLayout(); await screenshot('conflict-'+width);
  }
  console.log('UX3 packaged E2E passed: save conflicts retain drafts and preserve all three files.');
} finally {
  for (const client of clients) client.close();
  if (child.exitCode === null) { try { execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); } catch {} }
}
