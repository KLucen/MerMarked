import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeAnnotationAnchor, sectionHintForSelection } from '../../src/core/annotation-anchor.ts';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');
const ACTIVE_SELECTION_TEXT = '中英混排：Full-width ＡＢＣ，emoji 😀，组合字 e\u0301';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function recordAnchor(content, sha256, exact) {
  const characterStart = content.indexOf(exact);
  assert.notEqual(characterStart, -1, `fixture selection is missing: ${exact}`);
  const startByte = Buffer.byteLength(content.slice(0, characterStart), 'utf8');
  const selection = {
    startByte,
    endByte: startByte + Buffer.byteLength(exact, 'utf8'),
    sourceExact: exact,
    displayQuote: exact,
  };
  return makeAnnotationAnchor(content, 0, sha256, selection, sectionHintForSelection(content, 0, selection));
}

function buildDocument() {
  const paragraphs = (label, count) => Array.from(
    { length: count },
    (_, index) => `${label} ${index + 1}：用于产生稳定的阅读滚动距离，同时覆盖中文、English 与全角标点。`,
  ).join('\n\n');
  const wideCode = `const viewportContainmentProbe = "${'0123456789abcdef'.repeat(18)}";`;

  return [
    '# 起始章节',
    '',
    '中英混排：Full-width ＡＢＣ，emoji 😀，组合字 e\u0301，都应完整保留。',
    '',
    '[前往最终章节](#final-chapter)',
    '',
    '**加粗内容**和普通正文。',
    '',
    '> 一段引用。',
    '',
    '- 列表一',
    '- 列表二',
    '',
    '| 中文一 | EnglishTwo | 中文三 | EnglishFour | 中文五 | EnglishSix | 中文七 | EnglishEight | 中文九 | EnglishTen | 中文十一 | EnglishTwelve |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 全角Ａ | value-2 | 全角Ｃ | value-4 | 全角Ｅ | value-6 | 全角Ｇ | value-8 | 全角Ｉ | value-10 | 全角Ｋ | value-12 |',
    '',
    '```txt',
    wideCode,
    '```',
    '',
    paragraphs('起始填充', 18),
    '',
    '# 手动滚动章节',
    '',
    '手动滚动应该把这一章标记为当前位置。',
    '',
    paragraphs('滚动填充', 18),
    '',
    '## 目录目标',
    '',
    '点击目录后当前章节应稳定在这里。',
    '',
    paragraphs('目录填充', 18),
    '',
    '# Final Chapter',
    '',
    '文内链接应该同步目录的当前位置。',
    '',
    paragraphs('末尾填充', 18),
    '',
  ].join('\n');
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
      // Electron publishes the endpoint after the browser process is ready.
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
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}.`);
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

async function waitForAnimationFrames(cdp, count = 3) {
  await cdp.evaluate(`new Promise((resolve) => {
    let remaining = ${count};
    const next = () => { remaining -= 1; remaining > 0 ? requestAnimationFrame(next) : resolve(true); };
    requestAnimationFrame(next);
  })`);
}

async function selectText(cdp, exact, rootSelector = '.markdown-body') {
  const encoded = JSON.stringify(exact);
  const encodedRoot = JSON.stringify(rootSelector);
  return cdp.evaluate(`(() => {
    const root = document.querySelector(${encodedRoot});
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.data.indexOf(${encoded});
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + ${exact.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString() === ${encoded};
    }
    return false;
  })()`);
}

async function clickTocEntry(cdp, title) {
  const encoded = JSON.stringify(title);
  const clicked = await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.toc-link'))
      .find((candidate) => candidate.textContent?.trim() === ${encoded});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `TOC entry not found: ${title}`);
}

function currentChapterExpression(title) {
  return `document.querySelector('.toc-link[aria-current="location"]')?.textContent?.trim() === ${JSON.stringify(title)}`;
}

async function readOverflowState(cdp) {
  return cdp.evaluate(`(() => {
    const root = document.documentElement;
    const table = document.querySelector('.markdown-body .table-scroll');
    const pre = document.querySelector('.markdown-body pre');
    const viewportWidth = root.clientWidth;
    return {
      innerWidth,
      innerHeight,
      viewportWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      table: table ? {
        clientWidth: table.clientWidth,
        scrollWidth: table.scrollWidth,
        overflowX: getComputedStyle(table).overflowX,
      } : null,
      pre: pre ? {
        clientWidth: pre.clientWidth,
        scrollWidth: pre.scrollWidth,
        overflowX: getComputedStyle(pre).overflowX,
      } : null,
    };
  })()`);
}

function assertContainedOverflow(state, expectedWidth, label) {
  assert.ok(Math.abs(state.innerWidth - expectedWidth) <= 1,
    `${label}: expected ${expectedWidth} CSS px, received ${state.innerWidth}`);
  assert.ok(state.rootScrollWidth <= state.viewportWidth + 1,
    `${label}: document root overflowed by ${state.rootScrollWidth - state.viewportWidth}px`);
  assert.ok(state.bodyScrollWidth <= state.viewportWidth + 1,
    `${label}: body overflowed by ${state.bodyScrollWidth - state.viewportWidth}px`);
  for (const [name, measurement] of [['table', state.table], ['pre', state.pre]]) {
    assert.ok(measurement, `${label}: ${name} fixture is missing`);
    assert.ok(['auto', 'scroll'].includes(measurement.overflowX),
      `${label}: ${name} does not own horizontal scrolling`);
    assert.ok(measurement.scrollWidth > measurement.clientWidth + 1,
      `${label}: ${name} fixture did not produce local overflow`);
  }
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a7-1-e2e-'));
const appData = path.join(workspace, 'appdata');
const localAppData = path.join(workspace, 'localappdata');
const documentPath = path.join(workspace, 'a7-1-reading.md');
const sidecarPath = `${documentPath}.annotations.yaml`;
const canvasPath = `${documentPath}.mermarkd.json`;
const secondDocumentPath = path.join(workspace, 'a7-1-second.md');
const documentContent = buildDocument();
const documentBytes = Buffer.from(documentContent, 'utf8');
const secondDocumentBytes = Buffer.from('# 第二份文档\n\n切换文档必须清除旧选区。\n', 'utf8');
const sidecarText = serializeAnnotationYaml({
  schemaVersion: 1,
  source: {
    sha256: digest(documentBytes),
    encoding: 'utf-8',
    coordinateSystem: 'utf8-byte',
  },
  tags: [],
  annotations: [{
    id: 'highlight-overlap',
    kind: 'highlight',
    color: 'amber',
    anchor: recordAnchor(documentContent, digest(documentBytes), ACTIVE_SELECTION_TEXT),
    createdAt: '2026-09-24T08:00:00Z',
    updatedAt: '2026-09-24T08:00:00Z',
  }],
});
const canvasBytes = Buffer.from('{"schemaVersion":1,"sentinel":"passive-reading-must-not-write"}\n', 'utf8');

await mkdir(appData, { recursive: true });
await mkdir(localAppData, { recursive: true });
await writeFile(documentPath, documentBytes);
await writeFile(sidecarPath, sidecarText, 'utf8');
await writeFile(canvasPath, canvasBytes);
await writeFile(secondDocumentPath, secondDocumentBytes);

const initialDigests = {
  markdown: digest(await readFile(documentPath)),
  annotations: digest(await readFile(sidecarPath)),
  canvas: digest(await readFile(canvasPath)),
};
const port = 9700 + Math.floor(Math.random() * 200);
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData },
  stdio: 'ignore',
});
let cdp;

try {
  const page = await waitForEndpoint(port);
  cdp = await connect(page);
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer startup');
  await dropFile(cdp, documentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-1-reading.md' &&
    Boolean(document.querySelector('.markdown-body')) &&
    document.querySelector('.annotation-summary')?.textContent.includes('1 条记录')`, 'reader document');

  const modeState = await cdp.evaluate(`(() => {
    const nav = document.querySelector('.modebar');
    const buttons = Array.from(nav?.querySelectorAll('button') ?? []);
    return {
      navLabel: nav?.getAttribute('aria-label'),
      usesTabRoles: Boolean(nav?.matches('[role="tablist"]') || nav?.querySelector('[role="tab"]')),
      buttons: buttons.map((button) => ({
        text: button.textContent?.replace(/\\s+/g, ' ').trim(),
        ariaLabel: button.getAttribute('aria-label'),
        current: button.getAttribute('aria-current'),
        disabled: button.disabled,
      })),
    };
  })()`);
  assert.equal(modeState.navLabel, '视图模式');
  assert.equal(modeState.usesTabRoles, false);
  assert.equal(modeState.buttons.length, 3);
  assert.deepEqual(modeState.buttons.map((item) => item.current), ['page', null, null]);
  assert.deepEqual(modeState.buttons.map((item) => item.disabled), [false, true, true]);
  assert.match(`${modeState.buttons[1].text} ${modeState.buttons[1].ariaLabel}`, /编辑模式.*尚未开放/);
  assert.match(`${modeState.buttons[2].text} ${modeState.buttons[2].ariaLabel}`, /卡片模式.*尚未开放/);

  const readingContract = await cdp.evaluate(`(() => {
    const article = document.querySelector('.markdown-body');
    const bodyText = document.body.innerText;
    const tocLabels = Array.from(document.querySelectorAll('.toc-link')).map((item) => item.textContent?.trim() ?? '');
    return {
      semanticElements: Boolean(article?.querySelector('h1, h2')) && Boolean(article?.querySelector('strong')) &&
        Boolean(article?.querySelector('a[href="#final-chapter"]')) && Boolean(article?.querySelector('blockquote')) &&
        Boolean(article?.querySelector('ul')) && Boolean(article?.querySelector('.table-scroll table')) &&
        Boolean(article?.querySelector('pre code')),
      leakedSourceDiagnostics: /UTF-8|sourceExact|字节范围|原文片段/.test(bodyText),
      leakedHeadingDepth: Boolean(document.querySelector('.toc-depth')) || tocLabels.some((value) => /^H[1-6](?:\\s|$)/.test(value)),
      leakedSidecarPath: bodyText.includes(${JSON.stringify(sidecarPath)}) ||
        Boolean(document.querySelector('.annotation-summary [title$=".annotations.yaml"], .annotation-location')),
    };
  })()`);
  assert.equal(readingContract.semanticElements, true);
  assert.equal(readingContract.leakedSourceDiagnostics, false);
  assert.equal(readingContract.leakedHeadingDepth, false);
  assert.equal(readingContract.leakedSidecarPath, false);

  await waitFor(cdp, `(() => {
    window.resizeTo(800, 600);
    return innerWidth >= 780 && innerWidth <= 800 && innerHeight >= 520 &&
      outerWidth >= 790 && outerWidth <= 830 && outerHeight >= 590 && outerHeight <= 630;
  })()`, '800 by 600 application window');
  await waitFor(cdp, `!document.querySelector('.annotation-sidebar')`, 'narrow layout sidebar closing');
  const actualWindowState = await cdp.evaluate(`(() => {
    const root = document.documentElement;
    return {
      innerWidth, innerHeight, outerWidth, outerHeight,
      viewportWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
    };
  })()`);
  assert.ok(actualWindowState.outerWidth >= 790 && actualWindowState.outerWidth <= 830);
  assert.ok(actualWindowState.outerHeight >= 590 && actualWindowState.outerHeight <= 630);
  assert.ok(actualWindowState.rootScrollWidth <= actualWindowState.viewportWidth + 1);
  assert.ok(actualWindowState.bodyScrollWidth <= actualWindowState.viewportWidth + 1);

  let twoHundredPercentState;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 400,
    height: 300,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 800,
    screenHeight: 600,
  });
  try {
    await waitFor(cdp, `innerWidth === 400`, 'equivalent 200 percent viewport');
    await waitForAnimationFrames(cdp);
    twoHundredPercentState = await readOverflowState(cdp);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await waitForAnimationFrames(cdp);
  }
  assertContainedOverflow(twoHundredPercentState, 400, 'equivalent 200 percent viewport');

  let compactViewportState;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: 320,
    screenHeight: 600,
  });
  try {
    await waitFor(cdp, `innerWidth === 320`, '320 CSS px viewport');
    await waitForAnimationFrames(cdp);
    compactViewportState = await readOverflowState(cdp);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await waitForAnimationFrames(cdp);
  }
  assertContainedOverflow(compactViewportState, 320, '320 CSS px viewport');

  await clickTocEntry(cdp, '起始章节');
  await waitFor(cdp, currentChapterExpression('起始章节'), 'current chapter before forced colors');
  let forcedColorsState;
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'forced-colors', value: 'active' }],
  });
  try {
    await waitFor(cdp, `matchMedia('(forced-colors: active)').matches`, 'forced colors media');
    forcedColorsState = await cdp.evaluate(`(() => {
      const mode = document.querySelector('.mode-tab[aria-current="page"]');
      const chapter = document.querySelector('.toc-link[aria-current="location"]');
      const modeStyle = mode && getComputedStyle(mode);
      const chapterStyle = chapter && getComputedStyle(chapter);
      return {
        mediaMatches: matchMedia('(forced-colors: active)').matches,
        modeBorderStyle: modeStyle?.borderBottomStyle,
        modeBorderWidth: parseFloat(modeStyle?.borderBottomWidth ?? '0'),
        chapterBorderStyle: chapterStyle?.borderLeftStyle,
        chapterBorderWidth: parseFloat(chapterStyle?.borderLeftWidth ?? '0'),
        chapterOutlineStyle: chapterStyle?.outlineStyle,
        chapterOutlineWidth: parseFloat(chapterStyle?.outlineWidth ?? '0'),
      };
    })()`);
  } finally {
    await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    await waitForAnimationFrames(cdp);
  }
  assert.equal(forcedColorsState.mediaMatches, true);
  assert.notEqual(forcedColorsState.modeBorderStyle, 'none');
  assert.ok(forcedColorsState.modeBorderWidth > 0, 'current mode needs a forced-colors border cue');
  assert.ok(
    (forcedColorsState.chapterBorderStyle !== 'none' && forcedColorsState.chapterBorderWidth > 0) ||
      (forcedColorsState.chapterOutlineStyle !== 'none' && forcedColorsState.chapterOutlineWidth > 0),
    'current chapter needs a forced-colors border or outline cue',
  );
  await cdp.evaluate(`(() => {
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.documentElement.style.scrollBehavior = previous;
    window.dispatchEvent(new Event('scroll'));
  })()`);

  assert.equal(await selectText(cdp, '章节目录', '.toc'), true);
  await waitForAnimationFrames(cdp);
  assert.deepEqual(await cdp.evaluate(`({
    toolbar: Boolean(document.querySelector('.selection-toolbar')),
    feedback: Boolean(document.querySelector('.selection-feedback')),
  })`), { toolbar: false, feedback: false });
  assert.equal(await selectText(cdp, '选择正文文字后', '.selection-hint'), true);
  await waitForAnimationFrames(cdp);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.selection-toolbar, .selection-feedback'))`), false,
    'selection in reader tools must not create a body annotation target');

  const selectionText = ACTIVE_SELECTION_TEXT;
  assert.equal(await selectText(cdp, selectionText), true);
  await waitFor(cdp, `Boolean(document.querySelector('.selection-toolbar'))`,
    'selection toolbar before moving selection outside the article', 2_000);
  const overlapPriorities = await cdp.evaluate(`(() => {
    const active = CSS.highlights?.get('mermarkd-active-selection');
    const stored = CSS.highlights?.get('mermarkd-amber');
    return { active: active?.priority ?? -1, stored: stored?.priority ?? -1 };
  })()`);
  assert.ok(overlapPriorities.stored >= 0, 'stored overlapping highlight was not painted');
  assert.ok(overlapPriorities.active > overlapPriorities.stored,
    'active selection highlight must remain visible above stored annotations');
  assert.equal(await selectText(cdp, '章节目录', '.toc'), true);
  await waitFor(cdp, `!document.querySelector('.selection-toolbar') && !document.querySelector('.selection-feedback')`,
    'outside selection clearing the cached body selection');
  const staleSelectionState = await cdp.evaluate(`({
    selectedText: window.getSelection()?.toString(),
    bodyActionCount: document.querySelectorAll('.selection-toolbar .highlight-choice, .selection-toolbar .add-note-button').length,
    noteComposer: Boolean(document.querySelector('.note-composer')),
  })`);
  assert.equal(staleSelectionState.selectedText, '章节目录');
  assert.equal(staleSelectionState.bodyActionCount, 0);
  assert.equal(staleSelectionState.noteComposer, false);
  assert.deepEqual({
    markdown: digest(await readFile(documentPath)),
    annotations: digest(await readFile(sidecarPath)),
    canvas: digest(await readFile(canvasPath)),
  }, initialDigests, 'moving selection into the TOC must not reuse or persist the old body selection');

  const selectionStart = Date.now();
  assert.equal(await selectText(cdp, selectionText), true);
  await waitFor(cdp, `Boolean(document.querySelector('.selection-toolbar'))`, 'selection action toolbar', 2_000);
  const selectionDelayMs = Date.now() - selectionStart;
  assert.ok(selectionDelayMs <= 250, `selection feedback took ${selectionDelayMs} ms`);
  const toolbarState = await cdp.evaluate(`(() => {
    const toolbar = document.querySelector('.selection-toolbar');
    const action = toolbar?.querySelector('button:not(:disabled)');
    action?.focus();
    return {
      role: toolbar?.getAttribute('role'),
      hasHighlight: Array.from(toolbar?.querySelectorAll('button') ?? []).some((item) => item.getAttribute('aria-label')?.includes('高亮')),
      hasNote: Array.from(toolbar?.querySelectorAll('button') ?? []).some((item) => item.textContent?.includes('添加批注')),
      focusedAction: Boolean(action && document.activeElement === action),
      selectedText: window.getSelection()?.toString(),
    };
  })()`);
  assert.equal(toolbarState.role, 'toolbar');
  assert.equal(toolbarState.hasHighlight, true);
  assert.equal(toolbarState.hasNote, true);
  assert.equal(toolbarState.focusedAction, true);
  assert.equal(toolbarState.selectedText, selectionText);
  await waitForAnimationFrames(cdp, 2);
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.selection-toolbar'))`), true);

  await cdp.evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }))`);
  await waitFor(cdp, `!document.querySelector('.selection-toolbar') && !document.querySelector('.selection-feedback')`,
    'Escape clearing the ordinary reader selection');

  const unsupportedSelected = await cdp.evaluate(`(() => {
    const blocks = Array.from(document.querySelectorAll('.markdown-body [data-source-block-start]'))
      .filter((item) => item.textContent?.trim());
    if (blocks.length < 2 || !blocks[0].firstChild || !blocks[1].firstChild) return false;
    const range = document.createRange();
    range.setStart(blocks[0].firstChild, 0);
    range.setEnd(blocks[1].firstChild, Math.min(2, blocks[1].firstChild.textContent.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return !selection.isCollapsed;
  })()`);
  assert.equal(unsupportedSelected, true);
  await waitFor(cdp, `Boolean(document.querySelector('.selection-feedback'))`, 'unsupported selection reason');
  assert.match(await cdp.evaluate(`document.querySelector('.selection-feedback')?.textContent ?? ''`), /同一.*段落|暂不能批注/);
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await waitFor(cdp, `!document.querySelector('.selection-feedback')`, 'Escape clearing unsupported selection');

  await cdp.evaluate(`(() => {
    const target = document.getElementById('手动滚动章节');
    if (!target) throw new Error('manual-scroll heading missing');
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo({ top: window.scrollY + target.getBoundingClientRect().top - 130, behavior: 'auto' });
    document.documentElement.style.scrollBehavior = previous;
    window.dispatchEvent(new Event('scroll'));
  })()`);
  await waitFor(cdp, currentChapterExpression('手动滚动章节'), 'manual scroll chapter');

  await clickTocEntry(cdp, '目录目标');
  await waitFor(cdp, currentChapterExpression('目录目标'), 'TOC target chapter');
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(await cdp.evaluate(currentChapterExpression('目录目标')), true,
    'TOC current chapter should remain stable after smooth scrolling');

  const clickedInternalLink = await cdp.evaluate(`(() => {
    const link = document.querySelector('.markdown-body a[href="#final-chapter"]');
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  })()`);
  assert.equal(clickedInternalLink, true);
  await waitFor(cdp, currentChapterExpression('Final Chapter'), 'internal-link target chapter');
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal(await cdp.evaluate(currentChapterExpression('Final Chapter')), true,
    'internal-link current chapter should remain stable after smooth scrolling');

  const disabledModeClick = await cdp.evaluate(`(() => {
    const disabled = Array.from(document.querySelectorAll('.modebar button:disabled'));
    disabled.forEach((button) => button.click());
    return {
      readerCurrent: document.querySelector('.modebar [aria-current="page"]')?.textContent?.trim(),
      articlePresent: Boolean(document.querySelector('.markdown-body')),
    };
  })()`);
  assert.match(disabledModeClick.readerCurrent, /阅读模式/);
  assert.equal(disabledModeClick.articlePresent, true);

  assert.deepEqual({
    markdown: digest(await readFile(documentPath)),
    annotations: digest(await readFile(sidecarPath)),
    canvas: digest(await readFile(canvasPath)),
  }, initialDigests, 'passive reading actions must not mutate Markdown or companion files');

  await cdp.evaluate(`(() => {
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.documentElement.style.scrollBehavior = previous;
    window.dispatchEvent(new Event('scroll'));
  })()`);
  assert.equal(await selectText(cdp, selectionText), true);
  await waitFor(cdp, `Boolean(document.querySelector('.selection-toolbar'))`, 'selection before document switch');
  await dropFile(cdp, secondDocumentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-1-second.md' &&
    document.querySelector('.markdown-body')?.textContent.includes('切换文档必须清除旧选区')`, 'second document');
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector('.selection-toolbar, .selection-feedback'))`), false);
  assert.equal(digest(await readFile(secondDocumentPath)), digest(secondDocumentBytes));
  const workspaceEntries = await readdir(workspace);
  assert.equal(workspaceEntries.includes('a7-1-second.md.annotations.yaml'), false);
  assert.equal(workspaceEntries.includes('a7-1-second.md.mermarkd.json'), false);
  assert.deepEqual({
    markdown: digest(await readFile(documentPath)),
    annotations: digest(await readFile(sidecarPath)),
    canvas: digest(await readFile(canvasPath)),
  }, initialDigests, 'selection and document switching must not mutate the previous document files');

  console.log(JSON.stringify({
    status: 'passed',
    selectionDelayMs,
    modeButtons: modeState.buttons.length,
    chaptersChecked: 3,
    passiveFilesUnchanged: 3,
    window: {
      outerWidth: actualWindowState.outerWidth,
      outerHeight: actualWindowState.outerHeight,
    },
    emulatedCssWidths: [twoHundredPercentState.innerWidth, compactViewportState.innerWidth],
    forcedColors: forcedColorsState.mediaMatches,
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
  await rm(workspace, { recursive: true, force: true });
}
