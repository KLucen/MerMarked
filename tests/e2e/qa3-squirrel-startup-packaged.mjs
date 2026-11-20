import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './cdp-client.mjs';

// No installer or real updater is invoked. The actual packaged main process runs
// its Squirrel hook against a compiled stand-in Update.exe in a private layout.
// Use --fixture-check to compile and exercise only that stand-in, without Electron.
const mode = process.argv[2] ?? 'run';
assert.ok(['run', '--fixture-check'].includes(mode));
assert.equal(process.platform, 'win32', 'This packaged lifecycle diagnostic targets Windows');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executable = process.env.MERMARKD_QA_EXE ?? path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe');
assert.ok(path.isAbsolute(executable));
assert.equal(path.basename(executable), 'MerMarkd.exe', 'The locked hook uses the actual packaged executable name');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX ?? 'qa3-squirrel-startup';
assert.match(prefix, /^[a-zA-Z0-9._-]+$/);
const qa = path.join(root, 'out/qa'); await mkdir(qa, { recursive: true });
const reportPath = path.join(qa, `${prefix}${mode === '--fixture-check' ? '-fixture-check' : ''}.json`);
await assert.rejects(stat(reportPath), error => error.code === 'ENOENT', 'Preserve previous evidence');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-qa3-squirrel-'));
const packageDirectory = path.join(workspace, 'application', 'app-0.1.0');
const copiedExecutable = path.join(packageDirectory, 'MerMarkd.exe');
const helperPath = path.join(workspace, 'application', 'Update.exe');
const helperSource = path.join(root, 'tests/fixtures/qa3-squirrel-helper.cs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = value => path.resolve(value).toLowerCase();
const proof = async file => { const bytes = await readFile(file); return { path: file, bytes: bytes.length, sha256: digest(bytes) }; };
const result = { kind: 'QA3-packaged-squirrel-exit-order', mode, status: 'running', startedAt: new Date().toISOString(),
  workspace, executable, script: await proof(fileURLToPath(import.meta.url)), helperSource: await proof(helperSource), cases: [],
  boundary: 'Actual packaged hook with private copied application and compiled non-installing Update.exe stand-in. Does not run a real installer/updater/uninstaller or prove historical binary residue fixed. No user shortcut is created or removed.' };
let activeChild, activeMain, activeGate;

async function waitFor(probe, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await probe(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(`Timed out: ${label}`);
}
async function readOptional(file) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function receipt(file) {
  const text = await readOptional(file); if (!text) return null;
  try { return JSON.parse(text); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
}
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function releaseGate(gate) { await writeFile(path.join(gate, 'release'), 'release\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; }); }
async function stopOwned() {
  activeMain?.close(); activeMain = undefined;
  if (activeGate) {
    await releaseGate(activeGate).catch(() => undefined);
    // The stand-in has a 30-second self-timeout. Never kill a PID read from a
    // file: a receipt cannot authorize killing an unrelated/reused process.
    await waitFor(() => receipt(path.join(activeGate, 'helper-exiting.json')), 'stand-in release', 3000).catch(() => undefined);
    activeGate = undefined;
  }
  if (activeChild?.exitCode === null && activeChild?.signalCode === null) {
    try { execFileSync('taskkill.exe', ['/PID', String(activeChild.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
    catch { activeChild.kill('SIGKILL'); }
  }
  activeChild = undefined;
}
async function makeGate(name) {
  const gate = path.join(workspace, name); await mkdir(gate); const token = randomUUID().replaceAll('-', '');
  return { gate, token, env: { ...process.env, MERMARKD_QA_SQUIRREL_GATE: gate, MERMARKD_QA_SQUIRREL_TOKEN: token } };
}
async function snapshotShortcuts() {
  const appData = process.env.APPDATA;
  assert.ok(appData && path.isAbsolute(appData));
  const files = [path.join(os.homedir(), 'Desktop', 'MerMarkd.lnk'),
    path.join(appData, 'Microsoft/Windows/Start Menu/Programs/MerMarkd.lnk'),
    path.join(appData, 'Microsoft/Windows/Start Menu/Programs/MerMarkd/MerMarkd.lnk')];
  return Promise.all(files.map(async file => {
    try { return { ...(await proof(file)), mtimeMs: (await stat(file)).mtimeMs }; }
    catch (error) { if (error.code === 'ENOENT') return { path: file, missing: true }; throw error; }
  }));
}
async function compileHelper() {
  const compiler = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  result.compiler = await proof(compiler);
  await mkdir(path.dirname(helperPath), { recursive: true });
  try {
    result.compileOutput = execFileSync(compiler, ['/noconfig', '/nologo', '/target:winexe', '/platform:anycpu',
      `/reference:${path.join(path.dirname(compiler), 'System.dll')}`, `/out:${helperPath}`, helperSource],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch (error) {
    result.compileOutput = String(error.stdout ?? '') + String(error.stderr ?? '');
    throw error;
  }
  result.helper = await proof(helperPath);
}
async function checkHelper() {
  const item = await makeGate('helper-check'); activeGate = item.gate;
  const child = spawn(helperPath, ['--createShortcut=MerMarkd.exe'], { env: item.env, stdio: 'ignore', windowsHide: true });
  activeChild = child;
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  const started = await waitFor(() => receipt(path.join(item.gate, 'helper-start.json')), 'stand-in ready');
  assert.equal(started.token, item.token); assert.equal(normalize(started.helperPath), normalize(helperPath));
  assert.equal(started.pid, child.pid); assert.equal(started.argument, '--createShortcut=MerMarkd.exe');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(child.exitCode, null, 'stand-in remains blocked until explicitly released');
  assert.equal(await readOptional(path.join(item.gate, 'helper-exiting.json')), null);
  await releaseGate(item.gate); const exit = await exited; assert.deepEqual(exit, { code: 0, signal: null });
  const completed = await receipt(path.join(item.gate, 'helper-exiting.json')); assert.equal(completed.token, item.token);
  assert.deepEqual((await readdir(item.gate)).sort(), ['helper-exiting.json', 'helper-start.json', 'release']);
  result.helperCheck = { status: 'passed', started, completed, exit }; activeChild = undefined; activeGate = undefined;
}
async function hook(command, expectedArgument) {
  const record = { name: command, status: 'running', startedAt: new Date().toISOString() }; result.cases.push(record);
  const item = await makeGate(command.slice(2)); activeGate = item.gate;
  const profile = path.join(item.gate, 'profile'); await mkdir(profile);
  const port = await freePort(); const before = await snapshotShortcuts();
  try {
    const child = spawn(copiedExecutable, [command, `--inspect=127.0.0.1:${port}`, `--user-data-dir=${profile}`],
      { cwd: packageDirectory, env: item.env, stdio: 'ignore', windowsHide: true });
    activeChild = child; record.pid = child.pid; record.profile = profile; record.port = port;
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal, observedAt: new Date().toISOString() })); });
    record.helperStart = await waitFor(() => receipt(path.join(item.gate, 'helper-start.json')), 'actual hook spawned stand-in');
    assert.equal(record.helperStart.token, item.token); assert.equal(normalize(record.helperStart.helperPath), normalize(helperPath));
    assert.equal(record.helperStart.argument, expectedArgument);
    assert.equal(child.exitCode, null, 'application must remain alive while the shortcut helper is blocked');
    activeMain = await connectCdp(port, target => target.type === 'node');
    record.application = await activeMain.evaluate(`(()=>{const {app,BrowserWindow}=process.mainModule.require('electron');return {executable:process.execPath,argv:process.argv,userData:app.getPath('userData'),windowCount:BrowserWindow.getAllWindows().length}})()`);
    assert.equal(normalize(record.application.executable), normalize(copiedExecutable));
    assert.equal(record.application.argv[1], command); assert.equal(normalize(record.application.userData), normalize(profile));
    assert.equal(record.application.windowCount, 0, 'Squirrel hook does not initialize the product window');
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(child.exitCode, null, 'no premature quit during the held helper interval');
    assert.equal(await readOptional(path.join(item.gate, 'helper-exiting.json')), null);
    record.heldHelperObserved = true; record.releaseAt = new Date().toISOString();
    activeMain.close(); activeMain = undefined; await releaseGate(item.gate);
    record.exit = await bounded(exited, 10000, 'Hook did not quit after helper completion');
    assert.equal(record.exit.code, 0); assert.equal(record.exit.signal, null);
    record.helperExiting = await receipt(path.join(item.gate, 'helper-exiting.json')); assert.equal(record.helperExiting.token, item.token);
    assert.ok(Date.parse(record.helperExiting.exitingUtc) >= Date.parse(record.releaseAt));
    record.shortcutsUnchanged = true; assert.deepEqual(await snapshotShortcuts(), before);
    record.status = 'passed'; console.log(`passed: ${command}`);
  } catch (error) {
    record.status = 'failed'; record.error = error.stack ?? String(error);
    record.applicationAtFailure = activeChild ? { exitCode: activeChild.exitCode, signalCode: activeChild.signalCode } : null;
    console.log(`failed: ${command}: ${error.message}`);
  }
  finally { record.finishedAt = new Date().toISOString(); await stopOwned(); }
}

try {
  await compileHelper(); await checkHelper();
  if (mode === 'run') {
    result.selectedAsar = await proof(path.join(path.dirname(executable), 'resources/app.asar'));
    result.selectedExecutable = await proof(executable);
    await cp(path.dirname(executable), packageDirectory, { recursive: true, errorOnExist: true, force: false });
    result.copiedAsar = await proof(path.join(packageDirectory, 'resources/app.asar'));
    result.copiedExecutable = await proof(copiedExecutable);
    assert.equal(result.copiedAsar.sha256, result.selectedAsar.sha256);
    assert.equal(result.copiedExecutable.sha256, result.selectedExecutable.sha256);
    for (const command of ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall']) {
      await hook(command, `${command === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut'}=MerMarkd.exe`);
    }
    assert.deepEqual(await proof(path.join(path.dirname(executable), 'resources/app.asar')), result.selectedAsar);
    result.status = result.cases.length === 3 && result.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
  } else result.status = 'passed';
} catch (error) { result.status = 'failed'; result.error = error.stack ?? String(error); }
finally {
  await stopOwned(); result.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(result, null, 2), { flag: 'wx' });
  if (result.status === 'passed') {
    const actual = await realpath(workspace), temporary = await realpath(os.tmpdir());
    assert.ok(normalize(actual).startsWith(normalize(temporary) + path.sep) && path.basename(actual).startsWith('mermarkd-qa3-squirrel-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } else console.log(`Squirrel diagnostic fixtures retained: ${workspace}`);
}
assert.equal(result.status, 'passed', `See ${reportPath}`);
console.log(`Squirrel ${mode} passed: ${reportPath}`);
