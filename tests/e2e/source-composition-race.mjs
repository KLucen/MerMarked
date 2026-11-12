import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { connectCdp } from './cdp-client.mjs';
import { spawn } from './packaged-window.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'out/qa/source-composition-race');
const prefix = process.env.MERMARKD_QA_ARTIFACT_PREFIX || 'source-composition-race';
await mkdir(output, { recursive: true });
await build({ configFile: false, logLevel: 'error', build: { outDir: output, emptyOutDir: false,
  lib: { entry: 'tests/prototypes/source-composition-race.tsx', name: 'SourceCompositionRace', formats: ['iife'], fileName: () => 'race.js' } },
  esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"production"' } });
const html = path.join(output, 'index.html');
await writeFile(html, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><title>Source composition race regression</title><style>html,body,#root{height:100%;margin:0}.source-editor-surface{height:400px}</style><div id="root"></div><script src="race.js"></script>');
const workspace = await mkdtemp(path.join(os.tmpdir(), 'mermarkd-source-composition-race-'));
const port = 17600 + Math.floor(Math.random() * 100);
const results = []; const errors = [];
let child, main, page;
async function frames() { await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); }
async function reset() { await page.evaluate('sourceCompositionRace.reset()'); await frames(); }
async function state() { return page.evaluate('sourceCompositionRace.state()'); }
async function scenario(name, run) {
  try { await reset(); await run(); results.push({ name, status: 'passed', state: await state() }); }
  catch (error) { const diagnostic = await state().catch(() => null); errors.push(error); results.push({ name, status: 'failed', error: error.message, state: diagnostic }); }
}
try {
  child = await spawn(process.env.MERMARKD_QA_EXE || path.join(root, 'out/MerMarkd-win32-x64/MerMarkd.exe'), [
    `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${port + 200}`, `--user-data-dir=${workspace}`,
  ], { stdio: 'ignore' });
  main = await connectCdp(port + 200, target => target.type === 'node');
  await main.evaluate(`(async()=>{ const {BrowserWindow}=process.mainModule.require('electron');
    BrowserWindow.getAllWindows().forEach(window=>window.hide());
    const window=new BrowserWindow({width:1000,height:720,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false}});
    window.setAlwaysOnTop(true);await window.loadFile(${JSON.stringify(html)});window.show();window.focus(); })()`);
  page = await connectCdp(port, target => target.type === 'page' && target.url.includes('source-composition-race'));
  const baseline = await page.evaluate('sourceCompositionRace.baseline');
  await scenario('229 after end cannot publish the unfinished candidate', async () => {
    const during = await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('n');r.candidate('ni');r.compose('compositionend','你');r.key(229);const during=r.state();r.candidate('你');r.releaseMeasurements();return during;})()`);
    await frames();
    assert.deepEqual(during.publications, [], '229 must leave the pending composition unpublished');
    const committed = await state(); assert.deepEqual(committed.publications, [baseline + '你']); assert.equal(committed.past, 1); assert.equal(committed.activity, 0);
    await page.evaluate("sourceCompositionRace.key(90,false,'z',true)"); await frames(); assert.equal((await state()).text, baseline);
    await page.evaluate("sourceCompositionRace.key(89,false,'y',true)"); await frames(); assert.equal((await state()).text, baseline + '你');
  });
  await scenario('isComposing key after end cannot settle the candidate', async () => {
    const during = await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('ni');r.compose('compositionend','你');r.key(13,true,'Enter');const during=r.state();r.candidate('你');r.releaseMeasurements();return during;})()`);
    await frames(); assert.deepEqual(during.publications, [], 'isComposing must keep the candidate staged');
    assert.deepEqual((await state()).publications, [baseline + '你']);
  });
  await scenario('final update arriving in a later task forms one shared edit', async () => {
    const during = await page.evaluate(`(async()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('n');r.candidate('ni');r.compose('compositionend','你');await new Promise(resolve=>setTimeout(resolve,20));const during=r.state();r.candidate('你');r.releaseMeasurements();return during;})()`);
    await frames(); assert.deepEqual(during.publications, [], 'a zero-delay timer must not commit ni before the final update');
    const committed = await state(); assert.deepEqual(committed.publications, [baseline + '你']); assert.equal(committed.past, 1); assert.equal(committed.activity, 0);
  });
  await scenario('ordinary Ctrl+Z flushes pending DOM text before shared undo', async () => {
    const prevented = await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('ni');r.compose('compositionend','你');r.mutateDOM('你');const prevented=r.key(90,false,'z',true);r.releaseMeasurements();return prevented;})()`);
    await frames(); const undone = await state(); assert.equal(prevented, true, 'the source owner consumes Ctrl+Z');
    assert.equal(undone.text, baseline); assert.deepEqual(undone.publications, [baseline + '你']); assert.equal(undone.past, 0); assert.equal(undone.future, 1); assert.equal(undone.activity, 0);
    await page.evaluate("sourceCompositionRace.key(89,false,'y',true)"); await frames(); assert.equal((await state()).text, baseline + '你');
  });
  await scenario('cancelled composition has no shared history', async () => {
    await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('ni');r.candidate('');r.compose('compositionend');r.releaseMeasurements();})()`);
    await frames(); const cancelled = await state(); assert.deepEqual(cancelled.publications, []); assert.equal(cancelled.past, 0); assert.equal(cancelled.activity, 0);
  });
  await scenario('queued measured microtask cannot publish into a replacement document', async () => {
    await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('你');r.compose('compositionend','你');r.runMeasuredCallbacks();r.reset();})()`);
    await frames(); const replaced = await state(); assert.equal(replaced.text, baseline); assert.deepEqual(replaced.publications, []); assert.equal(replaced.activity, 0);
  });
  await scenario('an old measured completion cannot finish the next composition', async () => {
    const during = await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('你');r.compose('compositionend','你');r.runMeasuredCallbacks();r.compose('compositionstart');r.candidate('你好');return r.state();})()`);
    await frames(); assert.deepEqual(during.publications, [baseline + '你']); assert.equal((await state()).activity, 1);
    await page.evaluate("sourceCompositionRace.compose('compositionend','好')"); await frames();
    const committed = await state(); assert.deepEqual(committed.publications, [baseline + '你', baseline + '你好']); assert.equal(committed.activity, 0);
  });
  await reset();
  const destroyed = await page.evaluate(`(()=>{const r=sourceCompositionRace;r.holdMeasurements();r.compose('compositionstart');r.candidate('你');r.compose('compositionend','你');r.runMeasuredCallbacks();return r.unmount();})()`);
  await frames();
  assert.deepEqual(destroyed, { activity: 0, publications: [] }, 'destroy balances pending activity without publishing a candidate');
  results.push({ name: 'destroy cancels a queued completion and balances activity', status: 'passed', state: destroyed });
} catch (error) {
  errors.push(error);
  results.push({ name: 'regression setup or lifecycle', status: 'failed', error: error.message });
} finally {
  await writeFile(path.join(output, `${prefix}.json`), JSON.stringify({ status: errors.length ? 'failed' : 'passed',
    sourceSurface: await readFile(path.join(root, 'src/renderer/source-surface.tsx'), 'utf8'), results,
    boundary: 'Deterministic browser event/scheduler regression using real SourceSurface, MarkdownEditorView and history core; does not replace trusted Chromium or native IME acceptance.' }, null, 2));
  for (const result of results) console.log(`${result.status}: ${result.name}${result.error ? `: ${result.error}` : ''}`);
  page?.close(); main?.close();
  if (child) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { child.kill('SIGKILL'); } }
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
assert.equal(errors.length, 0, `${errors.length} composition race scenarios failed; see ${path.join(output, `${prefix}.json`)}`);
