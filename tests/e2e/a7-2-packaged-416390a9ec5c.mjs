import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeAnnotationYaml } from '../../src/core/annotations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');
const SEARCH_QUERY = 'findprobe';
const SEARCH_LIMIT_QUERY = 'a72-limit-probe';
const ALLOWED_HTML_TEXT = '允许 HTML 文字';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function buildSecondDocument() {
  return [
    '---',
    'title: "FindProbe hidden metadata"',
    'samples: "$$ [[frontmatter-only]] :::note"',
    '---',
    '',
    '# 第二份文档',
    '',
    '切换文档后，正文查找状态必须清除。',
    '',
    '```txt',
    '$$',
    '[[code-only]]',
    ':::note',
    '```',
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

async function waitForAnimationFrames(cdp, count = 3) {
  await cdp.evaluate(`new Promise((resolve) => {
    let remaining = ${count};
    const next = () => { remaining -= 1; remaining > 0 ? requestAnimationFrame(next) : resolve(true); };
    requestAnimationFrame(next);
  })`);
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

async function selectText(cdp, exact, rootSelector = '.markdown-body') {
  return cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSelector)});
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = node.data.indexOf(${JSON.stringify(exact)});
      if (offset < 0) continue;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + ${exact.length});
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return selection.toString() === ${JSON.stringify(exact)};
    }
    return false;
  })()`);
}

async function openSearch(cdp) {
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true,
  }))`);
  await waitFor(cdp, `Boolean(document.querySelector('#reader-search-input')) &&
    document.activeElement === document.querySelector('#reader-search-input')`, 'focused body search');
}

async function setSearchQuery(cdp, query) {
  const changed = await cdp.evaluate(`(() => {
    const input = document.querySelector('#reader-search-input');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.equal(changed, true, 'body-search input is missing');
}

async function clickSearchButton(cdp, label) {
  const clicked = await cdp.evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)});
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `search control is missing: ${label}`);
}

async function viewportState(cdp) {
  return cdp.evaluate(`(() => {
    const root = document.documentElement;
    const search = document.querySelector('.reader-searchbar');
    const rect = search?.getBoundingClientRect();
    return {
      innerWidth, innerHeight, outerWidth, outerHeight,
      viewportWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      searchLeft: rect?.left ?? null,
      searchRight: rect?.right ?? null,
      searchScrollWidth: search?.scrollWidth ?? null,
      searchClientWidth: search?.clientWidth ?? null,
    };
  })()`);
}

function assertNoRootOverflow(state, expectedWidth, label) {
  assert.ok(Math.abs(state.innerWidth - expectedWidth) <= 1,
    `${label}: expected ${expectedWidth} CSS px, received ${state.innerWidth}`);
  assert.ok(state.rootScrollWidth <= state.viewportWidth + 1,
    `${label}: document root overflowed by ${state.rootScrollWidth - state.viewportWidth}px`);
  assert.ok(state.bodyScrollWidth <= state.viewportWidth + 1,
    `${label}: body overflowed by ${state.bodyScrollWidth - state.viewportWidth}px`);
  assert.ok(state.searchLeft >= -1 && state.searchRight <= state.viewportWidth + 1,
    `${label}: the open search bar is outside the viewport`);
  assert.ok(state.searchScrollWidth <= state.searchClientWidth + 1,
    `${label}: the search bar owns unexpected horizontal overflow`);
}

if (process.platform !== 'win32') throw new Error('This packaged UI check currently targets Windows.');

const sentinelRequests = [];
const sentinel = createServer((request, response) => {
  sentinelRequests.push(request.url ?? '/');
  response.writeHead(204).end();
});
await new Promise((resolve, reject) => {
  sentinel.once('error', reject);
  sentinel.listen(0, '127.0.0.1', resolve);
});
const sentinelAddress = sentinel.address();
assert.ok(sentinelAddress && typeof sentinelAddress === 'object');
const sentinelOrigin = `http://127.0.0.1:${sentinelAddress.port}`;

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-a7-2-e2e-'));
const appData = path.join(workspace, 'appdata');
const localAppData = path.join(workspace, 'localappdata');
const documentPath = path.join(workspace, 'a7-2-semantics.md');
const sidecarPath = `${documentPath}.annotations.yaml`;
const canvasPath = `${documentPath}.mermarkd.json`;
const secondDocumentPath = path.join(workspace, 'a7-2-second.md');
const fixtureTemplate = await readFile(path.join(root, 'tests', 'fixtures', 'reader', 'reading-dialect.md'), 'utf8');
const documentContent = `${fixtureTemplate.replaceAll('__MERMRKD_SENTINEL_ORIGIN__', sentinelOrigin)}\n\n${
  Array.from({ length: 1001 }, () => SEARCH_LIMIT_QUERY).join(' ')
}\n`;
const documentBytes = Buffer.from(documentContent, 'utf8');
const secondDocumentBytes = Buffer.from(buildSecondDocument(), 'utf8');
const sidecarText = serializeAnnotationYaml({
  schemaVersion: 1,
  source: {
    sha256: digest(documentBytes),
    encoding: 'utf-8',
    coordinateSystem: 'utf8-byte',
  },
  tags: [],
  annotations: [],
});
const canvasBytes = Buffer.from('{"schemaVersion":1,"sentinel":"a7-2-passive-reading-must-not-write"}\n', 'utf8');

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
const port = 9900 + Math.floor(Math.random() * 90);
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
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-2-semantics.md' &&
    Boolean(document.querySelector('.markdown-body')) &&
    document.querySelector('.annotation-summary')?.textContent.includes('0 条记录')`, 'semantic reader document');

  const semanticState = await cdp.evaluate(`(() => {
    const article = document.querySelector('.markdown-body');
    const text = article?.textContent ?? '';
    const task = article?.querySelector('input[type="checkbox"]');
    const automaticLink = Array.from(article?.querySelectorAll('a') ?? [])
      .find((link) => link.textContent?.includes('https://example.org/path'));
    return {
      commonMark: Boolean(article?.querySelector('h1')) && Boolean(article?.querySelector('em')) &&
        Boolean(article?.querySelector('strong')) && Boolean(article?.querySelector('blockquote')) &&
        Boolean(article?.querySelector('ol')) && Boolean(article?.querySelector('ul')) &&
        Boolean(article?.querySelector('p code')) && Boolean(article?.querySelector('pre code')) &&
        Boolean(article?.querySelector('hr')) && Boolean(article?.querySelector('a[href="https://example.com"]')),
      extendedCommonMark: Array.from(article?.querySelectorAll('h2') ?? [])
        .some((heading) => heading.textContent === 'Setext 二级标题') &&
        Boolean(article?.querySelector('li ul')) && Boolean(article?.querySelector('br')) &&
        (article?.querySelectorAll('pre code').length ?? 0) >= 2 &&
        Array.from(article?.querySelectorAll('a') ?? [])
          .some((link) => link.textContent === '引用链接' && link.getAttribute('href') === 'https://example.net/reference') &&
        Boolean(article?.querySelector('.image-placeholder')?.textContent?.includes('引用图片替代文字')) &&
        text.includes('*星号*') && text.includes('实体 & 保留') && text.includes('indentedCodeProbe'),
      gfm: Boolean(article?.querySelector('del')) && Boolean(article?.querySelector('.table-scroll table')) &&
        Boolean(task?.checked && task.disabled) && automaticLink?.getAttribute('href') === 'https://example.org/path',
      frontmatterHidden: !text.includes('frontmatter must stay hidden') && !text.includes('extensionSamples:'),
      sourceMarkersHidden: !text.includes('[dialect-reference]:') && !text.includes('| ---') &&
        !text.includes(String.fromCharCode(96).repeat(3) + 'txt') && !text.includes('# FindProbe'),
      rawHeadingReadable: text.includes('允许的 HTML 标题'),
      rawHeadingInToc: Array.from(document.querySelectorAll('.toc-link'))
        .some((item) => item.textContent?.includes('允许的 HTML 标题')),
    };
  })()`);
  assert.deepEqual(semanticState, {
    commonMark: true,
    extendedCommonMark: true,
    gfm: true,
    frontmatterHidden: true,
    sourceMarkersHidden: true,
    rawHeadingReadable: true,
    rawHeadingInToc: false,
  });

  const htmlPolicyState = await cdp.evaluate(`(() => {
    const article = document.querySelector('.markdown-body');
    const mark = article?.querySelector('mark');
    const cleanedLink = Array.from(article?.querySelectorAll('a') ?? [])
      .find((link) => link.textContent?.includes('已净化链接'));
    const reservedSpan = Array.from(article?.querySelectorAll('span') ?? [])
      .find((span) => span.textContent === 'A72_RESERVED_PLACEHOLDER_CLASS_VISIBLE');
    const text = article?.textContent ?? '';
    const resourceUrls = performance.getEntriesByType('resource').map((entry) => entry.name);
    return {
      allowedText: mark?.textContent ?? null,
      allowedTitle: mark?.getAttribute('title'),
      strippedAttributes: mark && !mark.hasAttribute('id') && !mark.hasAttribute('class') &&
        !mark.hasAttribute('style') && !mark.hasAttribute('onclick') && !mark.hasAttribute('aria-label'),
      strippedJavascriptHref: Boolean(cleanedLink) && !cleanedLink.hasAttribute('href'),
      reservedPlaceholderAttributesStripped: Boolean(reservedSpan) &&
        !reservedSpan.classList.contains('html-placeholder') && !reservedSpan.hasAttribute('role'),
      dangerousElements: article?.querySelectorAll('audio, video, source, iframe, object, script, style, svg').length ?? -1,
      dangerousSecretsLeaked: /A72_DANGER_(?:VIDEO|IFRAME|OBJECT|SCRIPT|STYLE|SVG)_/.test(text),
      fosteredTableTextLeaked: /A72_FOSTER_(?:VIDEO|AUDIO)_(?:TABLE|CELL)_TEXT_/.test(text),
      fosteredImageAltLeaked: /A72_FOSTER_(?:VIDEO|AUDIO)_IMG_ALT_/.test(text),
      fosteredImageElements: Array.from(article?.querySelectorAll('img') ?? [])
        .filter((image) => image.getAttribute('src')?.startsWith(${JSON.stringify(sentinelOrigin)})).length,
      fosteredImagePlaceholders: Array.from(article?.querySelectorAll('[role="img"]') ?? [])
        .filter((image) => /A72_FOSTER_(?:VIDEO|AUDIO)_IMG_ALT_/.test(image.getAttribute('aria-label') ?? '')).length,
      unsupportedSecretLeaked: /A72_UNSUPPORTED_(?:SECTION|CELL|IMG_ALT)_/.test(text),
      dangerousPlaceholders: Array.from(article?.querySelectorAll('.html-placeholder') ?? [])
        .filter((item) => item.textContent?.includes('不安全的 HTML 内容已隐藏')).length,
      unsupportedPlaceholder: Array.from(article?.querySelectorAll('.html-placeholder') ?? [])
        .some((item) => item.textContent?.includes('section')),
      scriptExecuted: Boolean(globalThis.__MER_RAW_SCRIPT__ || globalThis.__MER_RAW_EVENT__ || globalThis.__MER_BAD_LINK__),
      sentinelResources: resourceUrls.filter((url) => url.startsWith(${JSON.stringify(sentinelOrigin)})),
    };
  })()`);
  assert.equal(htmlPolicyState.allowedText, `FINDPROBE ${ALLOWED_HTML_TEXT}`);
  assert.equal(htmlPolicyState.allowedTitle, '保留标题');
  assert.equal(htmlPolicyState.strippedAttributes, true);
  assert.equal(htmlPolicyState.strippedJavascriptHref, true);
  assert.equal(htmlPolicyState.reservedPlaceholderAttributesStripped, true);
  assert.equal(htmlPolicyState.dangerousElements, 0);
  assert.equal(htmlPolicyState.dangerousSecretsLeaked, false);
  assert.equal(htmlPolicyState.fosteredTableTextLeaked, false,
    'HTML5 table foster parenting must not expose text from dangerous media containers');
  assert.equal(htmlPolicyState.fosteredImageAltLeaked, false,
    'images nested in dangerous media containers must not become visible placeholders');
  assert.equal(htmlPolicyState.fosteredImageElements, 0,
    'images nested in dangerous media containers must not survive as DOM images');
  assert.equal(htmlPolicyState.fosteredImagePlaceholders, 0,
    'images nested in dangerous media containers must not survive through the image fallback UI');
  assert.equal(htmlPolicyState.unsupportedSecretLeaked, false);
  assert.ok(htmlPolicyState.dangerousPlaceholders >= 5, 'dangerous HTML containers need one safe placeholder each');
  assert.equal(htmlPolicyState.unsupportedPlaceholder, true);
  assert.equal(htmlPolicyState.scriptExecuted, false);
  assert.deepEqual(htmlPolicyState.sentinelResources, []);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(sentinelRequests, [], 'raw HTML must not issue network requests before sanitization');

  const dialectNotice = await cdp.evaluate(`document.querySelector('.reading-dialect-notice')?.textContent ?? ''`);
  assert.match(dialectNotice, /部分扩展按普通文字显示/);
  assert.match(dialectNotice, /数学公式/);
  assert.match(dialectNotice, /Wiki Link/);
  assert.match(dialectNotice, /自定义指令/);

  assert.equal(await selectText(cdp, ALLOWED_HTML_TEXT), true);
  await waitFor(cdp, `Boolean(document.querySelector('.selection-feedback'))`, 'raw HTML selection feedback');
  const rawSelectionState = await cdp.evaluate(`({
    feedback: document.querySelector('.selection-feedback')?.textContent ?? '',
    toolbar: Boolean(document.querySelector('.selection-toolbar')),
  })`);
  assert.match(rawSelectionState.feedback, /暂不能批注|复杂格式/);
  assert.equal(rawSelectionState.toolbar, false);
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor(cdp, `!document.querySelector('.selection-feedback, .selection-toolbar')`, 'raw HTML selection clearing');

  await openSearch(cdp);
  await setSearchQuery(cdp, SEARCH_QUERY);
  await waitFor(cdp, `/\\d+\\s*\\/\\s*\\d+|没有匹配/.test(document.querySelector('.reader-searchbar output')?.textContent ?? '')`,
    'visible-body search results');
  const initialSearchState = await cdp.evaluate(`(() => {
    const registry = CSS.highlights;
    const all = registry?.get('mermarkd-search-match');
    const current = registry?.get('mermarkd-current-search-match');
    return {
      output: document.querySelector('.reader-searchbar output')?.textContent,
      currentBlocks: document.querySelectorAll('[data-search-current="true"]').length,
      allSize: all?.size ?? -1,
      currentSize: current?.size ?? -1,
      allPriority: all?.priority ?? -1,
      currentPriority: current?.priority ?? -1,
      nativeSelection: window.getSelection()?.toString() ?? '',
      annotationUi: Boolean(document.querySelector('.selection-toolbar, .selection-feedback')),
    };
  })()`);
  assert.match(initialSearchState.output, /1\s*\/\s*3/);
  assert.equal(initialSearchState.currentBlocks, 1);
  assert.equal(initialSearchState.allSize, 2);
  assert.equal(initialSearchState.currentSize, 1);
  assert.ok(initialSearchState.currentPriority > initialSearchState.allPriority);
  assert.equal(initialSearchState.nativeSelection, '');
  assert.equal(initialSearchState.annotationUi, false);

  await clickSearchButton(cdp, '下一个匹配');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('2 / 3')`, 'second match');
  await clickSearchButton(cdp, '下一个匹配');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('3 / 3')`, 'third match');
  await clickSearchButton(cdp, '下一个匹配');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('1 / 3')`, 'wrapped next match');
  await clickSearchButton(cdp, '上一个匹配');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('3 / 3')`, 'wrapped previous match');

  await setSearchQuery(cdp, 'crossinlineprobe');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('1 / 1')`,
    'search across inline formatting');
  await setSearchQuery(cdp, 'nocrossboundary');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent === '没有匹配'`,
    'search block at a visible line break');
  await setSearchQuery(cdp, 'a72_reserved_placeholder_class_visible');
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('1 / 1')`,
    'raw HTML cannot impersonate an excluded placeholder');

  await setSearchQuery(cdp, SEARCH_LIMIT_QUERY);
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('1 / 1000') &&
    document.querySelector('.reader-searchbar output')?.textContent?.includes('仅显示前 1000 项')`, 'search result limit');
  const limitedSearchState = await cdp.evaluate(`({
    output: document.querySelector('.reader-searchbar output')?.textContent ?? '',
    otherMatches: CSS.highlights?.get('mermarkd-search-match')?.size ?? -1,
    currentMatches: CSS.highlights?.get('mermarkd-current-search-match')?.size ?? -1,
  })`);
  assert.match(limitedSearchState.output, /1\s*\/\s*1000.*前 1000 项/);
  assert.equal(limitedSearchState.otherMatches, 999);
  assert.equal(limitedSearchState.currentMatches, 1);
  await setSearchQuery(cdp, SEARCH_QUERY);
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('1 / 3')`,
    'visible search restored after limit check');

  await waitFor(cdp, `(() => {
    window.resizeTo(800, 600);
    return innerWidth >= 780 && innerWidth <= 800 && innerHeight >= 520 &&
      outerWidth >= 790 && outerWidth <= 830 && outerHeight >= 590 && outerHeight <= 630;
  })()`, '800 by 600 application window');
  await waitForAnimationFrames(cdp);
  const normalViewport = await viewportState(cdp);
  assert.ok(normalViewport.rootScrollWidth <= normalViewport.viewportWidth + 1);
  assert.ok(normalViewport.bodyScrollWidth <= normalViewport.viewportWidth + 1);

  let compactViewport;
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
    compactViewport = await viewportState(cdp);
  } finally {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await waitForAnimationFrames(cdp);
  }
  assertNoRootOverflow(compactViewport, 320, 'open search at 320 CSS px');

  let forcedColorsState;
  await cdp.send('Emulation.setEmulatedMedia', {
    media: '',
    features: [{ name: 'forced-colors', value: 'active' }],
  });
  try {
    await waitFor(cdp, `matchMedia('(forced-colors: active)').matches`, 'forced colors media');
    forcedColorsState = await cdp.evaluate(`(() => {
      const current = document.querySelector('[data-search-current="true"]');
      const placeholder = document.querySelector('.html-placeholder');
      const dialect = document.querySelector('.reading-dialect-notice');
      const currentStyle = current && getComputedStyle(current);
      const placeholderStyle = placeholder && getComputedStyle(placeholder);
      const dialectStyle = dialect && getComputedStyle(dialect);
      return {
        mediaMatches: matchMedia('(forced-colors: active)').matches,
        currentOutlineStyle: currentStyle?.outlineStyle,
        currentOutlineWidth: parseFloat(currentStyle?.outlineWidth ?? '0'),
        placeholderBorderStyle: placeholderStyle?.borderStyle,
        placeholderBorderWidth: parseFloat(placeholderStyle?.borderWidth ?? '0'),
        dialectBorderStyle: dialectStyle?.borderLeftStyle,
        dialectBorderWidth: parseFloat(dialectStyle?.borderLeftWidth ?? '0'),
      };
    })()`);
  } finally {
    await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    await waitForAnimationFrames(cdp);
  }
  assert.equal(forcedColorsState.mediaMatches, true);
  assert.notEqual(forcedColorsState.currentOutlineStyle, 'none');
  assert.ok(forcedColorsState.currentOutlineWidth > 0, 'current search result needs a non-color cue');
  assert.notEqual(forcedColorsState.placeholderBorderStyle, 'none');
  assert.ok(forcedColorsState.placeholderBorderWidth > 0, 'HTML placeholders need a forced-colors boundary');
  assert.notEqual(forcedColorsState.dialectBorderStyle, 'none');
  assert.ok(forcedColorsState.dialectBorderWidth > 0, 'dialect notice needs a forced-colors boundary');

  await cdp.evaluate(`document.querySelector('#reader-search-input')?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, cancelable: true,
  }))`);
  await waitFor(cdp, `!document.querySelector('.reader-searchbar') &&
    document.activeElement === document.querySelector('.search-open-button')`, 'search close and trigger focus');
  const closedSearchState = await cdp.evaluate(`({
    allPaint: Boolean(CSS.highlights?.get('mermarkd-search-match')),
    currentPaint: Boolean(CSS.highlights?.get('mermarkd-current-search-match')),
    currentBlocks: document.querySelectorAll('[data-search-current]').length,
  })`);
  assert.deepEqual(closedSearchState, { allPaint: false, currentPaint: false, currentBlocks: 0 });

  await openSearch(cdp);
  await setSearchQuery(cdp, SEARCH_QUERY);
  await waitFor(cdp, `document.querySelector('.reader-searchbar output')?.textContent?.includes('/ 3')`,
    'search state before document switch');
  await cdp.evaluate(`(() => {
    const previous = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    window.scrollTo({ top: 0, behavior: 'auto' });
    document.documentElement.style.scrollBehavior = previous;
  })()`);
  await dropFile(cdp, secondDocumentPath);
  await waitFor(cdp, `document.querySelector('.document-name')?.textContent === 'a7-2-second.md' &&
    document.querySelector('.markdown-body')?.textContent.includes('切换文档后')`, 'second document');
  const switchedState = await cdp.evaluate(`({
    searchOpen: Boolean(document.querySelector('.reader-searchbar')),
    expanded: document.querySelector('.search-open-button')?.getAttribute('aria-expanded'),
    allPaint: Boolean(CSS.highlights?.get('mermarkd-search-match')),
    currentPaint: Boolean(CSS.highlights?.get('mermarkd-current-search-match')),
    currentBlocks: document.querySelectorAll('[data-search-current]').length,
    dialectNotice: Boolean(document.querySelector('.reading-dialect-notice')),
  })`);
  assert.deepEqual(switchedState, {
    searchOpen: false,
    expanded: 'false',
    allPaint: false,
    currentPaint: false,
    currentBlocks: 0,
    dialectNotice: false,
  });

  assert.deepEqual({
    markdown: digest(await readFile(documentPath)),
    annotations: digest(await readFile(sidecarPath)),
    canvas: digest(await readFile(canvasPath)),
  }, initialDigests, 'A7.2 reader interactions must not mutate Markdown or companion files');
  assert.equal(digest(await readFile(secondDocumentPath)), digest(secondDocumentBytes));
  const workspaceEntries = await readdir(workspace);
  assert.equal(workspaceEntries.includes('a7-2-second.md.annotations.yaml'), false);
  assert.equal(workspaceEntries.includes('a7-2-second.md.mermarkd.json'), false);
  assert.deepEqual(sentinelRequests, [], 'dangerous HTML must remain network inert for the full session');

  console.log(JSON.stringify({
    status: 'passed',
    commonMarkAndGfm: true,
    dangerousHtmlRequests: sentinelRequests.length,
    visibleSearchMatches: 3,
    passiveFilesUnchanged: 4,
    window: { outerWidth: normalViewport.outerWidth, outerHeight: normalViewport.outerHeight },
    emulatedCssWidths: [compactViewport.innerWidth],
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
  await new Promise((resolve) => sentinel.close(resolve));
}
