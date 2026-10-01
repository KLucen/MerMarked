import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor, sectionHintForSelection } from '../../src/core/annotation-anchor.ts';
import { parseAnnotationYaml, serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');
const encoder = new TextEncoder();

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceBytes(content) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
}

function recordAnchor(content, sha256, exact, displayQuote = exact) {
  const bytes = sourceBytes(content);
  const startByte = bytes.indexOf(Buffer.from(exact, 'utf8'));
  assert.notEqual(startByte, -1, `fixture selection is missing: ${exact}`);
  const selection = {
    startByte,
    endByte: startByte + Buffer.byteLength(exact),
    sourceExact: exact,
    displayQuote,
  };
  return makeAnnotationAnchor(
    content,
    3,
    sha256,
    selection,
    sectionHintForSelection(content, 3, selection),
  );
}

function buildFixture() {
  const moveLeft = '移动左文'.repeat(20);
  const moveRight = '移动右文'.repeat(20);
  const copyLeft = '复制左文'.repeat(20);
  const copyRight = '复制右文'.repeat(20);
  const deleteLeft = '删除左文'.repeat(20);
  const deleteRight = '删除右文'.repeat(20);
  const manualLeft = '人工左文'.repeat(20);
  const manualRight = '人工右文'.repeat(20);
  const stableOneLeft = '甲组左文'.repeat(20);
  const stableOneRight = '甲组右文'.repeat(20);
  const stableTwoLeft = '乙组左文'.repeat(20);
  const stableTwoRight = '乙组右文'.repeat(20);
  const movedLine = `${moveLeft}移动结论 😀${moveRight}`;
  const copiedLine = `${copyLeft}复制目标${copyRight}`;
  const deletedLine = `${deleteLeft}删除目标${deleteRight}`;
  const manualOldLine = `${manualLeft}旧关键词${manualRight}`;
  const manualNewLine = `${manualLeft}新关键词${manualRight}`;
  const stableOneLine = `${stableOneLeft}稳定甲${stableOneRight}`;
  const stableTwoLine = `${stableTwoLeft}稳定乙${stableTwoRight}`;

  const oldContent = [
    '# 研究笔记',
    '这是 A6 打包验收文档。',
    '## 原章节',
    movedLine,
    '## 重复案例',
    copiedLine,
    '## 删除案例',
    deletedLine,
    '## 人工修复',
    manualOldLine,
    '## 同名',
    stableOneLine,
    '## 同名',
    stableTwoLine,
    '## 新章节',
    '移动后的内容将出现在这里。',
    '',
  ].join('\r\n');
  const currentContent = [
    '# 研究笔记',
    '外部编辑器新增的说明。',
    '这是 A6 打包验收文档。',
    '## 原章节',
    '移动结论已经移走。',
    '## 重复案例',
    copiedLine,
    '另一个副本也包含复制目标。',
    '## 删除案例',
    '删除目标已经从原位置移除。',
    '## 人工修复',
    manualNewLine,
    '## 同名',
    stableOneLine,
    '## 同名',
    stableTwoLine,
    '## 新章节',
    movedLine,
    '',
  ].join('\r\n');
  const oldBytes = sourceBytes(oldContent);
  const oldSha256 = digest(oldBytes);
  const createdAt = '2026-09-20T08:00:00Z';
  const sidecar = {
    schemaVersion: 1,
    source: { sha256: oldSha256, encoding: 'utf-8', coordinateSystem: 'utf8-byte' },
    tags: [
      { id: 'tag-question', name: '疑问' },
      { id: 'tag-risk', name: '风险' },
    ],
    annotations: [
      {
        id: 'note-moved', kind: 'note', color: 'amber',
        anchor: recordAnchor(oldContent, oldSha256, '移动结论 😀'),
        note: '整段移动后仍应安全定位。', tagId: 'tag-question', createdAt, updatedAt: createdAt,
      },
      {
        id: 'highlight-copied', kind: 'highlight', color: 'blue',
        anchor: recordAnchor(oldContent, oldSha256, '复制目标'), createdAt, updatedAt: createdAt,
      },
      {
        id: 'note-deleted', kind: 'note',
        anchor: recordAnchor(oldContent, oldSha256, '删除目标'),
        note: '删除后必须保留这条便签。', createdAt, updatedAt: createdAt,
      },
      {
        id: 'note-manual', kind: 'note', color: 'sage',
        anchor: recordAnchor(oldContent, oldSha256, '旧关键词'),
        note: '改写后由用户重新选择。', tagId: 'tag-question', createdAt, updatedAt: createdAt,
      },
      {
        id: 'note-same-one', kind: 'note',
        anchor: recordAnchor(oldContent, oldSha256, '稳定甲'),
        note: '第一个同名章节。', tagId: 'tag-risk', createdAt, updatedAt: createdAt,
      },
      {
        id: 'highlight-same-two', kind: 'highlight', color: 'rose',
        anchor: recordAnchor(oldContent, oldSha256, '稳定乙'), createdAt, updatedAt: createdAt,
      },
    ],
  };
  return {
    oldBytes,
    currentBytes: sourceBytes(currentContent),
    currentContent,
    oldSha256,
    sidecar,
  };
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForEndpoint(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = tabs.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      // The remote debugging endpoint is created after Electron starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the packaged Electron page.');
}

async function connect(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function waitFor(cdp, expression, label, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function clickExact(cdp, text, selector = 'button') {
  const encoded = JSON.stringify(text);
  const encodedSelector = JSON.stringify(selector);
  await cdp.evaluate(`(() => {
    const target = Array.from(document.querySelectorAll(${encodedSelector}))
      .find((element) => element.textContent?.trim() === ${encoded});
    if (!(target instanceof HTMLElement)) throw new Error('Button not found: ' + ${encoded});
    target.click();
  })()`);
}

async function dropFile(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => {
    const element = document.querySelector('[data-markdown-drop-target]');
    if (!element) throw new Error('Drop target missing.');
    const bounds = element.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x: rect.x, y: rect.y, data });
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: rect.x, y: rect.y, data });
}

async function selectVisibleText(cdp, exact) {
  const encoded = JSON.stringify(exact);
  const selected = await cdp.evaluate(`(() => {
    const article = document.querySelector('.markdown-body');
    if (!article) return false;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.data.indexOf(${encoded});
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + ${exact.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString() === ${encoded};
    }
    return false;
  })()`);
  assert.equal(selected, true, `could not select ${exact}`);
}

function readClipboard() {
  return execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw',
  ], { encoding: 'utf8' });
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a6-e2e-'));
const appData = path.join(workspace, 'appdata');
const localAppData = path.join(workspace, 'localappdata');
const documentPath = path.join(workspace, 'a6-relocation.md');
const sidecarPath = `${documentPath}.annotations.yaml`;
const clipboardBackupPath = path.join(workspace, 'clipboard-backup.txt');
const fixture = buildFixture();
await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
await writeFile(documentPath, fixture.oldBytes);
await writeFile(sidecarPath, serializeAnnotationYaml(fixture.sidecar), 'utf8');
await writeFile(clipboardBackupPath, readClipboard(), 'utf8');

const port = 9400 + Math.floor(Math.random() * 300);
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
  stdio: 'ignore',
});
let cdp;
let conflictDraftPath;

try {
  const page = await waitForEndpoint(port);
  cdp = await connect(page);
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer startup');
  await dropFile(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a6-relocation.md' &&
    document.querySelector('.annotation-summary')?.textContent.includes('6 条记录')`, 'initial annotation load');
  assert.match(await cdp.evaluate(`document.querySelector('.annotation-summary').textContent`), /0 条待定位|6 条记录/);

  await writeFile(documentPath, fixture.currentBytes);
  const firstExternalHash = digest(fixture.currentBytes);
  await clickExact(cdp, '重新检查');
  await waitFor(cdp, `Array.from(document.querySelectorAll('button')).some((button) =>
    button.textContent.trim() === '重新载入原文')`, 'external source warning');
  await clickExact(cdp, '重新载入原文');
  await waitFor(cdp, `document.querySelector('.markdown-body')?.textContent.includes('新关键词') &&
    document.querySelector('.annotation-summary')?.textContent.includes('3 条可安全重定位')`, 'relocation review');
  assert.equal(digest(await readFile(documentPath)), firstExternalHash);

  await clickExact(cdp, '应用 3 条安全重定位');
  await waitFor(cdp, `document.querySelector('.annotation-summary')?.textContent.includes('3 条待定位') &&
    !document.querySelector('.annotation-summary')?.textContent.includes('可安全重定位')`, 'partial relocation save');

  const beganManual = await cdp.evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.note-card'))
      .find((item) => item.textContent.includes('旧关键词'));
    const button = card && Array.from(card.querySelectorAll('button'))
      .find((item) => item.textContent.trim() === '重新选择');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(beganManual, true);
  await waitFor(cdp, `Boolean(document.querySelector('.reattach-controls'))`, 'manual reattachment controls');
  await selectVisibleText(cdp, '新关键词');
  await clickExact(cdp, '确认所选新位置');
  await waitFor(cdp, `document.querySelector('.annotation-summary')?.textContent.includes('2 条待定位') &&
    Array.from(document.querySelectorAll('.note-card')).some((item) => item.textContent.includes('新关键词'))`,
  'manual reattachment save');

  const sidecarBeforeSummary = await readFile(sidecarPath);
  await clickExact(cdp, '复制摘要');
  await waitFor(cdp, `document.querySelector('.notice')?.textContent.includes('6 条')`, 'all summary copy');
  const allSummary = readClipboard();
  assert.match(allSummary, /^# MerMarkd 阅读摘要/m);
  assert.match(allSummary, /移动结论 😀/);
  assert.match(allSummary, /新关键词/);
  assert.match(allSummary, /## 待定位/);
  assert.ok(allSummary.indexOf('新关键词') < allSummary.indexOf('## 待定位'));
  assert.equal((allSummary.match(/研究笔记 \/ 同名/g) ?? []).length, 2);

  await cdp.evaluate(`(() => {
    const select = document.querySelector('.note-records-toolbar select');
    select.value = 'tag:tag-question';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(cdp, `document.querySelector('.note-records-toolbar select')?.value === 'tag:tag-question'`, 'tag filter');
  await clickExact(cdp, '复制摘要');
  await waitFor(cdp, `document.querySelector('.notice')?.textContent.includes('2 条')`, 'tagged summary copy');
  const taggedSummary = readClipboard();
  assert.match(taggedSummary, /移动结论 😀/);
  assert.match(taggedSummary, /新关键词/);
  assert.doesNotMatch(taggedSummary, /删除目标|复制目标|稳定甲|稳定乙/);
  assert.deepEqual(await readFile(sidecarPath), sidecarBeforeSummary);
  assert.equal(digest(await readFile(documentPath)), firstExternalHash);

  await waitFor(cdp, `(() => {
    window.resizeTo(800, 600);
    return matchMedia('(max-width: 1100px)').matches && innerWidth <= 800;
  })()`, 'narrow viewport');
  await waitFor(cdp, `!document.querySelector('.annotation-sidebar')`, 'narrow sidebar auto close');
  const narrowClosed = await cdp.evaluate(`({
    width: innerWidth,
    height: innerHeight,
    outerWidth,
    outerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    sidebar: Boolean(document.querySelector('.annotation-sidebar')),
  })`);
  assert.ok(narrowClosed.width >= 780 && narrowClosed.height >= 520);
  assert.ok(narrowClosed.outerWidth >= 800 && narrowClosed.outerHeight >= 590);
  assert.ok(narrowClosed.scrollWidth <= narrowClosed.width);
  assert.equal(narrowClosed.sidebar, false);
  const openedDrawer = await cdp.evaluate(`(() => {
    const button = document.querySelector('.annotation-panel-toggle');
    button.click();
    return true;
  })()`);
  assert.equal(openedDrawer, true);
  await waitFor(cdp, `Boolean(document.querySelector('.annotation-sidebar'))`, 'narrow annotation drawer');
  const drawerBounds = await cdp.evaluate(`(() => {
    const bounds = document.querySelector('.annotation-sidebar').getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, width: innerWidth };
  })()`);
  assert.ok(drawerBounds.left >= 0 && drawerBounds.right <= drawerBounds.width + 1);
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(cdp, `!document.querySelector('.annotation-sidebar')`, 'Escape closing the drawer');

  const secondCurrentBytes = sourceBytes(fixture.currentContent.replace(
    '# 研究笔记\r\n', '# 研究笔记\r\n第二次外部编辑。\r\n',
  ));
  await writeFile(documentPath, secondCurrentBytes);
  await clickExact(cdp, '重新检查');
  await waitFor(cdp, `Array.from(document.querySelectorAll('button')).some((button) =>
    button.textContent.trim() === '重新载入原文')`, 'second source warning');
  await clickExact(cdp, '重新载入原文');
  await waitFor(cdp, `document.querySelector('.annotation-summary')?.textContent.includes('4 条可安全重定位')`,
    'second relocation review');
  const externallyEdited = parseAnnotationYaml(await readFile(sidecarPath, 'utf8'));
  externallyEdited.tags = externallyEdited.tags.map((tag) => tag.id === 'tag-risk'
    ? { ...tag, name: '外部风险' }
    : tag);
  const externalSidecarText = serializeAnnotationYaml(externallyEdited);
  await writeFile(sidecarPath, externalSidecarText, 'utf8');
  await clickExact(cdp, '应用 4 条安全重定位');
  await waitFor(cdp, `document.querySelector('.notice')?.textContent.includes('待处理草稿')`,
    'sidecar conflict draft');
  assert.equal(await readFile(sidecarPath, 'utf8'), externalSidecarText);
  assert.equal(digest(await readFile(documentPath)), digest(secondCurrentBytes));
  const conflictNotice = await cdp.evaluate(`document.querySelector('.notice span')?.textContent ?? ''`);
  conflictDraftPath = conflictNotice.split('待处理草稿：')[1];
  assert.ok(conflictDraftPath, 'the conflict notice should expose the retained draft path');
  const draft = JSON.parse(await readFile(conflictDraftPath, 'utf8'));
  assert.equal(draft.documentPath, documentPath);
  assert.equal(parseAnnotationYaml(draft.text).source.sha256, digest(secondCurrentBytes));

  const finalModel = parseAnnotationYaml(externalSidecarText);
  assert.deepEqual(finalModel.annotations.map((item) => item.id), fixture.sidecar.annotations.map((item) => item.id));
  assert.equal(finalModel.annotations.find((item) => item.id === 'note-manual')?.anchor.sourceExact, '新关键词');
  assert.equal(finalModel.annotations.find((item) => item.id === 'note-manual')?.createdAt,
    fixture.sidecar.annotations.find((item) => item.id === 'note-manual')?.createdAt);
  assert.equal(finalModel.annotations.find((item) => item.id === 'note-deleted')?.note, '删除后必须保留这条便签。');

  console.log(JSON.stringify({
    status: 'passed',
    annotations: finalModel.annotations.length,
    unresolvedAfterManual: 2,
    retainedDrafts: 1,
    viewport: narrowClosed,
    markdownSha256: digest(secondCurrentBytes),
  }));
} finally {
  cdp?.close();
  if (child.pid) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill('SIGKILL');
    }
  }
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Set-Clipboard -Value ([IO.File]::ReadAllText($args[0]))',
      clipboardBackupPath,
    ], { stdio: 'ignore' });
  } catch {
    // Clipboard restoration is best effort and does not affect product verification.
  }
  if (conflictDraftPath) await rm(conflictDraftPath, { force: true });
  await rm(workspace, { recursive: true, force: true });
}
