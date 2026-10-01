import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = path.join(root, 'out', 'MerMarkd-win32-x64', 'MerMarkd.exe');

class Cdp {
  constructor(socket) { this.socket = socket; this.nextId = 1; this.pending = new Map(); socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data); if (!message.id) return; const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
  }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; }
  close() { this.socket.close(); }
}
async function endpoint(port, kind = 'page') { const deadline = Date.now() + 15000; while (Date.now() < deadline) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((item) => item.type === kind); if (page) return page; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out waiting for ${kind}.`); }
async function connect(page) { const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); const cdp = new Cdp(socket); await cdp.send('Runtime.enable'); return cdp; }
async function waitFor(cdp, expression, label) { const deadline = Date.now() + 15000; let last; while (Date.now() < deadline) { last = await cdp.evaluate(expression); if (last === true) return; await new Promise((resolve) => setTimeout(resolve, 60)); } const body = await cdp.evaluate('document.body.innerText.slice(0, 1200)'); throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}\n${body}`); }
async function click(cdp, selector) { assert.equal(await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement) || element.hasAttribute('disabled')) return false; element.click(); return true; })()`), true, `enabled element missing: ${selector}`); }
async function launch(userData) {
  const port = 12400 + Math.floor(Math.random() * 120); const inspectorPort = port + 400;
  const child = spawn(executable, [`--inspect=${inspectorPort}`, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: root, stdio: 'ignore' });
  const cdp = await connect(await endpoint(port)); const mainCdp = await connect(await endpoint(inspectorPort, 'node'));
  await waitFor(cdp, `document.readyState === 'complete'`, 'renderer');
  return { child, cdp, mainCdp };
}
function close(app) { app.cdp.close(); app.mainCdp.close(); try { execFileSync('taskkill.exe', ['/PID', String(app.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { app.child.kill('SIGKILL'); } }

const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-b1-shell-'));
const userData = path.join(workspace, 'user-data');
const existing = path.join(workspace, 'recent.md');
const created = path.join(workspace, 'new.md');
await writeFile(existing, '# B1 文档\n\n正文😀\n', 'utf8');
let app;
try {
  app = await launch(userData);
  const { cdp, mainCdp } = app;
  await waitFor(cdp, `Boolean(document.querySelector('[data-start-open]'))`, 'start page');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-start-new]')?.textContent.includes('新建文档') === true`), true);
  await mainCdp.evaluate(`process.mainModule.require('electron').dialog.showSaveDialog = async () => ({ canceled: false, filePath: ${JSON.stringify(created)} })`);
  await click(cdp, '[data-start-new]');
  await waitFor(cdp, `document.querySelector('.file-name')?.textContent === 'new.md'`, 'new document');
  assert.equal((await stat(created)).isFile(), true);
  assert.equal((await readFile(created, 'utf8')), '');
  await click(cdp, '[data-mode="editor"]');
  await waitFor(cdp, `Boolean(document.querySelector('[data-editor-textarea]'))`, 'new editor');
  await click(cdp, '[aria-label="展开左侧栏"]');
  await click(cdp, '[aria-label="收起左侧栏"]');
  await click(cdp, '[aria-label="展开右侧栏"]');
  await click(cdp, '[aria-label="收起右侧栏"]');
  await click(cdp, '[aria-label="进入专注模式"]');
  assert.equal(await cdp.evaluate(`document.querySelector('[data-focus-mode="true"]') !== null`), true);
  await click(cdp, '[aria-label="退出专注模式"]');
  close(app); app = null;

  app = await launch(userData);
  const { cdp: second, mainCdp: secondMain } = app;
  await waitFor(second, `document.querySelector('.start-recent-list strong')?.textContent === 'new.md'`, 'recent new document');
  await secondMain.evaluate(`process.mainModule.require('electron').dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(existing)}] })`);
  await click(second, '[data-start-open]');
  await waitFor(second, `document.querySelector('.file-name')?.textContent === 'recent.md'`, 'opened Markdown');
  await click(second, '[aria-label="展开左侧栏"]');
  await waitFor(second, `Boolean(document.querySelector('.workspace-sidebar-left'))`, 'left sidebar');
  assert.equal(await second.evaluate(`Boolean([...document.querySelectorAll('.recent-document-list strong')].find((item) => item.textContent === 'recent.md'))`), true);
  await click(second, '[aria-label="展开右侧栏"]');
  await waitFor(second, `Boolean(document.querySelector('.workspace-sidebar-right'))`, 'right sidebar');
  assert.equal(await second.evaluate(`document.querySelector('.document-info-list dd')?.textContent === 'recent.md'`), true);
  for (const [name, width, height] of [['wide', 1200, 800], ['narrow', 800, 700], ['mobile', 420, 800]]) {
    await second.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.equal(await second.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${name} horizontal overflow`);
    await mkdir(path.join(root, 'out', 'qa'), { recursive: true });
    const screenshot = await second.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(root, 'out', 'qa', `b1-shell-${name}.png`), Buffer.from(screenshot.data, 'base64'));
  }
  await second.send('Emulation.clearDeviceMetricsOverride');
  console.log(JSON.stringify({ status: 'passed', startPage: true, newMarkdown: true, recentDocuments: true, sidebars: true, focusMode: true, widths: [1200, 800, 420] }));
} finally {
  if (app) close(app);
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
