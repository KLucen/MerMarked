import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXECUTABLE ?? path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');
const outputDirectory = process.env.MERMARKD_QA_OUTPUT ?? path.join(root, 'out', 'qa');

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
      message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  close() { this.socket.close(); }
}

async function findEndpoint(port, kind = 'page') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = tabs.find((item) => item.type === kind);
      if (page) return page;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${kind} on ${port}.`);
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const cdp = new Cdp(socket);
  await cdp.send('Runtime.enable');
  return cdp;
}

async function waitFor(cdp, expression, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression);
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function click(cdp, selector) {
  assert.equal(await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false;
    element.click(); return true;
  })()`), true, `enabled element missing: ${selector}`);
}

async function drop(cdp, filePath) {
  const rect = await cdp.evaluate(`(() => {
    document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 0);
    const target = document.querySelector('[data-markdown-drop-target]');
    const box = target.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data });
  }
}

async function waitForFile(filePath) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { if ((await stat(filePath)).size > 0) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function controlsFitViewport(cdp) {
  return cdp.evaluate(`(() => {
    const names = ['[data-mode="reader"]', '[data-mode="editor"]', '[data-mode="cards"]',
      '[data-editor-save]', '[data-canvas-save]', '[data-canvas-export="png"]', '[data-canvas-export="jpg"]', '[data-canvas-export="pdf"]'];
    return names.flatMap((selector) => [...document.querySelectorAll(selector)]).every((element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden') return true;
      return box.width > 0 && box.height > 0 && box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    });
  })()`);
}

async function controlGeometry(cdp) {
  return cdp.evaluate(`(() => {
    const names = ['[data-mode="reader"]', '[data-mode="editor"]', '[data-mode="cards"]',
      '[data-editor-save]', '[data-canvas-save]', '[data-canvas-export="png"]', '[data-canvas-export="jpg"]', '[data-canvas-export="pdf"]'];
    return names.flatMap((selector) => [...document.querySelectorAll(selector)].map((element) => {
      const box = element.getBoundingClientRect();
      return { selector, display: getComputedStyle(element).display, disabled: element.hasAttribute('disabled'), left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    }));
  })()`);
}

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-installed-qa-'));
const documentPath = path.join(workspace, 'installed-qa.md');
const content = '# Root\nRoot body\n## Child\nChild body\n# Second\nSecond body\n';
const hash = createHash('sha256').update(content).digest('hex');
await writeFile(documentPath, content, 'utf8');
await writeFile(`${documentPath}.annotations.yaml`, `schemaVersion: 1\nsource:\n  sha256: "${hash}"\n  encoding: utf-8\n  coordinateSystem: utf8-byte\ntags: []\nannotations: []\n`, 'utf8');
await mkdir(outputDirectory, { recursive: true });

// Cover the Windows scale factors used by the product acceptance plan,
// including the 200% setting common on high-density laptop displays.
const scales = [1, 1.25, 1.5, 2];
const results = [];
try {
  for (const scale of scales) {
    const label = String(scale).replace('.', '');
    const port = 15100 + Math.floor(Math.random() * 150);
    const inspectorPort = port + 400;
    const userData = path.join(workspace, `user-data-${label}`);
    const startedAt = performance.now();
    const child = spawn(executable, [`--force-device-scale-factor=${scale}`, `--inspect=${inspectorPort}`, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
    let cdp;
    let mainCdp;
    try {
      cdp = await connect(await findEndpoint(port));
      mainCdp = await connect(await findEndpoint(inspectorPort, 'node'));
      await waitFor(cdp, 'document.readyState === "complete"', 'renderer');
      const rendererReadyMs = Math.round(performance.now() - startedAt);
      await drop(cdp, documentPath);
      await waitFor(cdp, `document.querySelector('.file-name')?.textContent === 'installed-qa.md'`, 'document');
      const readerOpenedMs = Math.round(performance.now() - startedAt);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: scale, mobile: false });
      assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `root overflow at ${scale}`);
      await click(cdp, '[data-mode="editor"]');
      await waitFor(cdp, 'Boolean(document.querySelector("[data-editor-textarea]"))', 'editor');
      assert.equal(await controlsFitViewport(cdp), true, `editor controls clipped at ${scale}`);
      await click(cdp, '[data-mode="cards"]');
      await waitFor(cdp, 'document.querySelectorAll(".react-flow__node").length >= 3', 'cards');
      await waitFor(cdp, 'document.querySelector("[data-canvas-save]")?.disabled === false', 'canvas layout');
      const cardsReadyMs = Math.round(performance.now() - startedAt);
      const canvasControlsFit = await controlsFitViewport(cdp);
      assert.equal(canvasControlsFit, true, `canvas controls clipped at ${scale}: ${JSON.stringify(await controlGeometry(cdp))}`);
      const dpr = await cdp.evaluate('window.devicePixelRatio');
      assert.ok(Math.abs(dpr - scale) < 0.02, `device pixel ratio ${dpr} does not match ${scale}`);
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(outputDirectory, `dpi-${label}-installed.png`), Buffer.from(screenshot.data, 'base64'));
      let exported = null;
      if (scale === 1) {
        await click(cdp, '[data-canvas-save]');
        await waitFor(cdp, 'document.querySelector("[data-canvas-status]")?.textContent.includes("画布已保存")', 'canvas save');
        const target = path.join(workspace, 'installed-export.png');
        await rm(target, { force: true });
        await mainCdp.evaluate(`process.mainModule.require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(target)} })`);
        await click(cdp, '[data-canvas-export="png"]');
        await waitForFile(target);
        const bytes = await readFile(target);
        exported = pngSize(bytes);
        await writeFile(path.join(outputDirectory, 'installed-export.png'), bytes);
      }
      results.push({ scale, dpr, rendererReadyMs, readerOpenedMs, cardsReadyMs, controlsFitViewport: true, exported });
    } finally {
      mainCdp?.close();
      cdp?.close();
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  console.log(JSON.stringify({ status: 'passed', executable, scales, results }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
